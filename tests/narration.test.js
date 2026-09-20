import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNarration, DEFAULT_NARRATION_TARGET_CHARS, normalizeNarrationTargetChars } from '../extension/narration.js';
import { parseTTS } from '../extension/core.js';

const texts = (raw, streaming = false) => parseNarration(raw, '包子', { streaming }).map(s => s.text);

test('narration interleaves with single-copy dialogue by original offsets', () => {
    const raw = '**阳光照进大厅。**\n[TTSVoice:周启明:happy:[笑]走吧。]\n他拍了拍胃。\n[TTSVoice:林知夏:default:好。]\n几个人一起走远了。';
    const narration = parseNarration(raw);
    assert.deepEqual(narration.map(s => s.text), ['阳光照进大厅。', '他拍了拍胃。', '几个人一起走远了。']);
    assert.deepEqual([...narration, ...parseTTS(raw).segments].sort((a, b) => a.start - b.start).map(s => s.speaker),
        ['旁白', '周启明', '旁白', '林知夏', '旁白']);
    for (const segment of narration) {
        assert.equal(segment.kind, 'narration');
        assert.equal(segment.raw, raw.slice(segment.start, segment.end));
    }
});

test('ordinary quoted text is narration while every TTS tag remains excluded', () => {
    const raw = '他抬起头。“走吧。”\n[TTSVoice:A:happy:走吧。]\n包子说："等一下。"\n她答道：‘好的。’ 然后转身。\n「明天见。」\n『再见。』\n[TTSVoice:包子:default:用户对白。]\n[TTSVoice:{{user}}:default:用户对白。]';
    assert.deepEqual(texts(raw), ['他抬起头。“走吧。”', '包子说："等一下。" 她答道：‘好的。’ 然后转身。 「明天见。」 『再见。』']);
});

test('English quotations and apostrophes remain ordinary prose', () => {
    const raw = "The student's notebook isn't here. He said 'Don't do that!' and left. It’s late.";
    assert.deepEqual(texts(raw), [raw]);
});

test('body markers exclude before/after modules and previous AI transcript', () => {
    const raw = '<ai_last_output>上一条完整回复。<w2g>选项。</w2g></ai_last_output>\n<!-- 1.正文前的格式 -->前置文字。\n<!-- 2.正文 -->\n当前正文。\n<!-- 3.正文后的格式 -->后置文字。';
    assert.deepEqual(texts(raw), ['当前正文。']);
    assert.deepEqual(texts('<ai_last_output>之前的对白。\n之前的旁白。</ai_last_output>现在的正文。'), ['现在的正文。']);
    assert.deepEqual(texts('<!-- 1.正文前的格式 -->前置文字。', true), []);
});

test('nested modules, unfinished modules, comments and code do not become narration', () => {
    const raw = '正文。<w2g>选项。</w2g><catsay><details><summary>标题。</summary>吐槽。</details></catsay>' +
        '<thinking>思考。</thinking><status>状态。</status><statusbar>状态栏。</statusbar><options>选项。</options>' +
        '<script>alert("hello")</script><style>body{}</style><pre>代码。</pre><code>代码。</code>' +
        '<blockquote>引用。</blockquote><q>对白。</q><!-- 注释。 -->\n```text\n代码。\n```\n`行内。`\n``内含 ` 的代码。``\n尾声。';
    assert.deepEqual(texts(raw), ['正文。', '引用。 对白。', '尾声。']);
    for (const suffix of ['<w2g>未完。', '<thinking>未完。', '<ai_last_output>回显。', '<!-- 注释。', '`行内未完。', '```text\n代码。']) {
        assert.deepEqual(texts(`正文。${suffix}`, true), ['正文。'], suffix);
        assert.deepEqual(texts(`正文。${suffix}`), ['正文。'], suffix);
    }
});

test('literal structure tags inside code and previous transcripts cannot control the current body', () => {
    for (const literal of ['<!-- 2.正文 -->', '<!-- 3.正文后的格式 -->', '<ai_last_output>']) {
        for (const code of [`\`${literal}\``, `\`\`\`text\n${literal}\n\`\`\``]) {
            const raw = `正文。\n${code}\n继续。`;
            assert.deepEqual(texts(raw), ['正文。', '继续。'], code);
            let committed = [];
            for (let end = 1; end <= raw.length; end++) {
                const next = parseNarration(raw.slice(0, end), '', { streaming: true });
                assert.deepEqual(next.slice(0, committed.length), committed, `prefix at ${end}: ${code}`);
                committed = next;
            }
        }
    }
    const echoed = '<ai_last_output><!-- 2.正文 -->之前的正文。<!-- 3.正文后的格式 -->之前的结尾。</ai_last_output>当前正文。';
    assert.deepEqual(texts(echoed), ['当前正文。']);
});

test('formatting and common/numeric HTML entities retain visible words without URLs or images', () => {
    const raw = '# 清晨\n**他**走向[图书馆](https://example.test/a_(b))。\n' +
        '![不朗读图片文字](https://example.test/img.png)\n<span class="orange">风 &amp; 雨&#x3002;</span><br>' +
        '温度为&#50;&#48;度。 https://example.test/url\n<img src="picture.png" alt="不念图片">\n1. 天色渐亮。';
    assert.deepEqual(texts(raw), ['清晨 他走向图书馆。', '风 & 雨。 温度为20度。', '天色渐亮。']);
});

test('Markdown quotations and reference labels stay visible but destinations and images remain silent', () => {
    assert.deepEqual(texts('旁白。\n> 被引用的台词。\n![图片][ref]\n[ref]: https://example.test/img.png\n尾声。'), ['旁白。 被引用的台词。', '尾声。']);
    assert.deepEqual(texts('他查看[学校地图][map]，然后离开。\n[map]: https://example.test/map'), ['他查看学校地图，然后离开。']);
    assert.equal(texts('查看https://example.test。然后离开。').join(''), '查看。然后离开。', 'removing a URL does not remove following prose punctuation');
});

test('entity-encoded quote delimiters retain all ordinary quoted content', () => {
    assert.deepEqual(texts('他说&quot;这句也要读。&quot;然后走了。'), ['他说"这句也要读。"然后走了。']);
    assert.deepEqual(texts('他说&#x201c;这句也要读。&#8221;然后走了。'), ['他说“这句也要读。”然后走了。']);
    assert.deepEqual(texts('The student&#39;s notebook isn&apos;t here.'), ["The student's notebook isn't here."]);
});

test('malformed, nested and incomplete voice tags never become narration', () => {
    for (const tag of ['[TTSVoice:A:happy:[笑]台词。]', '[ttsvoice:包子:happy:台词。]', '[TTS Voice:A:happy:台词。]',
        '[TTSVoice::happy:台词。]', '[TTSVoice:A:happy:台词。[未闭合]', '[TTSVoice:A:happy:跨\n行。]', '[TTSVo']) {
        assert.deepEqual(texts(`正文。\n${tag}`, true), tag === '[TTSVo' ? [] : ['正文。'], tag);
        assert.deepEqual(texts(`正文。\n${tag}`), ['正文。'], tag);
    }
    const raw = '[TTSVoice:A:happy:未闭合\n[TTSVoice:B:happy:完整。]\n真实旁白。';
    assert.deepEqual(texts(raw), ['真实旁白。']);
});

test('streaming groups short sentences across paragraphs and flushes speech boundaries', () => {
    assert.deepEqual(texts('他走进教室。她正低头', true), []);
    assert.deepEqual(texts('他走进教室。她正低头\n', true), []);
    assert.deepEqual(texts('他走进教室。她正低头'), ['他走进教室。她正低头']);
    assert.deepEqual(texts('他回头[TTSVoice:A:default:你好。]', true), ['他回头']);
});

test('pending HTML/link syntax cannot change previously committed narration', () => {
    for (const [prefix, suffix] of [
        ['他<b', '>抬头</b>。'], ['他[走向图书馆。', '](https://example.test)。'],
        ['他[看到了。]', '，然后离开。'], ['他[走向图书馆](https://ex', 'ample.test)。'],
    ]) {
        assert.deepEqual(texts(prefix, true), [], prefix);
        assert.ok(texts(prefix + suffix + '[TTSVoice:A:default:对白。]', true).length > 0, suffix);
    }
    assert.deepEqual(texts('他说“未说完。', true), []);
    assert.deepEqual(texts('他说“未说完。'), ['他说“未说完。']);
});

test('append-only streaming keeps every committed segment byte-for-byte stable', () => {
    const raw = '**他走进大厅。**\n他<em>转身</em>，指向[图书馆](https://example.test)。\n他[图书馆。][ref]继续走。\n' +
        '他看见![图片。](https://example.test/img.png)然后离开。\n他发现![图片。][ref]继续走。\n' +
        '[TTSVoice:A:happy:[笑]你好。]\n她回过头。“等一下。”\n温度是3.14度。\nThe student isn\'t ready.\n末尾半句';
    let committed = [];
    for (let end = 1; end <= raw.length; end++) {
        const next = parseNarration(raw.slice(0, end), '', { streaming: true });
        assert.deepEqual(next.slice(0, committed.length), committed, `prefix at ${end}: ${raw.slice(0, end)}`);
        committed = next;
    }
    const final = parseNarration(raw);
    assert.deepEqual(final.slice(0, committed.length), committed);
    assert.ok(final.at(-1).text.endsWith('末尾半句'));
});

test('streaming entity-quoted content stays ordinary narration without unstable partial entities', () => {
    const raw = '他说&quot;这句也要读。&quot;然后走了。';
    let committed = [];
    for (let end = 1; end <= raw.length; end++) {
        const next = parseNarration(raw.slice(0, end), '', { streaming: true });
        assert.deepEqual(next.slice(0, committed.length), committed, `prefix at ${end}`);
        committed = next;
    }
    assert.deepEqual(committed, []);
    assert.deepEqual(parseNarration(raw).map(s => s.text), ['他说"这句也要读。"然后走了。']);
});

test('target settings normalize finite numeric values and reject invalid input', () => {
    assert.equal(DEFAULT_NARRATION_TARGET_CHARS, 100);
    for (const value of [undefined, null, true, false, '', ' ', 'oops', Infinity, NaN, [], {}, Symbol('bad')]) {
        assert.equal(normalizeNarrationTargetChars(value), 100);
    }
    assert.equal(normalizeNarrationTargetChars('80'), 80);
    assert.equal(normalizeNarrationTargetChars(80.6), 81);
    assert.equal(normalizeNarrationTargetChars(5), 20);
    assert.equal(normalizeNarrationTargetChars(2000), 1000);
});

test('target chunks use the longest complete sentence sequence inside the target', () => {
    const sentences = ['甲', '乙', '丙', '丁'].map(char => char.repeat(29) + '。');
    const raw = sentences.join('');
    assert.deepEqual(texts(raw), [sentences.slice(0, 3).join(''), sentences[3]]);
    assert.deepEqual(parseNarration(raw, '', { targetChars: 60 }).map(s => s.text), [sentences[0] + sentences[1], sentences[2] + sentences[3]]);
    assert.deepEqual(parseNarration(raw, '', { targetChars: 'invalid' }), parseNarration(raw));
    assert.deepEqual(texts(sentences[0] + '\n' + sentences[1]), [sentences[0] + ' ' + sentences[1]]);
    assert.deepEqual(texts(sentences[0] + '[TTSVoice:A:default:对白。]' + sentences[1]), [sentences[0], sentences[1]]);
});

test('streaming waits until the following sentence cannot fit, then commits the prior boundary', () => {
    const first = '甲'.repeat(29) + '。' + '乙'.repeat(29) + '。' + '丙'.repeat(29) + '。';
    assert.deepEqual(texts(first, true), []);
    assert.deepEqual(texts(first + '丁'.repeat(10), true), []);
    assert.deepEqual(texts(first + '丁'.repeat(11), true), [first]);
    assert.deepEqual(texts(first + '丁'.repeat(29) + '。', true), [first]);
    const exact = '甲'.repeat(99) + '。';
    assert.deepEqual(texts(exact, true), [exact]);
});

test('an over-target sentence stays whole, while the existing hard limit still applies', () => {
    const long = '甲'.repeat(149) + '。';
    assert.deepEqual(texts(long.slice(0, -1), true), []);
    assert.deepEqual(texts(long, true), [long]);
    assert.deepEqual(texts(long + '短句。'), [long, '短句。']);
    const hard = '甲'.repeat(5100) + '。';
    assert.deepEqual(texts(hard).map(s => Array.from(s).length), [5000, 101]);
});

test('target counting uses spoken Unicode characters, not source markup or entity widths', () => {
    const first = '**' + '甲'.repeat(8) + '🙂&#x3002;**'; // Ten visible characters.
    const second = '<em>' + '乙'.repeat(9) + '。</em>'; // Ten visible characters.
    const third = '丙'.repeat(9) + '。';
    const segments = parseNarration(first + second + third, '', { targetChars: 20 });
    assert.deepEqual(segments.map(s => s.text), ['甲'.repeat(8) + '🙂。' + '乙'.repeat(9) + '。', third]);
    assert.equal(Array.from(segments[0].text).length, 20);
    for (const segment of segments) assert.equal(segment.raw, (first + second + third).slice(segment.start, segment.end));
    assert.ok(segments[0].end <= segments[1].start);
});

test('line breaks and HTML paragraph layout share one target counter without counting their separators', () => {
    const first = '甲'.repeat(49) + '。';
    const second = '乙'.repeat(49) + '。';
    const third = '丙'.repeat(29) + '。';
    for (const separator of ['\n', '\r\n\n', ' \n   ', '<br>', '</p><p>', '</div><div>', '\n> ', '\n\n## ']) {
        const raw = first + separator + second + separator + third;
        const result = parseNarration(raw);
        assert.deepEqual(result.map(s => s.text), [first + ' ' + second, third], separator);
        assert.equal(Array.from(result[0].text).length, 101, 'layout space is rendered but does not consume the 100-character target');
        assert.deepEqual(texts(first + separator, true), [], separator);
        assert.deepEqual(texts(first + separator + second, true), [first + ' ' + second], separator);
        for (const segment of result) assert.equal(segment.raw, raw.slice(segment.start, segment.end));
    }
    assert.deepEqual(texts('Hello\n\nworld.'), ['Hello world.'], 'English words retain a separator');
});

test('ordinary quote containers never remove visible body text or disturb the TTS boundary', () => {
    const raw = '他把这叫作“春天的气味”。\n<blockquote>里面是<q>普通引文</q>。</blockquote>\n' +
        '> 这不是角色对白。\n[TTSVoice:A:default:只有这句按角色播放。]\n然后他说"不管怎样"，事情已经过去。';
    const narration = parseNarration(raw);
    assert.deepEqual(narration.map(s => s.text), [
        '他把这叫作“春天的气味”。 里面是普通引文。 这不是角色对白。',
        '然后他说"不管怎样"，事情已经过去。',
    ]);
    const dialogue = parseTTS(raw).segments[0];
    assert.ok(narration[0].end <= dialogue.start);
    assert.ok(dialogue.end <= narration[1].start);
});

test('target-based streaming matches final parsing without overlap or revised committed chunks', () => {
    const prefix = '甲'.repeat(14) + '。';
    const cases = [
        prefix + '乙'.repeat(8) + '。' + '丙'.repeat(9) + '。末尾',
        prefix + '风 &amp; 雨。接着向前。',
        prefix + '走向[图书馆。](https://example.test)。接着向前。',
        prefix + '他看见![图片。](https://example.test/img.png)然后离开。',
        prefix + '查看https://example.test/url 后离开。',
        prefix + '温度3.14度。继续前行。',
        prefix + '他说&quot;不要读对白。&quot;然后离开。',
        prefix + '乙'.repeat(3) + '🙂。继续前行。',
        '甲'.repeat(19) + '！！连续标点后继续。',
        '甲'.repeat(19) + '!? 连续标点后继续。',
        prefix + '数值为3.14159，小数保留。下一句。',
        prefix + 'emoji &#x1F600; 和&amp;实体。下一句。',
        prefix + '查看http://example.test。然后离开。',
        prefix + '他[引用标签。][ref]然后离开。',
        prefix + '然后。\n下一段开始。',
        prefix + '\\\\路径继续。转身离开。',
        prefix + '\n乙'.repeat(2) + '。\n\n继续向前。再读下一句。',
        prefix + ' \n   然后。<br>下一段。</p><p>继续。',
        prefix + '<blockquote>引用了<q>普通文字</q>。</blockquote>继续。',
        prefix + '\n> 引用文字。\n>> 仍应朗读。接着向前。',
        prefix + '说到“普通引号里的说明”，他停了一下。下一句。',
        '甲'.repeat(9) + '。\n\n' + '乙'.repeat(9) + '。\n' + '丙'.repeat(9) + '。',
        prefix + ' \n' + '乙'.repeat(4) + '。后文。',
        prefix + ' <p>\n' + '乙'.repeat(4) + '。</p><p>后文。</p>',
        '“' + '甲'.repeat(18) + '。”\n接着读后文。',
    ];
    for (const raw of cases) {
        let committed = [];
        for (let end = 1; end <= raw.length; end++) {
            const next = parseNarration(raw.slice(0, end), '', { streaming: true, targetChars: 20 });
            assert.deepEqual(next.slice(0, committed.length), committed, `prefix at ${end}: ${raw.slice(0, end)}`);
            committed = next;
        }
        const final = parseNarration(raw, '', { targetChars: 20 });
        assert.deepEqual(final.slice(0, committed.length), committed);
        for (let i = 0; i < final.length; i++) {
            assert.equal(final[i].raw, raw.slice(final[i].start, final[i].end));
            if (i) assert.ok(final[i - 1].end <= final[i].start);
        }
    }
});

test('a surrogate pair cannot be split at the hard streaming boundary', () => {
    const raw = '甲'.repeat(4999) + '🙂尾声';
    assert.deepEqual(parseNarration(raw.slice(0, 5000), '', { streaming: true }), []);
    const first = parseNarration(raw.slice(0, 5001), '', { streaming: true });
    assert.equal(first.length, 1);
    assert.equal(Array.from(first[0].text).length, 5000);
    assert.ok(first[0].text.endsWith('🙂'));
    assert.deepEqual(parseNarration(raw).slice(0, 1), first);
});

test('long unpunctuated prose is split within request limits with stable source IDs', () => {
    const raw = '旁白'.repeat(3500) + '末尾';
    const first = parseNarration(raw.slice(0, 5500), '', { streaming: true });
    assert.equal(first.length, 1);
    assert.equal(first[0].text.length, 5000);
    const final = parseNarration(raw);
    assert.deepEqual(final[0], first[0]);
    assert.ok(final.every(s => s.text && s.text.length <= 6000));
    assert.equal(final.map(s => s.text).join(''), raw);
});
