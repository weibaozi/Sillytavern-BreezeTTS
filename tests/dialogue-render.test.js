import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTTS } from '../extension/core.js';
import { displayDialogue, hasLegacyDialogue } from '../extension/dialogue-render.js';

function legacy(raw, ordinal = 0, events = '') {
    const segments = parseTTS(raw).segments;
    return hasLegacyDialogue(raw, segments[ordinal], segments[ordinal - 1]?.end ?? 0, events);
}

test('display hides configured and historical vocal events but preserves unknown bracketed content', () => {
    assert.equal(displayDialogue('[笑]你好。[自定义吸气]再见。[叹气]', '[自定义吸气]'), '你好。再见。');
    assert.equal(displayDialogue('[咳嗽][清嗓子]你好。[低笑][章节一]', ''), '你好。[低笑][章节一]');
    assert.equal(displayDialogue('[带有[笑]的文字] [笑] [未闭合', ''), '[带有[笑]的文字]  [未闭合');
    assert.equal(displayDialogue('看看[音效.*]和[音效其他]。', '[音效.*]'), '看看和[音效其他]。');
    assert.equal(displayDialogue('[自定义吸气]你好。', ''), '[自定义吸气]你好。');
});

test('display hides built-in English event syntax without removing ordinary parentheses or nested groups', () => {
    const roundEvents = ['laugh', 'giggle', 'chuckle', 'sigh', 'cough', 'clears throat', 'sniff', 'gasp', 'breath', 'cry', 'yawn'];
    const squareEvents = ['soft gasps', 'gasps', 'breathy sigh', 'soft moan', 'whimper', 'needy moan', 'breathy pant',
        'low whimper', 'shaky gasp', 'low moan', 'husky sigh', 'deep pant', 'throaty hum'];
    assert.equal(displayDialogue(roundEvents.map(event => `(${event})`).join('') + '你好。' + squareEvents.map(event => `[${event}]`).join(''), ''), '你好。');
    assert.equal(displayDialogue('(laugh)你好(约 5 分钟)。[soft gasps](未指定事件)[章节一]', ''), '你好(约 5 分钟)。(未指定事件)[章节一]');
    const nested = '[带有(laugh)的文字] (说明[soft gasps]) ((laugh)) [(laugh)] ([笑])';
    assert.equal(displayDialogue(nested, ''), nested);
    assert.equal(displayDialogue('(custom event)你好。[custom event](普通括注)', '(custom event)\n[custom event]'), '你好。(普通括注)');
    assert.equal(displayDialogue('(laugh.*)你好。(laugh any)', '(laugh.*)'), '你好。(laugh any)');
});

test('streaming hides only unfinished trailing prefixes of permitted round events', () => {
    for (const suffix of ['(', '(gas', '(gasp', '(clears thr']) {
        assert.equal(displayDialogue(`你好${suffix}`, '', { streaming: true }), '你好', suffix);
        assert.equal(displayDialogue(`你好${suffix}`, ''), `你好${suffix}`, suffix);
    }
    assert.equal(displayDialogue('你好(约5', '', { streaming: true }), '你好(约5');
    assert.equal(displayDialogue('你好(普通(gas', '', { streaming: true }), '你好(普通(gas');
    assert.equal(displayDialogue('你好[说明(gas', '', { streaming: true }), '你好[说明(gas');
    assert.equal(displayDialogue('你好(gas)后面还有内容', '', { streaming: true }), '你好(gas)后面还有内容');
    assert.equal(displayDialogue('你好[soft gas', '', { streaming: true }), '你好[soft gas');
    assert.equal(displayDialogue('你好(custom ev', '(custom event)', { streaming: true }), '你好');
    assert.equal(displayDialogue('你好(custom ev', '', { streaming: true }), '你好(custom ev');
    assert.equal(displayDialogue('(gasp)你好[soft gasps]。', '', { streaming: true }), '你好。');
});

test('display returns full literal text, removes one outer quote pair, and handles only audible events', () => {
    const literal = '<img src=x onerror="alert(1)"> & <script>bad()</script>';
    assert.equal(displayDialogue(literal, ''), literal);
    const long = '这句话很长。'.repeat(80);
    assert.equal(displayDialogue(`[笑]${long}`, ''), long);
    assert.equal(displayDialogue('[笑]“「你好。」”[叹气]', ''), '「你好。」');
    assert.equal(displayDialogue('"你好。"', ''), '你好。');
    assert.equal(displayDialogue('“你好。”和“再见。”', ''), '“你好。”和“再见。”');
    assert.equal(displayDialogue('“他说：\"你好。\"”', ''), '他说："你好。"');
    assert.equal(displayDialogue('[笑][自定义吸气]', '[自定义吸气]'), '');
    assert.equal(displayDialogue('', ''), '');
});

test('legacy matches all quotes in one adjacent prose paragraph with original punctuation', () => {
    assert.equal(legacy('周启明抬手。“等一下。”他合上本子。“现在可以了。”\n[TTSVoice:周启明:happy:[笑]等一下。现在可以了。]'), true);
    assert.equal(legacy('**他笑道：“你好！”**\n[TTSVoice:A:happy:你好！]'), true);
    assert.equal(legacy('She said, "Hello   there."\n[TTSVoice:A:happy:Hello there.]'), true);
    assert.equal(legacy('他说：“这是‘重点’。”\n[TTSVoice:A:happy:这是‘重点’。]'), true);
    assert.equal(legacy('她说：「你好。」\n[TTSVoice:A:happy:你好。]'), true);
});

test('legacy requires the whole adjacent quotation content, never a substring or previous paragraph', () => {
    assert.equal(legacy('“你好。”又说：“再见。”\n[TTSVoice:A:happy:你好。]'), false);
    assert.equal(legacy('“你好。”\n\n他看向窗外。\n[TTSVoice:A:happy:你好。]'), false);
    assert.equal(legacy('“你好。”\n\n[TTSVoice:A:happy:你好。]'), false);
    assert.equal(legacy('“你好？”\n[TTSVoice:A:happy:你好。]'), false);
    assert.equal(legacy('“ice cream”\n[TTSVoice:A:happy:icecream]'), false);
    assert.equal(legacy('他谈起你好这两个字。\n[TTSVoice:A:happy:你好]'), false);
});

test('consecutive repeated tags remain separate dialogue; previous tags never act as prose quotes', () => {
    const newOnly = '[TTSVoice:A:happy:你好。]\n[TTSVoice:A:happy:你好。]';
    assert.equal(legacy(newOnly, 0), false);
    assert.equal(legacy(newOnly, 1), false);
    const mixed = '“你好。”\n[TTSVoice:A:happy:你好。]\n[TTSVoice:A:happy:你好。]';
    assert.equal(legacy(mixed, 0), true);
    assert.equal(legacy(mixed, 1), false);
    const quotedTag = '[TTSVoice:A:happy:“你好。”]\n[TTSVoice:A:happy:你好。]';
    assert.equal(legacy(quotedTag, 1), false);
    const raw = '[TTSVoice:{{user}}:happy:“你好。”]\n[TTSVoice:A:happy:你好。]';
    assert.equal(legacy(raw, 0), false);
});

test('legacy handles configured event-only additions conservatively and refuses excluded markup', () => {
    assert.equal(legacy('“你好。”\n[TTSVoice:A:happy:[自定义吸气]你好。]', 0, '[自定义吸气]'), true);
    assert.equal(legacy('“你好。”\n[TTSVoice:A:happy:[自定义吸气]你好。]'), false);
    assert.equal(legacy('“[章节一]你好。”\n[TTSVoice:A:happy:[章节一]你好。]'), true);
    assert.equal(legacy('<catsay>“你好。”</catsay>\n[TTSVoice:A:happy:你好。]'), false);
    assert.equal(legacy('`“你好。”`\n[TTSVoice:A:happy:你好。]'), false);
    assert.equal(legacy('“你好。\n[TTSVoice:A:happy:你好。]'), false);
    assert.equal(legacy('“”\n[TTSVoice:A:happy:[笑]]'), false);
    assert.equal(hasLegacyDialogue('“你好。”', { start: 100, text: '你好。' }, 0, ''), false);
    assert.equal(legacy('“你好。”\n[TTSVoice:A:happy:(laugh)[soft gasps]你好。]'), true);
    assert.equal(legacy('“(custom event)你好。”\n[TTSVoice:A:happy:你好。]', 0, '(custom event)'), true);
    assert.equal(legacy('“你好(约5分钟)。”\n[TTSVoice:A:happy:你好。]'), false);
});
