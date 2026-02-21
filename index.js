const fs = require('fs');
const path = require('path');
const os = require('os');
const InquiryStore = require('./lib/inquiry');
const extractor = require('./lib/extractor');
const reflect = require('./lib/reflect');
const writer = require('./lib/writer');

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source || {})) {
    const next = source[key];
    if (next && typeof next === 'object' && !Array.isArray(next)) {
      result[key] = deepMerge(result[key] || {}, next);
    } else {
      result[key] = next;
    }
  }
  return result;
}

function loadConfig(userConfig) {
  const defaults = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.default.json'), 'utf8'));
  return deepMerge(defaults, userConfig || {});
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Generate 2-3 topic tags for an inquiry via LLM.
 * Called asynchronously after inquiry creation — doesn't block the hook.
 */
async function tagInquiry(store, inquiry, config, logger) {
  if (!config.tagging?.enabled) return;

  const prompt = [
    'Given this question an AI agent is contemplating, generate 2-3 short topic tags (1-2 words each).',
    'Return ONLY a JSON array of lowercase strings, nothing else.',
    '',
    `Question: "${inquiry.question}"`,
    '',
    'Tags:'
  ].join('\n');

  try {
    const result = await reflect.callOllama({
      endpoint: config.llm?.endpoint || 'http://localhost:11434/api/generate',
      model: config.llm?.model,
      prompt,
      temperature: 0.3,
      maxTokens: 100,
      timeoutMs: config.llm?.timeoutMs ?? 15000
    });

    // Parse tags from LLM response — handle various formats
    const match = result.match(/\[.*\]/s);
    if (match) {
      const tags = JSON.parse(match[0]);
      if (Array.isArray(tags) && tags.every(t => typeof t === 'string')) {
        inquiry.tags = tags.map(t => t.toLowerCase().trim()).slice(0, 4);
        store.persist();
        if (logger) {
          logger.info(`[Contemplation] Tagged ${inquiry.id}: [${inquiry.tags.join(', ')}]`);
        }
      }
    }
  } catch (err) {
    if (logger) {
      logger.warn(`[Contemplation] Tag generation failed for ${inquiry.id}: ${err.message}`);
    }
  }
}

/**
 * Resolve output paths per-agent based on workspace.
 * Avoids hardcoding any single agent's workspace path in config.
 */
function resolveOutputPaths(agentId, workspacePath) {
  const workspace = workspacePath
    || path.join(os.homedir(), '.openclaw', agentId === 'main' ? 'workspace' : `workspace-${agentId}`);
  return {
    growthVectorsPath: path.join(workspace, 'memory', 'growth-vectors.json'),
    insightsPath: path.join(workspace, 'memory', 'insights')
  };
}

module.exports = {
  id: 'contemplation',
  name: 'Contemplation — Inquiry Passes',

  register(api) {
    const config = loadConfig(api.pluginConfig || {});
    if (!config.enabled) {
      api.logger.info('Contemplation plugin disabled via config');
      return;
    }

    const baseDataDir = path.join(__dirname, 'data');
    ensureDir(path.join(baseDataDir, 'agents'));

    const states = new Map();

    function getState(agentId) {
      const id = agentId || 'main';
      if (!states.has(id)) {
        states.set(id, {
          agentId: id,
          store: new InquiryStore(baseDataDir, id, config.passes),
          processing: false,
          workspacePath: null // set on first event with metadata
        });
        api.logger.info(`[Contemplation] Initialized state for agent "${id}"`);
      }
      return states.get(id);
    }

    /**
     * Get output paths for an agent, resolving workspace from state or event.
     */
    function getOutputPaths(state, event) {
      // Cache workspace path from event metadata
      if (event?.metadata?.workspace && !state.workspacePath) {
        state.workspacePath = event.metadata.workspace;
      }
      // Use config paths if explicitly set (backwards compat), otherwise resolve per-agent
      if (config.output?.growthVectorsPath && config.output?.insightsPath) {
        return config.output;
      }
      return resolveOutputPaths(state.agentId, state.workspacePath);
    }

    async function persistCompletedInsights(state, event) {
      const pending = state.store.getCompletedUnpersisted();
      if (pending.length === 0) return 0;

      const outputPaths = getOutputPaths(state, event);
      let wrote = 0;
      for (const inquiry of pending) {
        try {
          writer.appendGrowthVector(outputPaths.growthVectorsPath, inquiry);
          if (outputPaths.insightsPath) {
            writer.writeInsightFile(outputPaths.insightsPath, inquiry);
          }
          state.store.markPersisted(inquiry.id);
          wrote++;
          api.logger.info(
            `[Contemplation:${state.agentId}] Persisted inquiry ${inquiry.id} → ${outputPaths.growthVectorsPath}`
          );
        } catch (err) {
          api.logger.error(`[Contemplation:${state.agentId}] Failed writing inquiry ${inquiry.id}: ${err.message}`);
        }
      }

      return wrote;
    }

    async function runOneDuePass(state, ctx) {
      if (state.processing) return false;
      const due = state.store.getDuePass();
      if (!due) return false;

      state.processing = true;
      try {
        const output = await reflect.runPass({
          inquiry: due.inquiry,
          passNumber: due.passNumber,
          config
        });

        const updated = state.store.completePass(due.inquiry.id, due.passNumber, output);
        api.logger.info(`[Contemplation:${state.agentId}] Completed pass ${due.passNumber} for ${due.inquiry.id}`);

        if (updated?.status === 'completed') {
          await persistCompletedInsights(state);
        }

        // Queue another nightshift task in case more passes are due
        if (global.__ocNightshift?.queueTask) {
          global.__ocNightshift.queueTask(ctx.agentId, {
            type: 'contemplation',
            priority: config.nightshift?.priority || 50,
            source: 'contemplation'
          });
        }

        return true;
      } catch (err) {
        api.logger.error(`[Contemplation:${state.agentId}] Pass run failed: ${err.message}`);
        return false;
      } finally {
        state.processing = false;
      }
    }

    // -----------------------------------------------------------------
    // METABOLISM INTEGRATION: Subscribe to LLM-derived knowledge gaps
    // -----------------------------------------------------------------
    // The OpenClaw gateway gives each plugin its own scoped `api` object,
    // so api.metabolism doesn't cross plugin boundaries. Use the global
    // __ocMetabolism bus that the metabolism plugin sets up.
    //
    // Metabolism extracts implications from conversation via LLM, then
    // identifies "gaps" (questions, uncertainty markers). These are
    // higher quality than regex extraction from raw conversation because
    // the LLM has already reasoned about the exchange.

    if (global.__ocMetabolism?.gapListeners) {
      global.__ocMetabolism.gapListeners.push((gaps, agentId) => {
        const state = getState(agentId);
        for (const gap of gaps) {
          const inquiry = state.store.addInquiry({
            question: gap.question,
            source: `metabolism:${gap.sourceId || 'unknown'}`,
            entropy: 0, // already filtered by metabolism thresholds
            context: gap.question // the implication IS the context
          });
          api.logger.info(
            `[Contemplation:${agentId}] Queued inquiry from metabolism: ${inquiry.id} — "${gap.question.substring(0, 80)}"`
          );
          // Tag asynchronously — don't block the gap listener
          tagInquiry(state.store, inquiry, config, api.logger).catch(() => {});
        }
      });
      api.logger.info('[Contemplation] Subscribed to metabolism gap events via global bus');
    }

    // Nightshift task runner — also uses global since api.nightshift is scoped
    if (global.__ocNightshift?.registerTaskRunner) {
      global.__ocNightshift.registerTaskRunner('contemplation', async (task, ctx) => {
        const state = getState(ctx.agentId);
        await runOneDuePass(state, ctx);
      });
      api.logger.info('[Contemplation] Registered nightshift task runner for "contemplation"');
    }

    // -----------------------------------------------------------------
    // HOOK: before_agent_start — Surface active/completed contemplations
    // -----------------------------------------------------------------
    // Inject contemplation state so the agent knows what it's been
    // thinking about and can reference completed insights naturally.
    // Priority 7: between stability (5) and continuity (10).

    api.on('before_agent_start', async (event, ctx) => {
      const state = getState(ctx.agentId);
      const inquiries = state.store.list();

      // Gather active (in_progress) inquiries
      const active = inquiries.filter(i => i.status === 'in_progress');

      // Gather recently completed inquiries (last 7 days)
      const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
      const recentCompleted = inquiries.filter(i =>
        i.status === 'completed' && i.completed && Date.parse(i.completed) > sevenDaysAgo
      );

      // Nothing to inject
      if (active.length === 0 && recentCompleted.length === 0) return {};

      const lines = ['[CONTEMPLATION STATE]'];

      if (active.length > 0) {
        lines.push(`Active inquiries: ${active.length}`);
        for (const inq of active.slice(0, 3)) { // cap at 3 to stay concise
          const completedPasses = inq.passes.filter(p => p.completed).length;
          const totalPasses = inq.passes.length;
          const passLabels = ['initial', 'settling', 'synthesis'];
          const currentLabel = passLabels[completedPasses] || `pass ${completedPasses + 1}`;
          lines.push(`- "${inq.question.substring(0, 120)}" (pass ${completedPasses + 1} of ${totalPasses} — ${currentLabel})`);
        }
      }

      if (recentCompleted.length > 0) {
        lines.push('');
        lines.push(`Recent insights (last 7 days): ${recentCompleted.length}`);
        for (const inq of recentCompleted.slice(0, 3)) { // cap at 3
          const pass3 = inq.passes.find(p => p.number === 3);
          const insight = (pass3?.output || '').substring(0, 200);
          lines.push(`- Q: "${inq.question.substring(0, 100)}"`);
          if (insight) {
            lines.push(`  Insight: "${insight}"`);
          }
        }
      }

      return { prependContext: lines.join('\n') };
    }, { priority: 7 });

    // -----------------------------------------------------------------
    // HOOK: agent_end — SECONDARY gap extraction from raw conversation
    // -----------------------------------------------------------------
    // This catches explicit wonder/curiosity in conversation that might
    // not trigger metabolism (e.g., low-entropy exchanges). Complementary
    // to the metabolism-derived gaps above.

    api.on('agent_end', async (event, ctx) => {
      // Skip heartbeat-originated turns — only extract gaps from real conversation
      if (event.metadata?.isHeartbeat) return;

      // Skip document/file processing exchanges — these aren't conversation
      // PDF content, ebook processing, etc. generate noise (rhetorical questions,
      // marketing copy) that the extractor would misclassify as knowledge gaps.
      const messages = event.messages || [];
      const firstUserMsg = messages.find(m => m.role === 'user');
      const userText = typeof firstUserMsg?.content === 'string' ? firstUserMsg.content :
        Array.isArray(firstUserMsg?.content) ? firstUserMsg.content.map(p => p?.text || '').join(' ') : '';
      if (/(?:\.pdf|\.docx?|\.txt|\.epub|\.md)\b/i.test(userText) &&
          userText.length > 2000) {
        api.logger.debug(`[Contemplation:${ctx.agentId}] Skipping document processing exchange`);
        return;
      }

      const state = getState(ctx.agentId);

      // Cache workspace path from event metadata
      if (event.metadata?.workspace) {
        state.workspacePath = event.metadata.workspace;
      }

      let entropy = 0;
      if (api.stability?.getEntropy) {
        entropy = api.stability.getEntropy(ctx.agentId) || 0;
      }

      const source = event.metadata?.exchangeId || event.metadata?.sessionId || `exchange_${Date.now()}`;
      const gaps = extractor.identifyGaps({
        messages,
        entropy,
        extractionConfig: config.extraction,
        source
      });

      if (gaps.length === 0) return;

      for (const gap of gaps) {
        const inquiry = state.store.addInquiry(gap);
        api.logger.info(`[Contemplation:${state.agentId}] Queued inquiry ${inquiry.id} (from conversation)`);
        // Tag asynchronously — don't block the hook
        tagInquiry(state.store, inquiry, config, api.logger).catch(() => {});
      }

      if (global.__ocNightshift?.queueTask) {
        global.__ocNightshift.queueTask(ctx.agentId, {
          type: 'contemplation',
          priority: config.nightshift?.priority || 50,
          source: 'contemplation'
        });
      }
    });

    // -----------------------------------------------------------------
    // HOOK: heartbeat — Run due passes during office hours
    // -----------------------------------------------------------------

    api.on('heartbeat', async (event, ctx) => {
      const state = getState(ctx.agentId);

      if (global.__ocNightshift?.isInOfficeHours && !global.__ocNightshift.isInOfficeHours(ctx.agentId)) {
        return;
      }

      if (global.__ocNightshift?.isUserActive && global.__ocNightshift.isUserActive(ctx.agentId)) {
        return;
      }

      await runOneDuePass(state, ctx);
      await persistCompletedInsights(state, event);
    });

    // -----------------------------------------------------------------
    // HOOK: session_end — Persist any completed insights
    // -----------------------------------------------------------------

    api.on('session_end', async (event, ctx) => {
      const state = getState(ctx.agentId);
      const wrote = await persistCompletedInsights(state, event);
      if (wrote > 0) {
        api.logger.info(`[Contemplation:${state.agentId}] Persisted ${wrote} completed inquiries on session_end`);
      }
    });

    // -----------------------------------------------------------------
    // Gateway methods: monitoring & debugging
    // -----------------------------------------------------------------

    api.registerGatewayMethod('contemplation.getState', async ({ params, respond }) => {
      const state = getState(params?.agentId);
      const inquiries = state.store.list();
      respond(true, {
        agentId: state.agentId,
        active: inquiries.filter(i => i.status === 'in_progress').length,
        completed: inquiries.filter(i => i.status === 'completed').length,
        total: inquiries.length,
        inquiries: inquiries.map(i => ({
          id: i.id,
          question: i.question,
          status: i.status,
          source: i.source,
          tags: i.tags || [],
          entropy: i.entropy,
          context: i.context,
          created: i.created,
          completed: i.completed || null,
          passes: i.passes.map(p => ({
            number: p.number,
            scheduled: p.scheduled,
            completed: p.completed,
            output: p.output
          }))
        }))
      });
    });

    api.logger.info('Contemplation plugin registered — metabolism integration + context injection active');
  }
};
