import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTTS, parseStreamingTTS, discoverSpeakers, chatKey, mappedVoice, cacheKey, requestFor, normalizeBase, DEFAULTS } from '../core.js';

test('nested vocal tags, colons and repeated passages remain intact', () => {
    const raw = '“走吧。”\n[TTSVoice:周启明:开心:[笑]走吧。时间是：12:30。[叹气]]\n[TTSVoice：周启明：：走吧。]';
    const result = parseTTS(raw, '包子');
    assert.equal(result.segments.length, 2);
    assert.equal(result.segments[0].text, '[笑]走吧。时间是：12:30。[叹气]');
    assert.equal(result.segments[1].emotion, 'default');
    for (const s of result.segments) assert.equal(raw.slice(s.start, s.end), s.raw);
});
test('exclude user, code, comments, non-body modules and nested summary', () => {
    const tag = '[TTSVoice:A:自然:你好]';
    const raw = `${tag}\n[TTSVoice:包子:自然:我]\n\`\`\`text\n${tag}\n\`\`\`\n<!-- ${tag} -->\n<w2g>${tag}</w2g>\n<catsay><details>${tag}</details></catsay>\n<details><summary>摘要</summary>${tag}</details>\n<!-- 3.正文后的格式 -->${tag}`;
    assert.equal(parseTTS(raw, '包子').segments.length, 1);
});
test('malformed tag does not swallow the next valid one; empty and multiline skipped', () => {
    const result = parseTTS('[TTSVoice:A:happy:坏[笑]\n[TTSVoice:B:自然:正确]\n[TTSVoice:C:自然:]\n[TTSVoice:D:自然:跨\n行]');
    assert.deepEqual(result.segments.map(s => s.speaker), ['B']);
    assert.equal(result.diagnostics.length, 3);
});
test('unknown vocal event is not hard-coded away', () => {
    assert.equal(parseTTS('[TTSVoice:A:自然:[轻笑]你好[喘息]]').segments[0].text, '[轻笑]你好[喘息]');
});

test('inline Markdown code is excluded with offsets preserved, including matching multi-backtick delimiters', () => {
    const tag = '[TTSVoice:A:自然:你好]';
    const raw = `\`${tag}\`\n\`\`example \` ${tag}\`\`\n${tag}`;
    const segments = parseTTS(raw).segments;
    assert.equal(segments.length, 1);
    assert.equal(segments[0].start, raw.lastIndexOf(tag));
    assert.equal(raw.slice(segments[0].start, segments[0].end), tag);
    assert.equal(parseTTS(`\`unclosed ${tag}`).segments.length, 1);
    assert.equal(parseTTS(`\\\`${tag}\\\``).segments.length, 1, 'escaped backticks are ordinary prose');
});
test('speaker discovery: card, group, tagged NPC, manual; no user or system roles', () => {
    const ctx = { name1: '包子', characterId: 0, characters: [{ name: '周启明', avatar: 'a.png' }, { name: '林知夏', avatar: 'b.png' }],
        chat: [{ mes: '[TTSVoice:沈予安:自然:你好]' }, { mes: '[TTSVoice:包子:自然:好]' }, { is_user: true, mes: '[TTSVoice:假角色:自然:好]' }, { is_system: true, mes: '[TTSVoice:系统角色:自然:好]' }] };
    assert.deepEqual(new Set(discoverSpeakers(ctx, ['林知夏'])), new Set(['周启明', '林知夏', '沈予安']));
    ctx.groupId = 'g'; ctx.groups = [{ id: 'g', members: ['a.png', 'b.png'] }];
    assert.equal(discoverSpeakers(ctx).length, 3);
});
test('mapping requires explicit valid ID and chat keys do not collide', () => {
    const voices = [{ id: 'v1', name: '周启明' }];
    assert.equal(mappedVoice({}, '周启明', voices), null);
    assert.equal(mappedVoice({ A: 'missing' }, 'A', voices), null);
    assert.equal(mappedVoice({ A: 'v1', B: 'v1' }, 'B', voices), 'v1');
    assert.equal(mappedVoice({}, '__proto__', voices), null);
    assert.notEqual(chatKey({ chatId: 'same', characterId: 0 }), chatKey({ chatId: 'same', characterId: 1 }));
    assert.equal(chatKey({}), '');
});
test('cache identity includes voice, emotion, parameters and service', () => {
    const s = { text: '[笑]你好', emotion: 'New' };
    const a = requestFor(s, 'v1', DEFAULTS); assert.equal(a.emotion, 'default');
    assert.notEqual(cacheKey('http://localhost', a), cacheKey('http://localhost', requestFor(s, 'v2', DEFAULTS)));
    assert.notEqual(cacheKey('http://localhost', a), cacheKey('http://other', a));
    assert.notEqual(cacheKey('http://localhost', a), cacheKey('http://localhost', requestFor(s, 'v1', { ...DEFAULTS, seed: 43 })));
});
test('clone narration strips direction guidance, fixes CFG, and cannot reuse direction audio', () => {
    const settings = { ...DEFAULTS, cfgScale: 3, seed: 92 };
    const segment = { kind: 'narration', text: '阳光照进教室。', emotion: '温柔沉静', speechMode: 'clone' };
    const clone = requestFor(segment, 'narrator', settings);
    const direction = requestFor({ ...segment, speechMode: 'direction' }, 'narrator', settings);
    assert.equal(clone.speech_mode, 'clone');
    assert.equal(clone.emotion, '');
    assert.equal(clone.cfg_scale, 1);
    assert.equal(clone.seed, 92);
    assert.equal(direction.emotion, segment.emotion);
    assert.equal(direction.cfg_scale, 3);
    assert.notEqual(cacheKey('http://localhost', clone), cacheKey('http://localhost', direction));
    const neutralDirection = requestFor({ ...segment, speechMode: 'direction', emotion: '' }, 'narrator', { ...settings, cfgScale: 1 });
    assert.notEqual(cacheKey('http://localhost', clone), cacheKey('http://localhost', neutralDirection));
});
test('narration clone settings never change character dialogue requests', () => {
    const settings = { ...DEFAULTS, cfgScale: 2.5 };
    const dialogue = { text: '我来带路。', emotion: 'softly reassuring' };
    const expected = requestFor(dialogue, 'character', settings);
    assert.deepEqual(requestFor({ ...dialogue, speechMode: 'clone' }, 'character', settings), expected);
    assert.equal(expected.emotion, 'softly reassuring');
    assert.equal(expected.cfg_scale, 2.5);
    assert.notEqual(expected.speech_mode, 'clone');
});
test('service URL rejects credentials and non-HTTP schemes', () => {
    assert.equal(normalizeBase('http://localhost:7860/'), 'http://localhost:7860');
    assert.throws(() => normalizeBase('javascript:alert(1)'));
    assert.throws(() => normalizeBase('https://user:pass@host/'));
});

test('streaming header fragments are quiet, bounded display-only spans', () => {
    assert.equal(DEFAULTS.readStreamingText, false);
    for (const fragment of ['[T', '[TT', '[TTSVo', '[ttsvoice', '[TTSVoice ', '[TTSVoice:', '[TTSVoice:周启明', '[TTSVoice:周启明:', '[TTSVoice:周启明:happy:']) {
        const raw = `旁白。\n  ${fragment}`;
        const result = parseStreamingTTS(raw);
        assert.deepEqual(result.segments, [], fragment);
        assert.deepEqual(result.diagnostics, [], fragment);
        assert.equal(result.pending.length, 1, fragment);
        assert.equal(result.pending[0].raw, fragment);
        assert.equal(raw.slice(result.pending[0].start, result.pending[0].end), fragment);
        assert.equal(result.pending[0].text, '');
    }
    for (const ordinary of ['[', '[Today', '正文 [TTSVo', '[TTS Voice', '[TTSVoiceX']) {
        assert.deepEqual(parseStreamingTTS(ordinary).pending, [], ordinary);
    }
});

test('streaming exposes speech after metadata and hides only unfinished inner brackets', () => {
    const raw = '他转过头。[tTsVoIcE：周启明：：时间是：12:30。[笑]走吧[叹';
    const result = parseStreamingTTS(raw);
    assert.deepEqual(result.segments, []);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.pending.length, 1);
    assert.equal(result.pending[0].speaker, '周启明');
    assert.equal(result.pending[0].emotion, 'default');
    assert.equal(result.pending[0].text, '时间是：12:30。[笑]走吧');
    assert.equal(parseStreamingTTS('[TTSVoice:A:happy:你好[未识别[嵌套]').pending[0].text, '你好');
    assert.equal(parseStreamingTTS('[TTSVoice:A:happy:[笑]你好').pending[0].text, '[笑]你好');
});

test('stream completion hands off exactly once to ordinary parsing and retains repeated speech', () => {
    const tag = '[TTSVoice:周启明:happy:[笑]走吧。]';
    const prefix = `${tag}\n${tag}\n`;
    const pending = parseStreamingTTS(`${prefix}${tag.slice(0, -1)}`);
    assert.equal(pending.segments.length, 2);
    assert.equal(pending.pending.length, 1);
    const raw = `${prefix}${tag}`;
    const complete = parseStreamingTTS(raw);
    assert.deepEqual(complete.segments, parseTTS(raw).segments);
    assert.deepEqual(complete.pending, []);
    assert.deepEqual(complete.diagnostics, []);
    assert.deepEqual(complete.segments.map(segment => segment.ordinal), [0, 1, 2]);
    for (const segment of complete.segments) assert.equal(raw.slice(segment.start, segment.end), segment.raw);
});

test('streaming respects user, code, comments and unfinished non-body exclusions', () => {
    const pending = '[TTSVoice:A:happy:你好';
    for (const raw of [
        `[TTSVoice:包子:happy:你好`, '[TTSVoice:{{user}}:happy:你好',
        `\`\`\`text\n${pending}`, `~~~text\n${pending}`, `<!-- ${pending}`,
        `<w2g>${pending}`, `<catsay><details>${pending}`, `<code>${pending}`,
        `<!-- 3.正文后的格式 -->\n${pending}`, `\`${pending}`, `\`\`example \` ${pending}`,
    ]) {
        assert.deepEqual(parseStreamingTTS(raw, '包子').pending, [], raw);
        assert.deepEqual(parseStreamingTTS(raw, '包子').segments, [], raw);
    }
    const raw = `\`${pending}\`\n${pending}`;
    assert.equal(parseStreamingTTS(raw).pending[0].start, raw.lastIndexOf(pending));
    assert.equal(parseStreamingTTS(`\\\`${pending}`).pending.length, 1, 'escaped backtick does not open code');
});

test('streaming recovers after malformed earlier tags without claiming later narration', () => {
    const raw = '[TTSVoice:A:happy:坏[笑]\n普通旁白。\n[TTSVoice:B:happy:完整]\n[TTSVoice:C:default:继续[叹';
    const result = parseStreamingTTS(raw);
    assert.deepEqual(result.segments.map(segment => segment.speaker), ['B']);
    assert.equal(result.pending[0].speaker, 'C');
    assert.equal(result.pending[0].text, '继续');
    assert.equal(result.pending[0].raw, '[TTSVoice:C:default:继续[叹');
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].offset, 0);
    assert.deepEqual(parseStreamingTTS('[TTSVoice:A:happy:坏\n接下来是旁白。').pending, []);
    assert.deepEqual(parseStreamingTTS('[TTSVoice:A:happy:跨\n行]').pending, []);
    for (const invalid of ['[TTSVoice::happy:未闭合', '[TTSVoice:A:[happy:未闭合', '[TTSVoice:A:happy:]']) {
        const result = parseStreamingTTS(invalid);
        assert.deepEqual(result.pending, [], invalid);
        assert.equal(result.diagnostics.length, 1, invalid);
    }
    const restarted = parseStreamingTTS('[TTSVoice:A:happy:坏[TTSVoice:B:default:正确');
    assert.equal(restarted.pending.length, 1);
    assert.equal(restarted.pending[0].speaker, 'B');
    assert.equal(restarted.diagnostics.length, 1);
});
