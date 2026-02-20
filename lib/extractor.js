/**
 * Contemplation gap extractor.
 *
 * Identifies knowledge gaps from conversation exchanges, modeled on
 * Clint Prime's extractKnowledgeGaps() from identityIntegrationCodeAligned.js.
 *
 * Key differences from the Codex-authored version:
 * 1. Strips injected context blocks ([CONTINUITY CONTEXT], [STABILITY CONTEXT])
 *    before analyzing — those are plugin metadata, not conversation.
 * 2. Looks at BOTH user and agent messages for gap signals.
 * 3. Extracts actual questions and wonder-phrases rather than wrapping
 *    arbitrary sentence fragments in "What is unresolved in:".
 * 4. Uses the original gap patterns: wonder, curiosity, uncertainty, questions.
 */

// Patterns that indicate genuine knowledge gaps (from Clint Prime)
const GAP_PATTERNS = [
    /I wonder\s+(.{15,}?)(?:\.|$)/gi,
    /I'm curious\s+(?:about\s+)?(.{15,}?)(?:\.|$)/gi,
    /I don't (?:fully )?understand\s+(.{15,}?)(?:\.|$)/gi,
    /I (?:need|want) to (?:learn|know|explore|understand)\s+(.{15,}?)(?:\.|$)/gi,
    /I'm not sure (?:about |whether |if |how |why )(.{15,}?)(?:\.|$)/gi,
    /(?:how|why|what|when|where) (?:does|do|did|is|are|was|were|would|could|should|can|might) .{10,}\?/gi,
];

// Patterns to filter OUT — conversational questions directed at the user, not knowledge gaps
const FILTER_PATTERNS = [
    /^(?:would you|do you|can you|should I|shall I|could I|want me to|let me)/i,
    /^(?:is that|does that|are you|how about|what if I)/i,
    /^(?:ready|okay|alright|sure|got it|understood)/i,
];

// Context block headers injected by other plugins — strip these before analysis
const CONTEXT_BLOCK_PATTERN = /\[(?:CONTINUITY CONTEXT|STABILITY CONTEXT|GROWTH VECTORS|MEMORY INTEGRATION)\][\s\S]*?(?=\[(?:CONTINUITY|STABILITY|GROWTH|MEMORY)|$)/gi;

// Timestamp prefixes from OpenClaw message injection
const TIMESTAMP_PREFIX = /^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{4}-\d{2}-\d{2} \d{2}:\d{2} [A-Z]+\]\s*/;

function normalizeText(msg) {
    if (!msg) return '';
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
        return msg.content.map(part => part?.text || part?.content || '').join(' ');
    }
    return String(msg.content || '');
}

/**
 * Strip injected context blocks from message text.
 * These are plugin metadata (continuity recall, stability entropy, etc.)
 * and should NOT be treated as conversation content.
 */
function stripContextBlocks(text) {
    let cleaned = text.replace(CONTEXT_BLOCK_PATTERN, '');
    cleaned = cleaned.replace(TIMESTAMP_PREFIX, '');
    // Also strip lines that start with common injection markers
    cleaned = cleaned.split('\n')
        .filter(line => {
            const trimmed = line.trim();
            return !trimmed.startsWith('Entropy:') &&
                   !trimmed.startsWith('Principles:') &&
                   !trimmed.startsWith('Session:') &&
                   !trimmed.startsWith('Topics:') &&
                   !trimmed.startsWith('Speak from this memory') &&
                   !trimmed.startsWith('- They told you:') &&
                   !trimmed.startsWith('  You said:') &&
                   !trimmed.startsWith('You remember these earlier');
        })
        .join('\n')
        .trim();
    return cleaned;
}

/**
 * Extract genuine knowledge gaps from conversation text.
 * Based on Clint Prime's extractKnowledgeGaps() pattern.
 */
function extractGapsFromText(text, maxCount) {
    const gaps = [];
    const seen = new Set();

    // Pass 1: Match explicit gap patterns
    for (const pattern of GAP_PATTERNS) {
        // Reset regex state
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(text)) !== null) {
            const gap = match[0].trim();
            if (gap.length < 15) continue;

            // Filter conversational questions
            if (FILTER_PATTERNS.some(f => f.test(gap))) continue;

            const normalized = gap.toLowerCase().replace(/\s+/g, ' ');
            if (seen.has(normalized)) continue;
            seen.add(normalized);

            gaps.push(gap);
            if (gaps.length >= maxCount) return gaps;
        }
    }

    // Pass 2: Look for standalone questions (sentences ending with ?)
    const sentences = text.split(/(?<=[.!?])\s+/);
    for (const sentence of sentences) {
        const trimmed = sentence.trim();
        if (!trimmed.endsWith('?')) continue;
        if (trimmed.length < 20) continue;

        // Filter conversational questions
        if (FILTER_PATTERNS.some(f => f.test(trimmed))) continue;

        const normalized = trimmed.toLowerCase().replace(/\s+/g, ' ');
        if (seen.has(normalized)) continue;
        seen.add(normalized);

        gaps.push(trimmed);
        if (gaps.length >= maxCount) return gaps;
    }

    return gaps;
}

/**
 * Main entry point — identify knowledge gaps from a conversation exchange.
 *
 * Looks at both user and agent messages (the last few exchanges),
 * strips injected context, and extracts genuine questions/gaps.
 */
function identifyGaps({ messages, entropy = 0, extractionConfig = {}, source }) {
    const entropyThreshold = extractionConfig.entropyThreshold ?? 0.5;
    const keywords = extractionConfig.keywords || [];
    const maxGaps = extractionConfig.maxGapsPerExchange || 2;

    // Build conversation text from the last few exchanges (not the whole session)
    // Only look at the last 6 messages (3 exchanges) for gap detection
    const recentMessages = (messages || []).slice(-6);

    // Collect text from both user and agent messages
    const conversationParts = [];
    for (const msg of recentMessages) {
        const text = normalizeText(msg);
        if (!text) continue;

        // Strip injected context blocks before analysis
        const cleaned = stripContextBlocks(text);
        if (cleaned.length > 10) {
            conversationParts.push(cleaned);
        }
    }

    const conversationText = conversationParts.join('\n\n');
    if (!conversationText) return [];

    // Check entropy/keyword thresholds
    const lowered = conversationText.toLowerCase();
    const keywordHit = keywords.some(k => lowered.includes(String(k).toLowerCase()));

    if (entropy < entropyThreshold && !keywordHit) return [];

    // Extract gaps
    const questions = extractGapsFromText(conversationText, maxGaps);

    return questions.map((question, idx) => ({
        id: `gap_${Date.now()}_${idx}`,
        question,
        source: source || `exchange_${new Date().toISOString()}`,
        // Store cleaned conversation as context for the contemplation passes
        context: conversationText.slice(0, 1200),
        entropy
    }));
}

module.exports = {
    identifyGaps,
    normalizeText,
    stripContextBlocks,
    extractGapsFromText
};
