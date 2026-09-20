import { excludedText } from './core.js';

export const DEFAULT_NARRATION_TARGET_CHARS = 100;

export function normalizeNarrationTargetChars(value) {
    if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return DEFAULT_NARRATION_TARGET_CHARS;
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(1000, Math.max(20, Math.round(number))) : DEFAULT_NARRATION_TARGET_CHARS;
}

// Offsets always refer to the original message, even when formatting is hidden.
// A hard exclusion ends a narration fragment; soft formatting stays inside it.
const SOFT = 1, EXCLUDED = 2, PENDING = 3;
const EXTRA_MODULE = /<\/?(ai_last_output|blockquote|q|statusbar|character_status)\b[^>]*>/gi;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–' };

function decodeEntity(all, entity) {
    if (entity[0] !== '#') return ENTITIES[entity.toLowerCase()] ?? all;
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
}

function visibleToken(raw, index) {
    const entity = raw[index] === '&' && /^&(#x[\da-f]+|#\d+|[a-z]+);/i.exec(raw.slice(index));
    return entity ? { char: decodeEntity(entity[0], entity[1]), length: entity[0].length } : { char: raw[index], length: 1 };
}

function quotedRanges(raw, mask) {
    const pairs = { '“': '”', '‘': '’', '「': '」', '『': '』', '"': '"', "'": "'" };
    for (let i = 0; i < raw.length; i++) {
        if (mask[i]) continue;
        const opener = visibleToken(raw, i);
        if (!pairs[opener.char]) continue;
        // Apostrophes in contractions/possessives are not spoken quotations.
        if (opener.char === "'" && (/[\p{L}\p{N}]/u.test(raw[i - 1] ?? '') || /\s/.test(raw[i + opener.length] ?? ' '))) continue;
        const close = pairs[opener.char];
        let end = i + opener.length;
        while (end < raw.length) {
            const token = visibleToken(raw, end);
            const apostrophe = close === "'" && /[\p{L}\p{N}]/u.test(raw[end - 1] ?? '') && /[\p{L}\p{N}]/u.test(raw[end + token.length] ?? '');
            if (!mask[end] && token.char === close && raw[end - 1] !== '\\' && !apostrophe) { end += token.length; break; }
            end += token.length;
        }
        mask.fill(EXCLUDED, i, end);
        i = end - 1;
    }
}

function closeBracket(raw, start, opener = '[', closer = ']') {
    let depth = 0;
    for (let i = start; i < raw.length; i++) {
        if (raw[i] === '\\') { i++; continue; }
        if (raw[i] === opener) depth++;
        else if (raw[i] === closer && --depth === 0) return i + 1;
    }
    return -1;
}

function markupMask(raw, streaming) {
    const mask = new Uint8Array(raw.length);
    // Exempt real body comments from comment masking, but still let code and
    // surrounding excluded modules hide them. Literal examples are not structure.
    const markerPattern = /<!--\s*[123][.．、]\s*正文(?:前的格式|后的格式)?\s*-->/gi;
    const markers = [...raw.matchAll(markerPattern)];
    const structure = excludedText(raw.replace(markerPattern, marker => '@' + marker.slice(1)), true);
    for (let i = 0; i < raw.length; i++) if (raw[i] !== structure[i]) mask[i] = EXCLUDED;
    for (const marker of markers) mask.fill(EXCLUDED, marker.index, marker.index + marker[0].length);
    const moduleMask = new Uint8Array(raw.length);
    const maskModule = (start, end = raw.length) => {
        mask.fill(EXCLUDED, start, end);
        moduleMask.fill(1, start, end);
    };

    const modules = [];
    let moduleStart = 0;
    for (const match of structure.matchAll(EXTRA_MODULE)) {
        const closing = match[0].startsWith('</');
        if (!closing) {
            if (!modules.length) moduleStart = match.index;
            if (!match[0].endsWith('/>')) modules.push(match[1].toLowerCase());
            else if (!modules.length) maskModule(moduleStart, match.index + match[0].length);
        } else if (modules.at(-1) === match[1].toLowerCase()) {
            modules.pop();
            if (!modules.length) maskModule(moduleStart, match.index + match[0].length);
        }
    }
    if (modules.length) maskModule(moduleStart);
    const realMarkers = markers.filter(marker => structure[marker.index] === '@' && !moduleMask[marker.index]);
    const body = realMarkers.find(marker => /<!--\s*2[.．、]\s*正文\s*-->/i.test(marker[0]));
    const beforeBody = realMarkers.find(marker => /<!--\s*1[.．、]\s*正文前的格式\s*-->/i.test(marker[0]));
    if (body) mask.fill(EXCLUDED, 0, body.index + body[0].length);
    else if (beforeBody) mask.fill(EXCLUDED, beforeBody.index);
    const afterBody = realMarkers.find(marker => /<!--\s*3[.．、]\s*正文后的格式\s*-->/i.test(marker[0]));
    if (afterBody) mask.fill(EXCLUDED, afterBody.index);

    for (let i = 0; i < raw.length; i++) {
        if (mask[i]) continue;
        if (raw[i] === '<') {
            const end = raw.indexOf('>', i + 1);
            if (end < 0) { mask.fill(streaming ? PENDING : EXCLUDED, i); break; }
            const tag = raw.slice(i, end + 1);
            // Line/block tags are boundaries; ordinary inline markup is silent.
            const kind = /^<\/?(?:br|p|div|li|h[1-6])\b/i.test(tag) ? EXCLUDED : SOFT;
            mask.fill(kind, i, end + 1);
            i = end;
            continue;
        }
        if (raw[i] !== '[' && !(raw[i] === '!' && raw[i + 1] === '[')) continue;
        const image = raw[i] === '!';
        const start = i + Number(image);
        const suffix = raw.slice(start);
        const voice = /^\[TTS\s*Voice(?:[:：\s\]])/i.test(suffix);
        const pendingVoice = suffix.length > 1 && '[ttsvoice'.startsWith(suffix.toLowerCase());
        let end = closeBracket(raw, start);
        if (pendingVoice) {
            mask.fill(streaming ? PENDING : EXCLUDED, i);
            break;
        }
        if (voice) {
            // Ignore malformed and user-owned tags too. An unclosed tag is not
            // narration; a later header can still be handled by the TTS parser.
            const next = /\[TTSVoice\s*[:：]/i.exec(raw.slice(start + 1));
            if (next && (end < 0 || start + 1 + next.index < end)) end = start + 1 + next.index;
            if (end < 0) end = raw.length;
            mask.fill(EXCLUDED, i, end);
            i = end - 1;
            continue;
        }
        if (end < 0 || (streaming && end === raw.length)) {
            mask.fill(streaming ? PENDING : EXCLUDED, i);
            break;
        }
        if (raw[end] === '[') {
            const referenceEnd = closeBracket(raw, end);
            if (referenceEnd < 0) { mask.fill(streaming ? PENDING : EXCLUDED, i); break; }
            mask.fill(EXCLUDED, i, referenceEnd);
            i = referenceEnd - 1;
        } else if (raw[end] === '(') {
            const destinationEnd = closeBracket(raw, end, '(', ')');
            if (destinationEnd < 0) { mask.fill(streaming ? PENDING : EXCLUDED, i); break; }
            if (image) mask.fill(EXCLUDED, i, destinationEnd);
            else {
                mask[start] = SOFT;
                mask[end - 1] = SOFT;
                mask.fill(SOFT, end, destinationEnd);
            }
            i = destinationEnd - 1;
        } else if (image) {
            mask.fill(EXCLUDED, i, end);
            i = end - 1;
        } else {
            // Ordinary bracketed prose is allowed, but partial bracket content
            // is withheld while streaming in case it becomes a link/tag.
            i = end - 1;
        }
    }

    // Reference images, bare URLs, and Markdown block quotations are not speech.
    for (const match of raw.matchAll(/!?\[[^\]\r\n]*\]\[[^\]\r\n]*\]|^\s*>[^\r\n]*|^\s*\[[^\]\r\n]+\]:[^\r\n]*/gm)) {
        mask.fill(EXCLUDED, match.index, match.index + match[0].length);
    }
    for (const match of raw.matchAll(/https?:\/\/[^\s<>"'\]。！？；，]+/g)) {
        if (!mask[match.index]) mask.fill(EXCLUDED, match.index, match.index + match[0].length);
    }
    for (const match of raw.matchAll(/^\s*(?:#{1,6}\s*|[-+*]\s+|\d+[.)]\s+)/gm)) {
        for (let i = match.index; i < match.index + match[0].length; i++) if (!mask[i]) mask[i] = SOFT;
    }
    quotedRanges(raw, mask);
    return mask;
}

/** Extract only prose narration, ordered by original source position.
 * Adjacent sentences share a chunk up to the target's last complete sentence.
 * Streaming waits until the next sentence cannot fit before committing a chunk;
 * paragraphs and speech boundaries flush immediately. A long sentence remains
 * whole, subject to the existing 5000-character request protection.
 */
export function parseNarration(raw = '', userName = '', { streaming = false, targetChars = DEFAULT_NARRATION_TARGET_CHARS } = {}) {
    raw = String(raw);
    void userName; // Every quoted/TTS utterance is excluded, regardless of speaker.
    const target = normalizeNarrationTargetChars(targetChars);
    const mask = markupMask(raw, streaming);
    const segments = [];
    // Each visible Unicode character keeps its original source extent. This
    // makes both length accounting and cuts independent of markup/entity width.
    let units = [];
    const append = (char, start, end) => {
        if (/\s/.test(char)) {
            if (!units.length || units.at(-1).char === ' ') return;
            char = ' ';
        }
        units.push({ char, start, end });
    };
    const flush = complete => {
        let tail = units.length;
        while (tail > 0 && units[tail - 1].char === ' ') tail--;
        const boundaries = [];
        for (let i = 0; i < tail; i++) {
            const char = units[i].char;
            if (/[。！？!?；;]/.test(char) || (char === '.' && (units[i + 1]?.char === ' ' || (complete && i + 1 === tail)))) boundaries.push(i + 1);
        }
        let from = 0;
        while (from < tail) {
            while (from < tail && units[from].char === ' ') from++;
            if (from >= tail) break;
            const within = boundaries.filter(end => end > from && end <= from + target).at(-1);
            let to;
            if (within && (tail > from + target || within === from + target)) to = within;
            else if (tail > from + target) {
                const firstSentence = boundaries.find(end => end > from);
                if (firstSentence && firstSentence <= from + 5000) to = firstSentence;
                else if (tail >= from + 5000) to = from + 5000;
            }
            if (!to) {
                if (!complete) break;
                to = Math.min(tail, from + 5000);
            }
            let contentEnd = to;
            while (contentEnd > from && units[contentEnd - 1].char === ' ') contentEnd--;
            const text = units.slice(from, contentEnd).map(unit => unit.char).join('');
            if (/[\p{L}\p{N}]/u.test(text)) {
                const start = units[from].start, end = units[contentEnd - 1].end;
                segments.push({ kind: 'narration', speaker: '旁白', text, start, end, raw: raw.slice(start, end), ordinal: segments.length });
            }
            from = to;
        }
        units = [];
    };
    for (let i = 0; i < raw.length; i++) {
        if (mask[i] === PENDING) break;
        if (mask[i] === EXCLUDED || raw[i] === '\n' || raw[i] === '\r') { flush(true); continue; }
        if (mask[i] === SOFT) continue;
        if (/[*_~`]/.test(raw[i])) continue;
        if (raw[i] === '\\' && /[\\`*_{}\[\]()#+.!~>-]/.test(raw[i + 1] ?? '')) {
            if (!mask[i + 1]) {
                if (!/[*_~`]/.test(raw[i + 1])) append(raw[i + 1], i, i + 2);
                i++;
            }
            continue;
        }
        // These incomplete tokens can become silent markup or a shorter entity
        // on the next update, so they cannot count toward an irrevocable cut.
        const suffix = raw.slice(i);
        if (streaming && ((i + 1 === raw.length && /[!\\\uD800-\uDBFF]/.test(raw[i])) ||
            /^&(?:#[xX]?[\da-f]*|[a-z]*)$/i.test(suffix) || /^(?:h|ht|htt|https?|https?:\/{0,2})$/i.test(suffix))) break;
        const entity = raw[i] === '&' && /^&(#x[\da-f]+|#\d+|[a-z]+);/i.exec(suffix);
        if (entity) {
            const decoded = decodeEntity(entity[0], entity[1]);
            if (decoded !== entity[0]) {
                for (const char of decoded) append(char, i, i + entity[0].length);
                i += entity[0].length - 1;
                continue;
            }
        }
        const char = String.fromCodePoint(raw.codePointAt(i));
        append(char, i, i + char.length);
        i += char.length - 1;
    }
    flush(!streaming);
    return segments;
}
