# openclaw-plugin-contemplation

**Self-directed contemplative inquiry -- questions that need time.**

This plugin gives an OpenClaw agent the ability to think about things over time, not just respond in the moment. When a conversation surfaces something genuinely uncertain or unknown, the plugin captures it as a question and processes it across three reflection passes spread over 24 hours. The result is a growth vector -- a concise insight with practical implications that feeds back into the agent's context.

## What This Actually Does

Agents are reactive. They answer questions, but they don't generate their own. They respond to uncertainty in real-time, which means every answer is the first thing the model thinks of -- there's no sleeping on it, no revisiting with fresh perspective, no "I've been thinking about what you said."

This plugin solves that by introducing a simple loop: identify a question worth thinking about, then revisit it three times at increasing intervals. Each pass builds on the previous one. The first pass clarifies what's unknown. The second connects it to prior patterns. The third distills everything into something actionable. By the time the third pass runs (~24 hours later), the agent has something it couldn't have produced in a single turn.

## How It Works

The plugin uses a three-pass model. When a question is identified, it gets scheduled for three rounds of LLM-based reflection:

### Pass 1 -- Initial Exploration (immediate)

Runs as soon as the question is captured. Clarifies what is unknown and why it matters. This is the "what exactly am I asking here?" step -- turning a vague gap into a focused inquiry.

### Pass 2 -- Deeper Reflection (4 hours later)

Takes the output of Pass 1 and connects the inquiry to prior patterns and constraints. This is where the model has context from the first exploration and can identify relationships it missed initially.

### Pass 3 -- Final Synthesis (20 hours later)

Takes the outputs of both previous passes and produces a concise growth vector with practical implications. This is the deliverable -- a distilled insight that gets persisted to the agent's memory.

Each pass feeds the full output of all previous passes as context, so the reflection genuinely builds on itself rather than starting fresh. Timing is configurable via `delayMs` in the passes config -- the defaults (0ms, 4h, 20h) spread the process across roughly 24 hours, but you can compress or extend this to fit your use case.

Passes run during heartbeat cycles when the user isn't active, or via the nightshift scheduler during off-hours. They never interrupt active conversation.

## Where Questions Come From

The plugin has two complementary sources for identifying questions worth contemplating:

### Metabolism-derived gaps (deep)

When the metabolism plugin processes a conversation, it uses an LLM to extract implications and identify knowledge gaps. These gaps have already been through a round of reasoning -- the model has thought about the exchange and identified what's genuinely uncertain or unresolved. The contemplation plugin subscribes to these via a global event bus (`__ocMetabolism.gapListeners`), so metabolism-derived questions flow in automatically.

These tend to be higher quality because the LLM has already filtered for significance. A conversation about debugging a memory leak might produce a metabolism gap like "What are the implications of SQLite WAL mode for concurrent write patterns in long-running processes?" -- something the agent encountered but didn't resolve.

### Conversation extractor (shallow)

The plugin also runs regex-based extraction on raw conversation text at the end of each exchange. It catches explicit wonder and curiosity phrases:

- "I wonder..." / "I'm curious about..."
- "I don't understand..." / "I need to learn..."
- "How does..." / "Why would..." (and other question forms)

The extractor strips injected context blocks from other plugins before analysis, so it's looking at actual conversation, not metadata. It also filters out conversational questions directed at the user ("would you like...", "should I...") -- those aren't knowledge gaps, they're interaction patterns.

Both sources are complementary. Metabolism provides depth and catches gaps that aren't stated explicitly. The extractor catches surface-level curiosity that might not trigger metabolism thresholds (e.g., low-entropy exchanges where someone casually wonders about something).

Extraction is gated by entropy threshold (default 0.5) and keyword matching, so quiet, routine conversations don't generate spurious inquiries.

## Topic Tagging

Each inquiry gets 2-3 LLM-generated topic tags when it's created. Tags are short (1-2 words each), lowercase, and generated asynchronously so they don't block the hook that captured the question.

For example, an inquiry about SQLite WAL mode might get tagged `["sqlite", "concurrency", "file-io"]`.

Tags are included in the `contemplation.getState` gateway response, making them useful for dashboard browsing and filtering. You can disable tagging entirely via config:

```json
{
  "tagging": {
    "enabled": false
  }
}
```

## Context Injection

Before each agent turn, the plugin injects a `[CONTEMPLATION STATE]` block into the prompt via the `before_agent_start` hook. This block shows:

- **Active inquiries** (up to 3): The question text and current pass progress (e.g., "pass 2 of 3 -- settling")
- **Recent insights** (last 7 days, up to 3): Completed inquiries with their final synthesis output

This gives the agent awareness of what it's been thinking about. It can reference active inquiries naturally ("I've been considering that question about WAL mode...") and draw on recent insights when they're relevant to the current conversation.

The hook runs at priority 7, which places it between stability (priority 5) and continuity (priority 10) in the injection order.

## Installation

```bash
git clone https://github.com/CoderofTheWest/openclaw-plugin-contemplation.git
cd openclaw-plugin-contemplation
npm install
```

Add the plugin to your `openclaw.json`:

```json
{
  "plugins": {
    "load": {
      "paths": [
        "/path/to/openclaw-plugin-contemplation"
      ]
    },
    "entries": {
      "contemplation": {
        "enabled": true,
        "config": {}
      }
    }
  }
}
```

Then restart your OpenClaw gateway.

## Configuration Reference

All configuration is optional. The plugin ships with sensible defaults in `config.default.json`.

### Passes

| Setting | Default | What It Does |
|---|---|---|
| `passes.1.delayMs` | 0 | Delay before Pass 1 runs (immediate by default) |
| `passes.1.prompt` | "Initial exploration..." | LLM instruction for Pass 1 |
| `passes.2.delayMs` | 14400000 (4h) | Delay after Pass 1 completes before Pass 2 |
| `passes.2.prompt` | "Deeper reflection..." | LLM instruction for Pass 2 |
| `passes.3.delayMs` | 72000000 (20h) | Delay after Pass 2 completes before Pass 3 |
| `passes.3.prompt` | "Final synthesis..." | LLM instruction for Pass 3 |

### Extraction

| Setting | Default | What It Does |
|---|---|---|
| `extraction.entropyThreshold` | 0.5 | Minimum entropy to trigger gap extraction from conversation |
| `extraction.keywords` | `["wonder", "curious", ...]` | Keywords that bypass the entropy threshold |
| `extraction.maxGapsPerExchange` | 2 | Max questions extracted per conversation turn |

### LLM

| Setting | Default | What It Does |
|---|---|---|
| `llm.endpoint` | `http://localhost:11434/api/generate` | Ollama API endpoint |
| `llm.model` | `deepseek-v3.1:671b-cloud` | Model used for reflection passes and tagging |
| `llm.temperature` | 0.6 | Temperature for reflection passes |
| `llm.maxTokens` | 700 | Max tokens per reflection pass output |
| `llm.timeoutMs` | 45000 | Request timeout in milliseconds |

### Nightshift

| Setting | Default | What It Does |
|---|---|---|
| `nightshift.priority` | 50 | Priority when queuing tasks to the nightshift scheduler |

### Tagging

| Setting | Default | What It Does |
|---|---|---|
| `tagging.enabled` | true | Generate LLM-based topic tags for each inquiry |

### Output

| Setting | Default | What It Does |
|---|---|---|
| `output.growthVectorsPath` | *(auto-resolved per agent)* | Override path for growth-vectors.json |
| `output.insightsPath` | *(auto-resolved per agent)* | Override path for individual insight JSON files |

Output paths are resolved automatically from the agent's workspace metadata. You only need to set these if you want to override the default location (`~/.openclaw/workspace/memory/`).

## Gateway Methods

### `contemplation.getState`

Returns the full contemplation state for an agent. Accepts optional `agentId` parameter (defaults to `"main"`).

Response includes:
- `active` / `completed` / `total` counts
- Full inquiry list with question text, status, source, entropy, context, timestamps
- Pass details including scheduled time, completion time, and full output text
- Topic tags for each inquiry

This is the primary method for dashboard integration. The full pass outputs and tags give you everything needed to render inquiry timelines and browseable topic views.

## Architecture

```
index.js                 Main plugin -- hook registration, metabolism integration, tagging
lib/
  inquiry.js             InquiryStore -- JSON-backed inquiry persistence, pass scheduling
  reflect.js             LLM calls -- prompt construction, Ollama API, pass execution
  extractor.js           Gap detection -- regex patterns, context stripping, question extraction
  writer.js              Growth vector output -- appends to growth-vectors.json, writes insight files
```

### Hooks registered

| Hook | Priority | Purpose |
|------|----------|---------|
| `before_agent_start` | 7 | Inject `[CONTEMPLATION STATE]` with active inquiries and recent insights |
| `agent_end` | -- | Extract knowledge gaps from conversation via regex |
| `heartbeat` | -- | Run due reflection passes during idle periods |
| `session_end` | -- | Persist completed inquiries to growth vectors |

### Data storage

| Data | Location | Format |
|------|----------|--------|
| Inquiry state | `data/agents/{agentId}/inquiries.json` | JSON with passes, tags, status |
| Growth vectors | Agent workspace `memory/growth-vectors.json` | Appended on completion |
| Individual insights | Agent workspace `memory/insights/{id}.json` | One file per completed inquiry |

## Part of the Meta-Cognitive Suite

This plugin is one of six that form a complete meta-cognitive layer for OpenClaw agents. Each handles a distinct aspect of agent self-awareness:

1. **[openclaw-plugin-stability](https://github.com/CoderofTheWest/openclaw-plugin-stability)** -- Entropy monitoring, drift detection, loop guards
2. **[openclaw-plugin-continuity](https://github.com/CoderofTheWest/openclaw-plugin-continuity)** -- Cross-session memory, semantic search, topic tracking
3. **[openclaw-plugin-metabolism](https://github.com/CoderofTheWest/openclaw-plugin-metabolism)** -- Autonomous learning from high-entropy conversations
4. **[openclaw-plugin-nightshift](https://github.com/CoderofTheWest/openclaw-plugin-nightshift)** -- Off-hours task scheduling for heavy LLM work
5. **[openclaw-plugin-contemplation](https://github.com/CoderofTheWest/openclaw-plugin-contemplation)** -- Self-directed inquiry over time *(this plugin)*
6. **[openclaw-plugin-crystallization](https://github.com/CoderofTheWest/openclaw-plugin-crystallization)** -- Converts growth vectors into permanent traits

They work independently but integrate through shared conventions: global event buses for cross-plugin communication, growth vectors as a common output format, and nightshift as the shared scheduler for background processing.

## License

MIT
