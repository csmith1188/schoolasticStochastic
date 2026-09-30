const SCSC_TAG = '[ScSc]';
const NEXT_BUTTON = 'Submit Next Word';
const END_BUTTON = 'End Response';
const END_RESPONSE_THRESHOLD = 0.8;

/**
 * Normalize a word for counting: lowercase, strip whitespace.
 * Digits are kept (including digit-only answers and decimals like 3.14).
 * Letter answers also drop surrounding punctuation for matching.
 * Punctuation / special-character-only answers are kept as-is so "!" tallies.
 */
function normalizeWord(word) {
    const compact = String(word || '').replace(/[\s\u00A0]+/g, '');
    if (!compact) return '';

    // Pure numeric tokens: "7", "42", "3.14", "1,000"
    if (/^[0-9]+([.,][0-9]+)*$/.test(compact)) {
        return compact;
    }

    const alphanumeric = compact
        .toLowerCase()
        .replace(/[^\p{L}\p{N}'’-]/gu, '');

    // e.g. "!", "??", "..." — keep the special character(s) as the tallied word
    if (!alphanumeric) return compact;

    return alphanumeric;
}

/**
 * Take the first whitespace-separated token from a text response.
 */
function firstWord(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return '';
    const match = trimmed.match(/^\S+/);
    return match ? match[0] : '';
}

/**
 * Pick the most common first word from student text responses.
 * Returns { word, normalized, count, tallies } or null.
 */
function pickMostCommonFirstWord(textResponses) {
    const tallies = new Map();

    for (const item of textResponses || []) {
        const response = typeof item === 'string' ? item : (item && item.response);
        const raw = firstWord(response);
        if (!raw) continue;

        const key = normalizeWord(raw);
        if (!key) continue;

        let entry = tallies.get(key);
        if (!entry) {
            entry = { normalized: key, count: 0, forms: new Map() };
            tallies.set(key, entry);
        }
        entry.count += 1;
        entry.forms.set(raw, (entry.forms.get(raw) || 0) + 1);
    }

    if (tallies.size === 0) return null;

    let best = null;
    for (const entry of tallies.values()) {
        if (!best || entry.count > best.count) {
            best = entry;
        }
    }

    let displayWord = best.normalized;
    let bestFormCount = 0;
    for (const [form, count] of best.forms.entries()) {
        if (count > bestFormCount) {
            bestFormCount = count;
            displayWord = form.replace(/[^\p{L}\p{N}.,'’-]+$/gu, '').replace(/^[^\p{L}\p{N}.,'’]+/gu, '') || form;
        }
    }

    const tallyList = [...tallies.values()]
        .map((entry) => {
            let form = entry.normalized;
            let formCount = 0;
            for (const [f, c] of entry.forms.entries()) {
                if (c > formCount) {
                    formCount = c;
                    form = f;
                }
            }
            return { word: form, normalized: entry.normalized, count: entry.count };
        })
        .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));

    return {
        word: displayWord,
        normalized: best.normalized,
        count: best.count,
        tallies: tallyList
    };
}

function stripScScTag(prompt) {
    return String(prompt || '').replace(/^\[ScSc\]\s*/i, '').trim();
}

function hasScScTag(prompt) {
    return /^\[ScSc\]/i.test(String(prompt || '').trim());
}

/**
 * Build the initial poll prompt from teacher input.
 * In scsc mode, ensure the [ScSc] tag is present.
 */
function buildSeedPrompt(prompt, mode) {
    const raw = String(prompt || '').trim();
    if (!raw) return '';
    if (mode === 'scsc' && !hasScScTag(raw)) {
        return `${SCSC_TAG} ${raw}`;
    }
    return raw;
}

/**
 * Append the winning word to the current poll prompt.
 * Preserves or adds [ScSc] when mode is scsc or the current prompt already has it.
 */
function buildNextPrompt(currentPrompt, word, mode) {
    const keepTag = mode === 'scsc' || hasScScTag(currentPrompt);
    const body = stripScScTag(currentPrompt);
    const nextBody = body ? `${body} ${word}` : String(word || '').trim();
    if (keepTag) return `${SCSC_TAG} ${nextBody}`.trim();
    return nextBody;
}

function nextPollPayload(prompt) {
    return {
        prompt,
        answers: [
            {
                answer: NEXT_BUTTON,
                weight: 1,
                color: '#00ff00',
                correct: false
            },
            {
                answer: END_BUTTON,
                weight: 1,
                color: '#ff0000',
                correct: false
            }
        ],
        blind: false,
        weight: 1,
        tags: [],
        excludedRespondents: [],
        indeterminate: [],
        allowVoteChanges: true,
        allowTextResponses: true,
        allowMultipleResponses: false
    };
}

/**
 * Count button votes for End Response among students who responded.
 * Returns { responded, endVotes, ratio }. Words are never filtered here —
 * callers still tally text from everyone who submitted text.
 */
function endResponseVoteStats(students) {
    let responded = 0;
    let endVotes = 0;

    for (const student of Object.values(students || {})) {
        const pollRes = student && student.pollRes;
        if (!pollRes || typeof pollRes !== 'object') continue;

        const button = typeof pollRes.buttonRes === 'string' ? pollRes.buttonRes.trim() : '';
        const textCandidates = [pollRes.textRes, pollRes.text, pollRes.textResponse];
        const hasText = textCandidates.some(
            (value) => typeof value === 'string' && value.trim() !== ''
        );

        if (!button && !hasText) continue;

        responded += 1;
        if (/^end response$/i.test(button)) {
            endVotes += 1;
        }
    }

    return {
        responded,
        endVotes,
        ratio: responded > 0 ? endVotes / responded : 0
    };
}

function shouldEndLoopFromVotes(students) {
    const stats = endResponseVoteStats(students);
    return stats.responded > 0 && stats.ratio > END_RESPONSE_THRESHOLD;
}

module.exports = {
    SCSC_TAG,
    NEXT_BUTTON,
    END_BUTTON,
    END_RESPONSE_THRESHOLD,
    normalizeWord,
    firstWord,
    pickMostCommonFirstWord,
    stripScScTag,
    hasScScTag,
    buildSeedPrompt,
    buildNextPrompt,
    nextPollPayload,
    endResponseVoteStats,
    shouldEndLoopFromVotes
};
