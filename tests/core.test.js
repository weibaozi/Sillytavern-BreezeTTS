import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTTS, discoverSpeakers, chatKey, mappedVoice, cacheKey, requestFor, normalizeBase, DEFAULTS } from '../extension/core.js';

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
test('service URL rejects credentials and non-HTTP schemes', () => {
    assert.equal(normalizeBase('http://localhost:7860/'), 'http://localhost:7860');
    assert.throws(() => normalizeBase('javascript:alert(1)'));
    assert.throws(() => normalizeBase('https://user:pass@host/'));
});
