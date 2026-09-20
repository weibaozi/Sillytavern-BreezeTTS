import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTTS } from '../extension/core.js';
import { displayDialogue, hasLegacyDialogue } from '../extension/dialogue-render.js';

function legacy(raw, ordinal = 0, events = '') {
    const segments = parseTTS(raw).segments;
    return hasLegacyDialogue(raw, segments[ordinal], segments[ordinal - 1]?.end ?? 0, events);
}

test('display hides configured and historical vocal events but preserves unknown bracketed content', () => {
    assert.equal(displayDialogue('[笑]你好。[吸气]再见。[叹气]', '[吸气]'), '你好。再见。');
    assert.equal(displayDialogue('[咳嗽][清嗓子]你好。[低笑][章节一]', ''), '你好。[低笑][章节一]');
    assert.equal(displayDialogue('[带有[笑]的文字] [笑] [未闭合', ''), '[带有[笑]的文字]  [未闭合');
    assert.equal(displayDialogue('看看[音效.*]和[音效其他]。', '[音效.*]'), '看看和[音效其他]。');
    assert.equal(displayDialogue('[吸气]你好。', ''), '[吸气]你好。');
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
    assert.equal(displayDialogue('[笑][吸气]', '[吸气]'), '');
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
    assert.equal(legacy('“你好。”\n[TTSVoice:A:happy:[吸气]你好。]', 0, '[吸气]'), true);
    assert.equal(legacy('“你好。”\n[TTSVoice:A:happy:[吸气]你好。]'), false);
    assert.equal(legacy('“[章节一]你好。”\n[TTSVoice:A:happy:[章节一]你好。]'), true);
    assert.equal(legacy('<catsay>“你好。”</catsay>\n[TTSVoice:A:happy:你好。]'), false);
    assert.equal(legacy('`“你好。”`\n[TTSVoice:A:happy:你好。]'), false);
    assert.equal(legacy('“你好。\n[TTSVoice:A:happy:你好。]'), false);
    assert.equal(legacy('“”\n[TTSVoice:A:happy:[笑]]'), false);
    assert.equal(hasLegacyDialogue('“你好。”', { start: 100, text: '你好。' }, 0, ''), false);
});
