// Pure text/state helpers: no SillyTavern imports and no DOM mutations.
export const KEY = 'breeze_voice';
export const DEFAULTS = Object.freeze({
    enabled: true, baseUrl: 'http://127.0.0.1:7860', autoGenerate: false,
    autoPlay: false, streaming: false, volume: 0.8, hideTags: true, cfgScale: 4, seed: 42,
});

function excludedText(raw) {
    // Keep character offsets intact so rendered tags can be matched to raw messages.
    const blank = s => s.replace(/[^\r\n]/g, ' ');
    let text = raw.replace(/```[^]*?(?:```|$)|~~~[^]*?(?:~~~|$)/g, blank);
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
    const text = excludedText(String(raw));
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
    return { kind: 'speech', voice_id: voiceId, text: segment.text, emotion: /^new$/i.test(segment.emotion) ? 'default' : segment.emotion,
        cfg_scale: Number(settings.cfgScale), seed: Number(settings.seed) };
}

export function cacheKey(base, request) { return JSON.stringify([base, request]); }

export function normalizeBase(value) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('请输入不含密码、查询参数的 HTTP(S) 服务地址。');
    return url.href.replace(/\/$/, '');
}
