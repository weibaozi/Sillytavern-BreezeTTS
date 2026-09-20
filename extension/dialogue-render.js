import { DEFAULT_VOCAL_EVENTS, parseVocalEvents } from './prompt.js';

const quotePairs = new Map([['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』'], ['"', '"']]);

function knownEvents(vocalEvents) {
    // The original four remain recognizable when reading older chat messages.
    return new Set(parseVocalEvents(`${DEFAULT_VOCAL_EVENTS}\n${typeof vocalEvents === 'string' ? vocalEvents : ''}`).events);
}

/** Return plain display text. The caller must insert it with textContent. */
export function displayDialogue(text, vocalEvents) {
    const source = String(text ?? ''), events = knownEvents(vocalEvents);
    let result = '';
    for (let start = 0; start < source.length;) {
        if (source[start] !== '[') { result += source[start++]; continue; }
        let depth = 1, end = start + 1;
        while (end < source.length && depth) {
            if (source[end] === '[') depth++;
            else if (source[end] === ']') depth--;
            end++;
        }
        const token = source.slice(start, end);
        // Unknown and nested bracket groups may be ordinary dialogue: keep them intact.
        if (depth || !events.has(token)) result += token;
        start = end;
    }
    result = result.trim();
    if (result.length >= 2 && quoteEnd(result, 0) === result.length - 1) result = result.slice(1, -1).trim();
    return result;
}

function escaped(text, index) {
    let count = 0;
    while (index > 0 && text[--index] === '\\') count++;
    return count % 2 === 1;
}

function quoteEnd(text, start) {
    if (!quotePairs.has(text[start])) return -1;
    const stack = [quotePairs.get(text[start])];
    for (let i = start + 1; i < text.length; i++) {
        if (escaped(text, i)) continue;
        if (text[i] === stack.at(-1)) stack.pop();
        else if (quotePairs.has(text[i])) stack.push(quotePairs.get(text[i]));
        if (!stack.length) return i;
    }
    return -1;
}

function quotedRuns(text) {
    const runs = [];
    for (let i = 0; i < text.length; i++) {
        if (!quotePairs.has(text[i]) || escaped(text, i)) continue;
        const end = quoteEnd(text, i);
        if (end < 0) return null;
        runs.push(text.slice(i + 1, end));
        i = end;
    }
    return runs;
}

const normalizeWhitespace = text => text.replace(/\s+/gu, ' ').trim();

/** Detect the old prose-plus-copy format without searching earlier story content. */
export function hasLegacyDialogue(raw, segment, previousEnd = 0, vocalEvents) {
    if (!Number.isInteger(segment?.start) || segment.start < 0 || !Number.isInteger(previousEnd)
        || previousEnd < 0 || previousEnd > segment.start) return false;
    const source = String(raw ?? '');
    if (segment.start > source.length) return false;
    const prefix = source.slice(previousEnd, segment.start);
    // A blank line immediately before the tag does not prove it is a copy.
    if (/\r?\n[\t ]*\r?\n[\t ]*$/.test(prefix)) return false;
    const paragraph = prefix.trimEnd().split(/\r?\n[\t ]*\r?\n/).at(-1)?.trim() || '';
    if (!paragraph || /\[TTSVoice\s*[:：]|[`<>]/i.test(paragraph)) return false;
    const runs = quotedRuns(paragraph);
    if (!runs?.length) return false;
    const dialogue = normalizeWhitespace(displayDialogue(segment.text, vocalEvents));
    return Boolean(dialogue) && normalizeWhitespace(runs.map(run => displayDialogue(run, vocalEvents)).join('')) === dialogue;
}
