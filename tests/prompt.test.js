import test from 'node:test';
import assert from 'node:assert/strict';
import { KEY, DEFAULTS } from '../extension/core.js';
import { PROMPT_KEY, DEFAULT_TEMPLATE, STABLE_DEFAULT_TEMPLATE, PREVIOUS_DEFAULT_TEMPLATE, LEGACY_DEFAULT_TEMPLATE, DEFAULT_VOCAL_EVENTS, PROMPT_DEFAULTS, parseVocalEvents, buildVoicePrompt, syncVoicePrompt } from '../extension/prompt.js';

const voices = [{ id: 'voice-1', name: 'PRIVATE_LIBRARY_NAME_1' }, { id: 'voice-2', name: 'PRIVATE_LIBRARY_NAME_2' }];
const expectedEvents = [
    '[笑]', '[叹气]', '[咳嗽]', '[清嗓子]',
    '[大笑]', '[轻笑]', '[窃笑]', '[偷笑]', '[吸气]', '[呼气]', '[深呼吸]', '[喘气]', '[吞咽]', '[咂嘴]', '[哭]', '[抽泣]', '[哽咽]', '[尖叫]', '[惊呼]', '[打哈欠]', '[打喷嚏]', '[哼]', '[停顿]',
    '(laugh)', '(giggle)', '(chuckle)', '(sigh)', '(cough)', '(clears throat)', '(sniff)', '(gasp)', '(breath)', '(cry)', '(yawn)',
    '[soft gasps]', '[gasps]', '[breathy sigh]', '[soft moan]', '[whimper]', '[needy moan]', '[breathy pant]', '[low whimper]', '[shaky gasp]', '[low moan]', '[husky sigh]', '[deep pant]', '[throaty hum]',
];
const sectionTemplate = [
    'PRIMARY={{primary_character_note}}',
    'BOUND={{bound_characters_section}}',
    'SKIPPED={{skipped_characters_section}}',
    'UNBOUND={{unbound_characters_section}}',
    'EVENTS={{vocal_events}}',
    'USER={{user}}',
].join('\n---\n');
const settings = (extra = {}) => ({ ...DEFAULTS, ...PROMPT_DEFAULTS, ...extra });

function context(extra = {}) {
    const ctx = {
        name1: '包子', name2: '周启明', characterId: 0, chatId: 'campus',
        characters: [{ name: '周启明', avatar: 'zhou.png' }, { name: '无关角色', avatar: 'other.png' }],
        chat: [{ mes: '[TTSVoice:林知夏:自然:你好。]' }],
        chatMetadata: { [KEY]: { mappings: { 周启明: 'voice-1', 林知夏: null }, manual: ['沈予安'] } },
        extensionPrompts: { tg_break_format: { value: 'ORIGINAL_TG_FORMAT' }, catsay: { value: 'ORIGINAL_CATSAY' } },
        calls: [],
        ...extra,
    };
    ctx.setExtensionPrompt = function (...args) {
        this.calls.push(args);
        const [key, value, position, depth, scan, role] = args;
        this.extensionPrompts[key] = { value, position, depth, scan, role };
    };
    return ctx;
}

function sections(text) {
    return Object.fromEntries(text.split('\n---\n').map(part => {
        const split = part.indexOf('=');
        return [part.slice(0, split), part.slice(split + 1)];
    }));
}

test('default English protocol includes all 47 events while keeping the original four first', () => {
    assert.equal(PROMPT_KEY, 'breeze_voice_protocol');
    assert.equal(PROMPT_DEFAULTS.injectPrompt, true);
    assert.equal(PROMPT_DEFAULTS.promptDepth, 1);
    assert.equal(PROMPT_DEFAULTS.promptTemplate, DEFAULT_TEMPLATE);
    assert.equal(PROMPT_DEFAULTS.vocalEvents, DEFAULT_VOCAL_EVENTS);
    assert.equal(expectedEvents.length, 47);
    assert.equal(new Set(expectedEvents).size, 47);
    assert.deepEqual(parseVocalEvents(DEFAULT_VOCAL_EVENTS), { events: expectedEvents, invalid: [] });
    const text = buildVoicePrompt(context(), settings(), voices);
    assert.match(text, /TTSVoice/);
    for (const event of expectedEvents) assert.ok(text.includes(event), event);
    assert.match(text, /New/);
    assert.doesNotMatch(text, /\{\{(?:primary_character_note|bound_characters_section|skipped_characters_section|unbound_characters_section|vocal_events|vocal_event_example)\}\}/);
});

test('experimental default uses one speech copy while retaining historic templates unchanged', () => {
    const text = buildVoicePrompt(context(), settings(), voices);
    assert.match(text, /spoken utterance ONLY ONCE/);
    assert.match(text, /never echo it before or after the tag, with or without quotation marks, or in a second tag/);
    assert.match(text, /Keep narration, actions, and thoughts outside TTSVoice/);
    assert.match(text, /no outer quotation marks, Markdown, or narration/);
    assert.match(text, /penultimate and final utterances/);
    assert.doesNotMatch(text, /MUST contain BOTH copies|Never output speech only inside a TTS tag/);
    assert.equal(text.split('等一下。现在可以了。').length - 1, 1);
    assert.ok(text.includes('周启明抬起手。\n[TTSVoice:周启明:softly reassuring:[笑]等一下。现在可以了。]\n他合上本子。'));
    assert.match(STABLE_DEFAULT_TEMPLATE, /MUST contain BOTH copies/);
    assert.match(STABLE_DEFAULT_TEMPLATE, /hiding all TTS tags must leave the story and every spoken line readable/);
    assert.match(PREVIOUS_DEFAULT_TEMPLATE, /Immediately after EVERY eligible spoken paragraph/);
    assert.match(LEGACY_DEFAULT_TEMPLATE, /Keep these Chinese tags unchanged/);
});

test('experimental protocol has five rules, unchanged exclusions and role lists, and an optional sixth rule', () => {
    const ctx = context();
    const text = buildVoicePrompt(ctx, settings(), voices);
    assert.deepEqual([...text.matchAll(/^(\d+)\. /gm)].map(match => Number(match[1])), [1, 2, 3, 4, 5]);
    assert.match(text, /Do not tag "包子"'s speech, unspoken quotations, text messages, or content in <w2g>, <catsay>, summaries, and status panels/);
    assert.match(text, /Bound characters[^\n]*\n  - "周启明"/);
    assert.match(text, /Skipped characters[^\n]*\n  - "包子" \(the user\)/);
    assert.match(text, /New \/ unbound characters[^\n]*\n  - "林知夏"\n  - "沈予安"/);
    assert.doesNotMatch(text, /PRIVATE_LIBRARY_NAME|无关角色/);
    Object.assign(ctx.chatMetadata[KEY], { extraPromptEnabled: true, extraPrompt: 'Keep campus voices quiet.' });
    const extended = buildVoicePrompt(ctx, settings(), voices);
    assert.deepEqual([...extended.matchAll(/^(\d+)\. /gm)].map(match => Number(match[1])), [1, 2, 3, 4, 5, 6]);
    assert.equal(extended, `${text}\n\n6. Additional scene guidance (current chat):\nKeep campus voices quiet.`);
});

test('vocal events accept lines or common separators, normalize brackets and deduplicate', () => {
    assert.deepEqual(parseVocalEvents(' 笑\n[叹气], 咳嗽， [ 清嗓子 ]、笑;吸气；[叹气]\r\n'), {
        events: ['[笑]', '[叹气]', '[咳嗽]', '[清嗓子]', '[吸气]'], invalid: [],
    });
    for (const value of [undefined, null, 42, []]) assert.deepEqual(parseVocalEvents(value).events, expectedEvents);
    for (const value of ['', ' \n,； ']) assert.deepEqual(parseVocalEvents(value), { events: [], invalid: [] });
});

test('event parsing preserves parenthesized labels and splits adjacent complete tags', () => {
    assert.deepEqual(parseVocalEvents('(laugh)( clears throat ) [whimper][needy moan]\nsoft gasps; (laugh),[soft gasps]'), {
        events: ['(laugh)', '(clears throat)', '[whimper]', '[needy moan]', '[soft gasps]'], invalid: [],
    });
    assert.deepEqual(parseVocalEvents('[gasp](gasp), gasp'), {
        events: ['[gasp]', '(gasp)'], invalid: [],
    });
});

test('malformed or macro-like event labels are reported and omitted from the prompt', () => {
    const invalid = ['[笑', '咳嗽]', '[[叹气]]', '[]', '(laugh', 'sigh)', '((laugh))', '()', '[laugh)', '(sigh]', '[(laugh)]', '([sigh])', '(laugh[soft])', '[soft(gasp)]', 'TTSVoice:说话', '情绪：开心', '{{char}}', '笑{宏}', '({{char}})', '坏\u0000标签'];
    const value = `${invalid.join('\n')}\n吸气`;
    assert.deepEqual(parseVocalEvents(value), { events: ['[吸气]'], invalid });
    const text = buildVoicePrompt(context(), settings({ vocalEvents: value }), voices);
    assert.ok(text.includes('[吸气]'));
    for (const token of invalid) assert.ok(!text.includes(token), token);
    assert.ok(!text.includes('[笑]'));
});

test('changing event list updates both rule and example without keeping an old event', () => {
    const text = buildVoicePrompt(context(), settings({ vocalEvents: '[吸气]\n低笑' }), voices);
    assert.match(text, /allowed audible events at the intended position: \[吸气\], \[低笑\]/);
    assert.ok(text.includes('[TTSVoice:周启明:softly reassuring:[吸气]等一下。现在可以了。]'));
    for (const event of expectedEvents.filter(event => event !== '[吸气]')) assert.ok(!text.includes(event), event);
    assert.ok(LEGACY_DEFAULT_TEMPLATE.includes('[TTSVoice:周启明:happy:[笑]等一下。现在可以了。]'));
    assert.ok(!LEGACY_DEFAULT_TEMPLATE.includes('{{vocal_event_example}}'));
});

test('parenthesized event lists update the rule and example without becoming square-bracket events', () => {
    const text = buildVoicePrompt(context(), settings({ vocalEvents: '(clears throat)[whimper][needy moan]' }), voices);
    assert.match(text, /allowed audible events at the intended position: \(clears throat\), \[whimper\], \[needy moan\]/);
    assert.ok(text.includes('[TTSVoice:周启明:softly reassuring:(clears throat)等一下。现在可以了。]'));
    assert.ok(!text.includes('[笑]'));
    assert.ok(!text.includes('[clears throat]'));
});

test('explicitly empty or wholly invalid event list disables events instead of restoring defaults', () => {
    for (const vocalEvents of ['', ' \n ', '[[笑]]\n{{char}}']) {
        const text = buildVoicePrompt(context(), settings({ vocalEvents }), voices);
        assert.match(text, /allowed audible events at the intended position: None/);
        assert.ok(text.includes('[TTSVoice:周启明:softly reassuring:等一下。现在可以了。]'));
        for (const event of parseVocalEvents(DEFAULT_VOCAL_EVENTS).events) assert.ok(!text.includes(event), event);
    }
});

test('extra guidance is appended as section six only when this chat enables nonblank text', () => {
    const ctx = context();
    const baseline = buildVoicePrompt(ctx, settings(), voices);
    assert.doesNotMatch(baseline, /6\. Additional scene guidance/);
    const data = ctx.chatMetadata[KEY];
    data.extraPrompt = '  Campus at night. Keep voices quiet; use [叹气] only when audible.  \n';
    for (const enabled of [undefined, false, 'true', 1]) {
        data.extraPromptEnabled = enabled;
        assert.equal(buildVoicePrompt(ctx, settings(), voices), baseline);
        assert.ok(data.extraPrompt.includes('Campus at night.'), 'disabled content stays stored');
    }
    data.extraPromptEnabled = true;
    const text = buildVoicePrompt(ctx, settings(), voices);
    assert.equal(text, `${baseline}\n\n6. Additional scene guidance (current chat):\n${data.extraPrompt.trim()}`);
    for (const value of ['', ' \n\t ', null, 123]) {
        data.extraPrompt = value;
        assert.equal(buildVoicePrompt(ctx, settings(), voices), baseline);
    }
});

test('chat-specific guidance changes with chat metadata and preserves unrelated extension prompts', () => {
    const ctx = context();
    Object.assign(ctx.chatMetadata[KEY], { extraPromptEnabled: true, extraPrompt: 'FIRST_CHAT_GUIDANCE' });
    const originals = structuredClone(ctx.extensionPrompts);
    const first = syncVoicePrompt(ctx, settings(), voices);
    assert.match(first.text, /6\. Additional scene guidance \(current chat\):\nFIRST_CHAT_GUIDANCE$/);
    ctx.chatId = 'other-chat';
    ctx.chatMetadata = { [KEY]: { extraPromptEnabled: true, extraPrompt: 'SECOND_CHAT_GUIDANCE' } };
    const second = syncVoicePrompt(ctx, settings(), voices);
    assert.match(second.text, /SECOND_CHAT_GUIDANCE$/);
    assert.doesNotMatch(second.text, /FIRST_CHAT_GUIDANCE/);
    ctx.chatMetadata = {};
    assert.doesNotMatch(syncVoicePrompt(ctx, settings(), voices).text, /CHAT_GUIDANCE|6\. Additional scene guidance/);
    for (const [key, value] of Object.entries(originals)) assert.deepEqual(ctx.extensionPrompts[key], value);
});

test('named extra guidance follows each chat binding and shared edits without leaking library names', () => {
    const ctx = context();
    const cfg = settings({ extraPromptPresets: [
        { id: 'night', name: 'PRIVATE_LIBRARY_LABEL', text: '  Quiet voices at night.  ' },
        { id: 'day', name: 'Daytime', text: 'Energetic campus conversation.' },
    ] });
    const baseline = buildVoicePrompt(ctx, cfg, voices);
    Object.assign(ctx.chatMetadata[KEY], { extraPromptEnabled: true, extraPromptId: 'night', extraPrompt: 'LEGACY_BACKUP' });
    assert.equal(buildVoicePrompt(ctx, cfg, voices), `${baseline}\n\n6. Additional scene guidance (current chat):\nQuiet voices at night.`);
    cfg.extraPromptPresets = [{ ...cfg.extraPromptPresets[0], name: 'Renamed label', text: 'Shared new guidance.' }, cfg.extraPromptPresets[1]];
    assert.match(buildVoicePrompt(ctx, cfg, voices), /Shared new guidance\.$/);
    ctx.chatMetadata[KEY].extraPromptId = 'day';
    const second = buildVoicePrompt(ctx, cfg, voices);
    assert.match(second, /Energetic campus conversation\.$/);
    assert.doesNotMatch(second, /PRIVATE_LIBRARY_LABEL|Renamed label|LEGACY_BACKUP|Shared new guidance/);
    for (const id of ['deleted-id', null, '', undefined]) {
        ctx.chatMetadata[KEY].extraPromptId = id;
        assert.equal(buildVoicePrompt(ctx, cfg, voices), baseline);
    }
});

test('named extra guidance still needs the enabled switch and nonblank text', () => {
    const ctx = context();
    const cfg = settings({ extraPromptPresets: [{ id: 'scene', name: 'Scene', text: 'Keep {{vocal_events}} $& literal.' }] });
    const baseline = buildVoicePrompt(ctx, cfg, voices);
    const data = ctx.chatMetadata[KEY];
    data.extraPromptId = 'scene';
    for (const enabled of [undefined, false, 'true']) {
        data.extraPromptEnabled = enabled;
        assert.equal(buildVoicePrompt(ctx, cfg, voices), baseline);
    }
    data.extraPromptEnabled = true;
    assert.equal(buildVoicePrompt(ctx, cfg, voices), `${baseline}\n\n6. Additional scene guidance (current chat):\nKeep {{vocal_events}} $& literal.`);
    cfg.extraPromptPresets = [{ id: 'scene', name: 'Scene', text: ' \n\t ' }];
    assert.equal(buildVoicePrompt(ctx, cfg, voices), baseline);
});

test('new event slot and extra guidance are not recursively interpreted as template replacements', () => {
    const ctx = context();
    ctx.chatMetadata[KEY].extraPromptEnabled = true;
    ctx.chatMetadata[KEY].extraPrompt = 'Keep this user text: {{vocal_events}} $& {{custom_scene}}';
    const custom = 'EVENTS={{vocal_events}}; EXAMPLE={{vocal_event_example}}; {{getvar::gs-w2g}}';
    const cfg = settings({ promptTemplate: custom, vocalEvents: '$&' });
    assert.equal(buildVoicePrompt(ctx, cfg, voices),
        'EVENTS=[$&]; EXAMPLE=[$&]; {{getvar::gs-w2g}}\n\n6. Additional scene guidance (current chat):\nKeep this user text: {{vocal_events}} $& {{custom_scene}}');
    assert.equal(cfg.promptTemplate, custom, 'compilation never rewrites custom templates');
});

test('compile current chat roles without leaking voice library names or unrelated cards', () => {
    const ctx = context();
    const before = structuredClone({ chat: ctx.chat, chatMetadata: ctx.chatMetadata, characters: ctx.characters });
    const result = sections(buildVoicePrompt(ctx, settings({ promptTemplate: sectionTemplate }), voices));
    assert.match(result.PRIMARY, /周启明/);
    assert.match(result.BOUND, /周启明/);
    assert.doesNotMatch(result.BOUND, /林知夏|沈予安|包子/);
    assert.match(result.UNBOUND, /林知夏/);
    assert.match(result.UNBOUND, /沈予安/);
    assert.doesNotMatch(result.UNBOUND, /包子/);
    assert.match(result.SKIPPED, /包子/);
    assert.doesNotMatch(result.SKIPPED, /林知夏|沈予安/);
    assert.match(result.USER, /包子/);
    const combined = Object.values(result).join('\n');
    assert.doesNotMatch(combined, /voice-1|voice-2|PRIVATE_LIBRARY_NAME|无关角色/);
    assert.deepEqual({ chat: ctx.chat, chatMetadata: ctx.chatMetadata, characters: ctx.characters }, before);
});

test('fresh mappings immediately affect injected role lists, including deleted voice IDs', () => {
    const ctx = context();
    const cfg = settings({ promptTemplate: sectionTemplate });
    ctx.chatMetadata[KEY].mappings.林知夏 = 'voice-2';
    let result = sections(buildVoicePrompt(ctx, cfg, voices));
    assert.match(result.BOUND, /林知夏/);
    assert.doesNotMatch(result.UNBOUND, /林知夏/);
    ctx.chatMetadata[KEY].mappings.周启明 = 'deleted-voice';
    result = sections(buildVoicePrompt(ctx, cfg, voices));
    assert.doesNotMatch(result.BOUND, /周启明/);
    assert.match(result.UNBOUND, /周启明/);
    assert.doesNotMatch(Object.values(result).join('\n'), /deleted-voice/);
});

test('unbound and null mappings stay discoverable, including manually entered characters', () => {
    const ctx = context();
    ctx.chatMetadata[KEY].mappings.新角色 = null;
    ctx.chatMetadata[KEY].mappings.包子 = 'voice-1';
    const result = sections(buildVoicePrompt(ctx, settings({ promptTemplate: sectionTemplate }), []));
    for (const name of ['周启明', '林知夏', '沈予安', '新角色']) assert.ok(result.UNBOUND.includes(name));
    assert.doesNotMatch(result.SKIPPED, /周启明|林知夏|沈予安|新角色/);
});

test('group members are named while unrelated library/card characters remain absent', () => {
    const ctx = context({ groupId: 'group', groups: [{ id: 'group', members: ['zhou.png', 'lin.png'] }] });
    ctx.characters.push({ name: '群聊成员', avatar: 'lin.png' });
    const result = buildVoicePrompt(ctx, settings({ promptTemplate: sectionTemplate }), voices);
    assert.match(result, /群聊成员/);
    assert.doesNotMatch(result, /无关角色|PRIVATE_LIBRARY_NAME/);
});

test('custom ST macros stay intact; dynamic names cannot become ST macros or replacement patterns', () => {
    const name = `Name $& $' $$ {{char}}`;
    const ctx = context({ name2: name, characters: [{ name, avatar: 'safe.png' }], chat: [] });
    ctx.chatMetadata[KEY] = { mappings: { [name]: 'voice-1' }, manual: [] };
    const cfg = settings({ promptTemplate: '{{bound_characters_section}}\n{{bound_characters_section}}\n{{getvar::gs-w2g}}\n{{unknown_custom_slot}}' });
    const text = buildVoicePrompt(ctx, cfg, voices);
    assert.ok(text.includes(`Name $& $' $$`));
    assert.equal(text.split(`Name $& $' $$`).length - 1, 2);
    assert.doesNotMatch(text, /\{\{char\}\}/);
    assert.ok(text.includes('{{getvar::gs-w2g}}'));
    assert.ok(text.includes('{{unknown_custom_slot}}'));
    assert.ok(text.includes('"Name '), 'dynamic names are JSON strings');
    assert.doesNotMatch(text, /\{\{bound_characters_section\}\}/);
});

test('registering the same key replaces it without modifying TGbreak or other extension prompts', () => {
    const ctx = context();
    const originals = structuredClone(ctx.extensionPrompts);
    const first = syncVoicePrompt(ctx, settings(), voices);
    assert.equal(first.active, true);
    assert.ok(first.text);
    assert.deepEqual(ctx.calls.at(-1), [PROMPT_KEY, first.text, 1, 1, false, 0]);
    const second = syncVoicePrompt(ctx, settings({ promptTemplate: 'replacement template' }), voices);
    assert.equal(second.active, true);
    assert.equal(ctx.extensionPrompts[PROMPT_KEY].value, 'replacement template');
    assert.deepEqual(Object.keys(ctx.extensionPrompts).sort(), [...Object.keys(originals), PROMPT_KEY].sort());
    for (const [key, original] of Object.entries(originals)) assert.deepEqual(ctx.extensionPrompts[key], original);
});

test('disabled, quiet, and impersonation requests clear only own key and next normal restores it', () => {
    const ctx = context();
    const scenarios = [
        [settings({ enabled: false }), null],
        [settings({ injectPrompt: false }), null],
        [settings(), 'quiet'],
        [settings(), 'impersonate'],
    ];
    for (const [cfg, type] of scenarios) {
        assert.equal(syncVoicePrompt(ctx, settings(), voices).active, true);
        const result = syncVoicePrompt(ctx, cfg, voices, type);
        assert.equal(result.active, false);
        assert.equal(ctx.extensionPrompts[PROMPT_KEY].value, '');
        assert.equal(ctx.extensionPrompts.tg_break_format.value, 'ORIGINAL_TG_FORMAT');
        assert.equal(ctx.extensionPrompts.catsay.value, 'ORIGINAL_CATSAY');
        assert.equal(syncVoicePrompt(ctx, settings(), voices, 'normal').active, true);
        assert.ok(ctx.extensionPrompts[PROMPT_KEY].value);
    }
});

test('each generation reinstalls after ST replaces registry, and chat switch uses new metadata', () => {
    const ctx = context();
    const first = syncVoicePrompt(ctx, settings(), voices);
    ctx.extensionPrompts = {};
    const restored = syncVoicePrompt(ctx, settings(), voices);
    assert.equal(restored.text, first.text);
    assert.equal(ctx.extensionPrompts[PROMPT_KEY].value, first.text);
    assert.equal(ctx.calls.length, 2);
    const next = context({ chatId: 'other-chat', name2: '陈晓', characters: [{ name: '陈晓', avatar: 'chen.png' }], chat: [], chatMetadata: {} });
    const result = syncVoicePrompt(next, settings({ promptTemplate: sectionTemplate }), voices);
    assert.equal(result.active, true);
    assert.match(result.text, /陈晓/);
    assert.doesNotMatch(result.text, /周启明|林知夏|沈予安/);
});

test('no active chat compiles empty and clears stale injection', () => {
    const ctx = context();
    syncVoicePrompt(ctx, settings(), voices);
    ctx.chatId = undefined;
    assert.equal(buildVoicePrompt(ctx, settings(), voices), '');
    const result = syncVoicePrompt(ctx, settings(), voices);
    assert.equal(result.active, false);
    assert.equal(ctx.extensionPrompts[PROMPT_KEY].value, '');
});

test('depth is validated while zero and boundary depth remain supported', () => {
    for (const depth of [0, 1, 100]) {
        const ctx = context();
        syncVoicePrompt(ctx, settings({ promptDepth: depth }), voices);
        assert.equal(ctx.calls.at(-1)[3], depth);
    }
    for (const depth of [-1, 101, 0.5, NaN, Infinity, undefined, null, 'bad']) {
        const ctx = context();
        syncVoicePrompt(ctx, settings({ promptDepth: depth }), voices);
        assert.equal(ctx.calls.at(-1)[3], 1);
    }
});

test('missing API or setter failure is reported without crashing generation', () => {
    const ctx = context();
    delete ctx.setExtensionPrompt;
    const missing = syncVoicePrompt(ctx, settings(), voices);
    assert.equal(missing.active, false);
    assert.ok(missing.reason);
    ctx.setExtensionPrompt = () => { throw new Error('registration failed'); };
    const failed = syncVoicePrompt(ctx, settings(), voices);
    assert.equal(failed.active, false);
    assert.ok(failed.reason);
});
