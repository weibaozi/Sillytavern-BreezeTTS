// Pure text/state helpers: no SillyTavern imports and no DOM mutations.
export const KEY = 'breeze_voice';
export const DEFAULTS = Object.freeze({
    enabled: true, baseUrl: 'http://127.0.0.1:7860', autoGenerate: false,
    autoPlay: false, streaming: false, readStreamingText: false, volume: 0.8, hideTags: true, cfgScale: 4, seed: 42,
});

export function excludedText(raw, streaming = false) {
    // Keep character offsets intact so rendered tags can be matched to raw messages.
    const blank = s => s.replace(/[^\r\n]/g, ' ');
    let text = raw.replace(/```[^]*?(?:```|$)|~~~[^]*?(?:~~~|$)/g, blank);
    // Inline Markdown code can contain literal tags too. Match equal-length
    // backtick runs and retain offsets, just like fenced and HTML code below.
    const backticks = /`+/g;
    let opener;
    while ((opener = backticks.exec(text))) {
        let escapes = 0, before = opener.index;
        while (before > 0 && text[--before] === '\\') escapes++;
        if (escapes % 2) continue;
        const closers = /`+/g;
        closers.lastIndex = backticks.lastIndex;
        let closer;
        while ((closer = closers.exec(text)) && closer[0].length !== opener[0].length) {}
        if (!closer) {
            // While a message is arriving, an unmatched opener may still become
            // a code span. Do not treat its contents as provisional speech.
            if (streaming) { text = text.slice(0, opener.index) + blank(text.slice(opener.index)); break; }
            continue;
        }
        const end = closers.lastIndex;
        text = text.slice(0, opener.index) + blank(text.slice(opener.index, end)) + text.slice(end);
        backticks.lastIndex = end;
    }
    const end = text.indexOf('<!-- 3.正文后的格式 -->');
    if (end >= 0) text = text.slice(0, end) + blank(text.slice(end));
    const token = /<!--[^]*?(?:-->|$)|<\/?(w2g|catsay|details|summary|think|thinking|analysis|status|options|script|style|pre|code)\b[^>]*>/gi;
    let start = -1;
    const stack = [];
    const ranges = [];
    for (const match of text.matchAll(token)) {
        if (match[0].startsWith('<!--')) { ranges.push([match.index, match.index + match[0].length]); continue; }
        const closing = match[0].startsWith('</');
        const name = match[1].toLowerCase();
        if (!closing) {
            if (!stack.length) start = match.index;
            if (!match[0].endsWith('/>')) stack.push(name);
            else if (!stack.length) ranges.push([start, match.index + match[0].length]);
        } else if (stack.length && stack.at(-1) === name) {
            stack.pop();
            if (!stack.length) ranges.push([start, match.index + match[0].length]);
        }
    }
    if (stack.length) ranges.push([start, text.length]);
    for (const [a, b] of ranges.sort((a, b) => b[0] - a[0])) text = text.slice(0, a) + blank(text.slice(a, b)) + text.slice(b);
    return text;
}

export function parseTTS(raw = '', userName = '') {
    raw = String(raw);
    return parsePreparedTTS(raw, excludedText(raw), userName);
}

function parsePreparedTTS(raw, text, userName) {
    const segments = [], diagnostics = [];
    const startPattern = /\[TTSVoice\s*[:：]/gi;
    let match;
    while ((match = startPattern.exec(text))) {
        let depth = 1, end = match.index + match[0].length;
        for (; end < text.length && depth; end++) {
            if (/^\[TTSVoice\s*[:：]/i.test(text.slice(end, end + 16))) break;
            if (text[end] === '[') depth++;
            else if (text[end] === ']') depth--;
        }
        if (depth) { diagnostics.push({ offset: match.index, reason: '标签未闭合' }); continue; }
        startPattern.lastIndex = end;
        const body = text.slice(match.index + match[0].length, end - 1);
        const fields = /^([^:：\[\]\r\n]+)[:：]([^:：\[\]\r\n]*)[:：]([^]*)$/.exec(body);
        if (!fields || !fields[1].trim() || !fields[3].trim() || /[\r\n]/.test(body)) {
            diagnostics.push({ offset: match.index, reason: '标签字段缺失或跨行' }); continue;
        }
        const speaker = fields[1].trim();
        if (speaker === userName.trim() || speaker === '{{user}}') continue;
        segments.push({ speaker, emotion: fields[2].trim() || 'default', text: fields[3].trim(),
            start: match.index, end, raw: String(raw).slice(match.index, end), ordinal: segments.length });
    }
    return { segments, diagnostics };
}

function pendingSpeech(body) {
    // An unfinished nested event ("你好[叹") must not leak its partial name
    // into the visible dialogue. Complete events remain for displayDialogue.
    let depth = 0, open = -1;
    for (let i = 0; i < body.length; i++) {
        if (body[i] === '[') { if (!depth) open = i; depth++; }
        else if (body[i] === ']') depth--;
    }
    return (depth ? body.slice(0, open) : body).trim();
}

function pendingTag(raw, start, headLength, userName) {
    const suffix = raw.slice(start + headLength);
    let depth = 1;
    for (const char of suffix) {
        if (char === '[') depth++;
        else if (char === ']') depth--;
        if (!depth) return null; // A closed but invalid tag is not in progress.
    }
    const parts = suffix.split(/[:：]/);
    const speaker = parts[0].trim();
    if (/[\[\]\r\n]/.test(parts[0]) || (parts.length > 1 && !speaker)) return null;
    if (speaker && (speaker === userName.trim() || speaker === '{{user}}')) return null;
    const result = { start, end: raw.length, raw: raw.slice(start), text: '' };
    if (speaker) result.speaker = speaker;
    if (parts.length < 2) return result;
    if (/[\[\]\r\n]/.test(parts[1])) return null;
    const emotion = parts[1].trim();
    if (emotion || parts.length > 2) result.emotion = emotion || 'default';
    if (parts.length > 2) {
        const first = suffix.search(/[:：]/);
        const second = suffix.slice(first + 1).search(/[:：]/) + first + 1;
        result.text = pendingSpeech(suffix.slice(second + 1));
    }
    return result;
}

/** Complete tags may be queued for speech; pending spans are display-only. */
export function parseStreamingTTS(raw = '', userName = '') {
    raw = String(raw);
    const text = excludedText(raw, true);
    const parsed = parsePreparedTTS(raw, text, userName);
    const pending = [];
    const lineStart = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r')) + 1;
    const line = text.slice(lineStart);
    // Only the final line can still grow into a valid single-line tag. Starting
    // at its last header also prevents malformed earlier tags swallowing it.
    const headers = [...line.matchAll(/\[TTSVoice\s*[:：]/gi)];
    const header = headers.at(-1);
    if (header) {
        const start = lineStart + header.index;
        if (!parsed.segments.some(segment => segment.start <= start && segment.end > start)) {
            const candidate = pendingTag(raw, start, header[0].length, userName);
            if (candidate) pending.push(candidate);
        }
    } else {
        // Short prefixes are ambiguous in prose, so recognize them only as the
        // first content on a line. A lone '[' remains ordinary text.
        const fragment = /^\s*(\[T[^\r\n]*)$/i.exec(line);
        if (fragment) {
            const value = fragment[1];
            if ('[ttsvoice'.startsWith(value.toLowerCase()) || /^\[TTSVoice[ \t]*$/i.test(value)) {
                const start = lineStart + line.length - value.length;
                pending.push({ start, end: raw.length, raw: raw.slice(start), text: '' });
            }
        }
    }
    const pendingOffsets = new Set(pending.map(span => span.start));
    return { ...parsed, pending, diagnostics: parsed.diagnostics.filter(item => !pendingOffsets.has(item.offset)) };
}

export function chatKey(ctx) {
    const id = ctx.getCurrentChatId?.() ?? ctx.chatId;
    if (!id) return '';
    const character = ctx.characters?.[ctx.characterId];
    return JSON.stringify([ctx.groupId ?? '', character?.avatar ?? ctx.characterId ?? '', id]);
}

export function discoverSpeakers(ctx, manual = []) {
    const names = new Set(manual);
    const add = v => { if (typeof v === 'string' && v.trim()) names.add(v.trim()); };
    if (ctx.groupId != null) {
        const group = ctx.groups?.find(g => String(g.id) === String(ctx.groupId));
        for (const avatar of group?.members ?? []) add(ctx.characters?.find(c => c.avatar === avatar)?.name);
    } else add(ctx.characters?.[ctx.characterId]?.name);
    for (const msg of ctx.chat ?? []) {
        if (!msg.is_user && !msg.is_system) for (const s of parseTTS(msg.mes, ctx.name1).segments) add(s.speaker);
    }
    names.delete(ctx.name1); names.delete('{{user}}');
    return [...names].sort((a, b) => a.localeCompare(b, 'zh'));
}

export function mappedVoice(mappings, speaker, voices) {
    const id = Object.hasOwn(mappings, speaker) ? mappings[speaker] : null;
    return id && voices.some(v => v.id === id) ? id : null;
}

export function requestFor(segment, voiceId, settings) {
    if (segment.kind === 'narration' && segment.speechMode === 'clone') {
        return { kind: 'speech', voice_id: voiceId, text: segment.text, speech_mode: 'clone', emotion: '',
            cfg_scale: 1, seed: Number(settings.seed) };
    }
    return { kind: 'speech', voice_id: voiceId, text: segment.text, emotion: /^new$/i.test(segment.emotion) ? 'default' : segment.emotion,
        cfg_scale: Number(settings.cfgScale), seed: Number(settings.seed) };
}

export function cacheKey(base, request) { return JSON.stringify([base, request]); }

export function normalizeBase(value) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('请输入不含密码、查询参数的 HTTP(S) 服务地址。');
    return url.href.replace(/\/$/, '');
}
