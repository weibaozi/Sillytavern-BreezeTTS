import { KEY, chatKey, discoverSpeakers, mappedVoice } from './core.js';
import { resolveExtraPrompt } from './extra-prompts.js';

export const PROMPT_KEY = 'breeze_voice_protocol';
export const LEGACY_DEFAULT_TEMPLATE = `[Voice Synthesis & Dialogue Protocol]
Preserve the existing prose style, output language, and all unrelated preset requirements.
{{primary_character_note}}

1. Keep natural narration and quoted dialogue; do not require a "Name:" prefix. Use one exact, consistent character name in every TTS tag, never pronouns or changing nicknames.

2. Immediately after EVERY eligible spoken paragraph, add one separate plain-text line:
[TTSVoice:Character_Name:emotion:Spoken dialogue]
Copy ALL spoken words in that paragraph in order, preserving wording and punctuation. Remove surrounding quotes, Markdown, and narration. Use one speaker per paragraph; complete its tag before writing the next paragraph. Short replies, consecutive remarks, questions, and closing lines all need tags.

3. Do not tag {{user}}'s speech, narration, thoughts, unspoken quotations, text messages, or content in <w2g>, <catsay>, summaries, and status panels. TTSVoice is permitted body metadata: dialogue repetition and emotion fields are exempt from prose restrictions against repetition or delivery annotations, and do not count toward the prose length. Keep all other format modules and their order unchanged.

4. Speakers:
- Bound characters (use a short, natural emotion description; default for neutral delivery):
{{bound_characters_section}}
- Skipped characters (ordinary prose only; no TTS tag):
{{skipped_characters_section}}
- New / unbound characters: still tag their speech with emotion New, using their exact name. This includes any new NPC and these known unbound characters:
{{unbound_characters_section}}
Emotion should follow the scene naturally, without abrupt extremes. Voice-profile names never replace character names.

5. Inside the copied dialogue, optionally add audible events at the intended position: {{vocal_events}}. Keep these Chinese tags unchanged. Use them sparingly; a smile alone is not audible laughter. No silent actions. These events are the only additions to copied speech. Close each inner bracket pair and then the outer TTSVoice bracket.

Use the exact prefix TTSVoice. Names and emotions contain no colons, square brackets, or line breaks. Each complete tag occupies one line, without bold or code fences.

Example (a bound speaker):
周启明笑出了声。“等一下。”他合上本子。“现在可以了。”
[TTSVoice:周启明:happy:[笑]等一下。现在可以了。]

Before ending the body or starting any post-body module, silently check the penultimate and final eligible spoken paragraphs, including a final question to {{user}}. Each needs its own adjacent, complete tag. Fix omissions at their original positions; do not collect tags at the end or print the check.`;

export const DEFAULT_VOCAL_EVENTS = '[笑]\n[叹气]\n[咳嗽]\n[清嗓子]';
export const PREVIOUS_DEFAULT_TEMPLATE = LEGACY_DEFAULT_TEMPLATE
    .replace('optionally add audible events at the intended position: {{vocal_events}}. Keep these Chinese tags unchanged.',
        'optionally add only these allowed audible events at the intended position: {{vocal_events}}. Keep event tags unchanged; if none are allowed, add no vocal-event tags.')
    .replace('周启明笑出了声。', '周启明抬起手。')
    .replace('[TTSVoice:周启明:happy:[笑]等一下。现在可以了。]', '[TTSVoice:周启明:happy:{{vocal_event_example}}等一下。现在可以了。]');

export const DEFAULT_TEMPLATE = PREVIOUS_DEFAULT_TEMPLATE
    .replace('2. Immediately after EVERY eligible spoken paragraph, add one separate plain-text line:',
        '2. Every eligible spoken paragraph MUST contain BOTH copies, in this order: first write the full dialogue in ordinary quotation marks within the story; immediately below that paragraph, repeat its spoken words as one separate plain-text line:')
    .replace('Copy ALL spoken words in that paragraph in order, preserving wording and punctuation.',
        'TTSVoice is an additional audio copy, NEVER a replacement for readable dialogue. Never output speech only inside a TTS tag. Copy ALL spoken words from the preceding paragraph in order, preserving wording and punctuation.')
    .replace('Remove surrounding quotes, Markdown, and narration.',
        'In the TTS copy only, remove surrounding quotes, Markdown, and narration; preserve them in the readable story.')
    .replace('Each needs its own adjacent, complete tag. Fix omissions at their original positions;',
        'Each needs BOTH readable quoted dialogue and its adjacent, complete tag. Also check every TTS tag has its full dialogue in the paragraph above it: hiding all TTS tags must leave the story and every spoken line readable. Restore missing quoted speech above its tag. Fix omissions at their original positions;');

export const PROMPT_DEFAULTS = Object.freeze({
    injectPrompt: true, promptDepth: 1, promptTemplate: DEFAULT_TEMPLATE, vocalEvents: DEFAULT_VOCAL_EVENTS,
    extraPromptPresets: Object.freeze([]),
});

export function parseVocalEvents(value) {
    const source = typeof value === 'string' ? value : DEFAULT_VOCAL_EVENTS;
    const events = new Set(), invalid = new Set();
    for (const raw of source.split(/[\r\n,，、;；]+/)) {
        const token = raw.trim();
        if (!token) continue;
        const label = token.startsWith('[') && token.endsWith(']') ? token.slice(1, -1).trim() : token;
        if (!label || /[\[\]{}:：\x00-\x1f\x7f]/.test(label)) {
            invalid.add(token);
            continue;
        }
        events.add(`[${label}]`);
    }
    return { events: [...events], invalid: [...invalid] };
}

// Character names are data; braces in names must not become executable ST macros.
const quoted = value => JSON.stringify(String(value)).replace(/\{/g, '\\u007b').replace(/\}/g, '\\u007d');
const tagName = value => typeof value === 'string' && value.trim() && !/[:：\[\]\r\n]/.test(value);

export function buildVoicePrompt(ctx, settings, voices = []) {
    if (!chatKey(ctx)) return '';
    const data = ctx.chatMetadata?.[KEY] || {}, mappings = data.mappings || {};
    const manual = Array.isArray(data.manual) ? data.manual : [];
    const names = discoverSpeakers(ctx, [...manual, ...Object.keys(mappings)]).filter(tagName);
    const bound = names.filter(name => mappedVoice(mappings, name, voices));
    const unbound = names.filter(name => !bound.includes(name));
    const primary = ctx.characters?.[ctx.characterId]?.name;
    const { events } = parseVocalEvents(settings.vocalEvents);
    const slots = {
        primary_character_note: tagName(primary) && primary !== ctx.name1
            ? `Current speaking character, if applicable: ${quoted(primary)}. Keep this exact name in tags.` : '',
        bound_characters_section: bound.length ? bound.map(name => `  - ${quoted(name)}`).join('\n') : '  (None currently bound.)',
        skipped_characters_section: `  - ${quoted(ctx.name1 || 'the user')} (the user).`,
        unbound_characters_section: unbound.length ? unbound.map(name => `  - ${quoted(name)}`).join('\n') : '  (Any other new character; keep names consistent.)',
        vocal_events: events.length ? events.join(', ') : 'None',
        vocal_event_example: events[0] || '',
        user: quoted(ctx.name1 || 'the user'),
    };
    const template = typeof settings.promptTemplate === 'string' ? settings.promptTemplate : DEFAULT_TEMPLATE;
    // One pass: inserted values (including dollar signs and braces) are never templates.
    const compiled = template.replace(/\{\{(primary_character_note|bound_characters_section|skipped_characters_section|unbound_characters_section|vocal_events|vocal_event_example|user)\}\}/g,
        (_match, slot) => slots[slot]).trim();
    const extra = resolveExtraPrompt(settings, data).trim();
    return data.extraPromptEnabled === true && extra
        ? `${compiled}\n\n6. Additional scene guidance (current chat):\n${extra}` : compiled;
}

export function syncVoicePrompt(ctx, settings, voices = [], type = null) {
    const text = buildVoicePrompt(ctx, settings, voices);
    const active = Boolean(settings.enabled && settings.injectPrompt && text && !['quiet', 'impersonate'].includes(type));
    const depth = settings.promptDepth == null || String(settings.promptDepth).trim() === '' ? NaN : Number(settings.promptDepth);
    const safeDepth = Number.isInteger(depth) && depth >= 0 && depth <= 100 ? depth : 1;
    if (typeof ctx.setExtensionPrompt !== 'function') {
        return { text, active: false, reason: '当前酒馆未提供提示词注入接口，请更新酒馆。' };
    }
    try {
        // ST: IN_CHAT=1, SYSTEM=0. Sixth argument is role; no filter callback needed.
        // Always register with the fresh context: clearChat resets ST's prompt registry.
        ctx.setExtensionPrompt(PROMPT_KEY, active ? text : '', 1, safeDepth, false, 0);
        return { text, active, reason: active ? `已启用：系统提示词，聊天深度 ${safeDepth}。`
            : !chatKey(ctx) ? '打开聊天后自动注入。'
                : ['quiet', 'impersonate'].includes(type) ? '本次为后台生成或用户代写，已暂停注入。'
                    : '已关闭注入；只清除本插件的提示词。' };
    } catch (error) {
        return { text, active: false, reason: `注入失败：${error.message}` };
    }
}
