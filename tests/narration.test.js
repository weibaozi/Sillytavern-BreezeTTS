import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNarration } from '../extension/narration.js';
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

test('quoted legacy/user/skipped dialogue is never read as narration', () => {
    const raw = '他抬起头。“走吧。”\n[TTSVoice:A:happy:走吧。]\n包子说："等一下。"\n她答道：‘好的。’ 然后转身。\n「明天见。」\n『再见。』\n[TTSVoice:包子:default:用户对白。]\n[TTSVoice:{{user}}:default:用户对白。]';
    assert.deepEqual(texts(raw), ['他抬起头。', '包子说：', '她答道：', '然后转身。']);
});

test('English apostrophes remain prose and contractions inside speech stay excluded', () => {
    const raw = "The student's notebook isn't here. He said 'Don't do that!' and left. It’s late.";
    assert.deepEqual(texts(raw), ["The student's notebook isn't here.", 'He said', 'and left.', 'It’s late.']);
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
    assert.deepEqual(texts(raw), ['正文。', '尾声。']);
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
        '温度为&#50;&#48;度。 https://example.test/url。\n<img src="picture.png" alt="不念图片">\n1. 天色渐亮。';
    assert.deepEqual(texts(raw), ['清晨', '他走向图书馆。', '风 & 雨。', '温度为20度。', '天色渐亮。']);
});

test('Markdown reference media and block quotations are silent', () => {
    assert.deepEqual(texts('旁白。\n> 被引用的台词。\n![图片][ref]\n[ref]: https://example.test/img.png\n尾声。'), ['旁白。', '尾声。']);
});

test('entity-encoded quote delimiters exclude dialogue without stripping apostrophes', () => {
    assert.deepEqual(texts('他说&quot;不要读这句对白。&quot;然后走了。'), ['他说', '然后走了。']);
    assert.deepEqual(texts('他说&#x201c;不要读这句对白。&#8221;然后走了。'), ['他说', '然后走了。']);
    assert.deepEqual(texts('The student&#39;s notebook isn&apos;t here.'), ["The student's notebook isn't here."]);
});

test('malformed, nested and incomplete voice tags never become narration', () => {
    for (const tag of ['[TTSVoice:A:happy:[笑]台词。]', '[ttsvoice:包子:happy:台词。]', '[TTS Voice:A:happy:台词。]',
        '[TTSVoice::happy:台词。]', '[TTSVoice:A:happy:台词。[未闭合]', '[TTSVoice:A:happy:跨\n行。]', '[TTSVo']) {
        assert.deepEqual(texts(`正文。\n${tag}`, true), ['正文。'], tag);
        assert.deepEqual(texts(`正文。\n${tag}`), ['正文。'], tag);
    }
    const raw = '[TTSVoice:A:happy:未闭合\n[TTSVoice:B:happy:完整。]\n真实旁白。';
    assert.deepEqual(texts(raw), ['真实旁白。']);
});

test('streaming submits sentences and paragraphs but withholds an unfinished tail', () => {
    assert.deepEqual(texts('他走进教室。她正低头', true), ['他走进教室。']);
    assert.deepEqual(texts('他走进教室。她正低头\n', true), ['他走进教室。', '她正低头']);
    assert.deepEqual(texts('他走进教室。她正低头'), ['他走进教室。', '她正低头']);
    assert.deepEqual(texts('他回头[TTSVoice:A:default:你好。]', true), ['他回头']);
});

test('pending HTML/link syntax cannot change previously committed narration', () => {
    for (const [prefix, suffix] of [
        ['他<b', '>抬头</b>。'], ['他[走向图书馆。', '](https://example.test)。'],
        ['他[看到了。]', '，然后离开。'], ['他[走向图书馆](https://ex', 'ample.test)。'],
    ]) {
        assert.deepEqual(texts(prefix, true), [], prefix);
        assert.ok(texts(prefix + suffix, true).length > 0, suffix);
    }
    assert.deepEqual(texts('他说“未说完。', true), ['他说']);
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
    assert.equal(final.at(-1).text, '末尾半句');
});

test('streaming entity-quoted speech remains excluded from its opening delimiter', () => {
    const raw = '他说&quot;不要读这句对白。&quot;然后走了。';
    let committed = [];
    for (let end = 1; end <= raw.length; end++) {
        const next = parseNarration(raw.slice(0, end), '', { streaming: true });
        assert.deepEqual(next.slice(0, committed.length), committed, `prefix at ${end}`);
        committed = next;
    }
    assert.deepEqual(committed.map(s => s.text), ['他说', '然后走了。']);
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
