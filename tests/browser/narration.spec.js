import { test, expect } from '@playwright/test';

const narratorVoice = '3'.repeat(32);
const defaultEmotion = '平稳口气，配音';
const studio = page => page.locator('#breeze-studio-host').locator('dialog');
const field = (page, name) => studio(page).locator(`[data-${name}]`);
const current = page => page.locator('#chat .mes').last();
const bubbles = page => current(page).locator('.breeze-bubble');
const playMessage = page => page.locator('#breeze-floating-controls').locator('.breeze-message-play');
const state = async request => (await request.get('/__demo/state')).json();
const requests = async request => (await state(request)).requests;
const speech = (name, text, emotion = 'happy') => `[TTSVoice:${name}:${emotion}:${text}]`;
const narrator = page => page.evaluate(() => window.__breezeDemo.context.chatMetadata.breeze_voice.narrator);
const injection = page => page.evaluate(() => window.__breezeDemo.context.extensionPrompts.breeze_voice_protocol?.value);

async function openStudio(page, tab = 'characters') {
    await page.getByRole('button', { name: '打开扩展菜单' }).click();
    await page.locator('#breeze_studio_wand_entry').click();
    await studio(page).locator(`[data-tab="${tab}"]`).click();
}

async function setNarrator(page, voiceId = narratorVoice, emotion, fetchMode) {
    await openStudio(page);
    await field(page, 'narrator-voice').selectOption(voiceId);
    if (fetchMode !== undefined) await field(page, 'narrator-fetch-mode').selectOption(fetchMode);
    if (emotion !== undefined) {
        await field(page, 'narrator-mode').selectOption('direction');
        await field(page, 'narrator-emotion').fill(emotion);
        await field(page, 'narrator-emotion').dispatchEvent('change');
    }
    await expect.poll(async () => (await narrator(page))?.voiceId).toBe(voiceId);
    await field(page, 'close').click();
}

async function configure(page, settings) {
    await openStudio(page, 'connection');
    for (const [name, enabled] of Object.entries(settings)) {
        const control = studio(page).locator(`[data-setting="${name}"]`);
        if (await control.isChecked() !== enabled) await control.locator('..').click();
        await expect(control).toBeChecked({ checked: enabled });
    }
    await field(page, 'close').click();
}

async function replaceMessage(page, raw) {
    await page.evaluate(raw => {
        const demo = window.__breezeDemo;
        const id = demo.context.chat.length - 1;
        demo.context.chat[id].mes = raw;
        document.querySelector(`.mes[mesid="${id}"] .mes_text`).textContent = raw;
        demo.emit('MESSAGE_UPDATED', id);
    }, raw);
    await expect(bubbles(page)).toHaveCount(raw.split('[TTSVoice:').length - 1);
}

const begin = page => page.evaluate(() => window.__breezeDemo.beginStream());
const progress = (page, text) => page.evaluate(text => window.__breezeDemo.streamText(text), text);
const finish = page => page.evaluate(() => window.__breezeDemo.finishStream());

test.beforeEach(async ({ page, request }) => {
    await request.post('/__demo/reset');
    await page.addInitScript(() => {
        window.__narrationAudioStarts = [];
        const start = AudioBufferSourceNode.prototype.start;
        AudioBufferSourceNode.prototype.start = function (...args) {
            window.__narrationAudioStarts.push(Date.now());
            return start.apply(this, args);
        };
    });
    await page.goto('/');
    await expect(page.locator('#chat .breeze-bubble').first()).toHaveAttribute('data-state', 'idle');
});

test('narrator selection and emotion belong to the chat, survive reload, and leave dialogue injection unchanged', async ({ page, request }) => {
    await openStudio(page);
    await expect(field(page, 'narrator-voice')).toHaveValue('');
    await expect(field(page, 'narrator-mode')).toHaveValue('clone');
    await expect(field(page, 'narrator-fetch-mode')).toHaveValue('playback');
    await expect(field(page, 'narrator-emotion')).toHaveValue(defaultEmotion);
    await expect(field(page, 'narrator-target-chars')).toHaveValue('100');
    await expect(field(page, 'narrator-emotion')).toBeDisabled();
    await expect(field(page, 'narrator-preview')).toBeDisabled();
    const prompt = await injection(page);
    const mappings = await page.evaluate(() => window.__breezeDemo.context.chatMetadata.breeze_voice.mappings);
    const characterCount = await field(page, 'character-count').textContent();

    await field(page, 'narrator-voice').selectOption(narratorVoice);
    await field(page, 'narrator-mode').selectOption('direction');
    await field(page, 'narrator-fetch-mode').selectOption('auto');
    await field(page, 'narrator-emotion').fill('温柔沉静，像在讲一个故事');
    await field(page, 'narrator-emotion').dispatchEvent('change');
    await expect.poll(() => narrator(page)).toEqual({ voiceId: narratorVoice, mode: 'direction', fetchMode: 'auto', targetChars: 100, emotion: '温柔沉静，像在讲一个故事' });
    expect(await injection(page)).toBe(prompt);
    expect(await page.evaluate(() => window.__breezeDemo.context.chatMetadata.breeze_voice.mappings)).toEqual(mappings);
    await expect(field(page, 'character-count')).toHaveText(characterCount);

    await field(page, 'narrator-preview').click();
    await expect.poll(async () => (await state(request)).audioRequests.some(item => item.path === `/breeze/voices/${narratorVoice}/audio`)).toBe(true);
    expect(await requests(request)).toEqual([]);

    await page.evaluate(() => window.__breezeDemo.switchChat('narrator-other-chat'));
    await expect(field(page, 'narrator-voice')).toHaveValue('');
    await expect(field(page, 'narrator-mode')).toHaveValue('clone');
    await expect(field(page, 'narrator-fetch-mode')).toHaveValue('playback');
    await expect(field(page, 'narrator-emotion')).toHaveValue(defaultEmotion);
    await expect(field(page, 'narrator-target-chars')).toHaveValue('100');
    await field(page, 'narrator-voice').selectOption('1'.repeat(32));
    await field(page, 'narrator-mode').selectOption('direction');
    await field(page, 'narrator-fetch-mode').selectOption('off');
    await field(page, 'narrator-emotion').fill('严肃，放慢语速');
    await field(page, 'narrator-emotion').dispatchEvent('change');
    await expect.poll(() => narrator(page)).toEqual({ voiceId: '1'.repeat(32), mode: 'direction', fetchMode: 'off', targetChars: 100, emotion: '严肃，放慢语速' });
    await page.evaluate(() => window.__breezeDemo.switchChat('demo-campus-chat'));
    await expect(field(page, 'narrator-voice')).toHaveValue(narratorVoice);
    await expect(field(page, 'narrator-mode')).toHaveValue('direction');
    await expect(field(page, 'narrator-fetch-mode')).toHaveValue('auto');
    await expect(field(page, 'narrator-emotion')).toHaveValue('温柔沉静，像在讲一个故事');
    await page.reload();
    await expect(page.locator('#chat .breeze-bubble').first()).toBeVisible();
    await openStudio(page);
    await expect(field(page, 'narrator-voice')).toHaveValue(narratorVoice);
    await expect(field(page, 'narrator-mode')).toHaveValue('direction');
    await expect(field(page, 'narrator-fetch-mode')).toHaveValue('auto');
    await expect(field(page, 'narrator-emotion')).toHaveValue('温柔沉静，像在讲一个故事');
    expect(await injection(page)).toBe(prompt);
});

test('narration target is chat-bound and streaming counts across line breaks without making extra requests', async ({ page, request }) => {
    await setNarrator(page, narratorVoice, undefined, 'auto');
    await openStudio(page);
    const prompt = await injection(page);
    await field(page, 'narrator-target-chars').fill('35');
    await field(page, 'narrator-target-chars').dispatchEvent('change');
    await expect.poll(async () => (await narrator(page)).targetChars).toBe(35);
    expect(await injection(page)).toBe(prompt);
    await page.evaluate(() => window.__breezeDemo.switchChat('different-chunk-target'));
    await expect(field(page, 'narrator-target-chars')).toHaveValue('100');
    await page.evaluate(() => window.__breezeDemo.switchChat('demo-campus-chat'));
    await expect(field(page, 'narrator-target-chars')).toHaveValue('35');
    await page.reload();
    await openStudio(page);
    await expect(field(page, 'narrator-target-chars')).toHaveValue('35');
    await field(page, 'close').click();
    await configure(page, { readStreamingText: true, autoGenerate: true });
    await begin(page);
    const first = '甲'.repeat(17) + '。', second = '乙'.repeat(13) + '。', third = '丙'.repeat(12) + '。';
    const prefix = first + '\n\n' + second + '\n';
    await progress(page, prefix);
    await page.waitForTimeout(350);
    expect(await requests(request)).toHaveLength(0);
    await progress(page, prefix + third.slice(0, 3));
    await page.waitForTimeout(350);
    expect(await requests(request)).toHaveLength(0);
    await progress(page, prefix + third.slice(0, 4));
    await expect.poll(async () => (await requests(request)).map(job => job.text)).toEqual([first + ' ' + second]);
    await progress(page, prefix + third);
    await finish(page);
    await expect.poll(async () => (await requests(request)).map(job => job.text)).toEqual([first + ' ' + second, third]);
});

test('play message reads untagged quotations as narration while retaining tagged speakers and non-story exclusions', async ({ page, request }) => {
    await setNarrator(page, narratorVoice, '平静地讲述，语速稍慢');
    const raw = [
        '<!-- 1.正文前的格式 -->', '开场格式说明不应朗读。',
        '<!-- 2.正文 -->', '**阳光照进教室。**',
        '“先去吃饭吧。”', speech('周启明', '先去吃饭吧。'),
        '她合上课本。', '“这是没有标记的对白。”', '"This is another untagged quote."',
        speech('林知夏', '我带路。', 'softly reassuring'),
        '`内联代码不应朗读。`', '```text\n代码块不应朗读。\n```',
        '两人走向门口。', '<!-- 3.正文后的格式 -->',
        '结尾模块说明不应朗读。', '<w2g>选择一：留在教室。</w2g>', '<catsay>吐槽也不读。</catsay>',
    ].join('\n\n');
    await replaceMessage(page, raw);
    await expect(bubbles(page)).toHaveCount(2);
    await expect(playMessage(page)).toBeVisible();
    // Narration remains in the host prose; only dialogue gets quote styling.
    await expect(current(page).locator('.breeze-dialogue')).toHaveCount(2);
    for (const quote of await current(page).locator('.breeze-dialogue').allTextContents()) {
        expect(quote).not.toMatch(/阳光照进教室|她合上课本|两人走向门口/);
    }
    await playMessage(page).click();
    await expect.poll(async () => (await requests(request)).length).toBe(5);
    expect((await requests(request)).map(job => [job.text, job.voice_id, job.emotion])).toEqual([
        ['阳光照进教室。 “先去吃饭吧。”', narratorVoice, '平静地讲述，语速稍慢'],
        ['先去吃饭吧。', '1'.repeat(32), 'happy'],
        ['她合上课本。 “这是没有标记的对白。” "This is another untagged quote."', narratorVoice, '平静地讲述，语速稍慢'],
        ['我带路。', '2'.repeat(32), 'softly reassuring'],
        ['两人走向门口。', narratorVoice, '平静地讲述，语速稍慢'],
    ]);
    expect(await page.evaluate(() => window.__breezeDemo.context.chat.at(-1).mes)).toBe(raw);
    await expect(bubbles(page)).toHaveCount(2);
});

test('one dialogue bubble speaks only that line even when its message has an enabled narrator', async ({ page, request }) => {
    await setNarrator(page);
    await replaceMessage(page, '窗外传来下课铃声。\n' + speech('周启明', '终于下课了。') + '\n他拿起书包。');
    await expect(bubbles(page)).toHaveCount(1);
    await bubbles(page).click();
    await expect(bubbles(page)).toHaveAttribute('data-state', 'ready');
    expect((await requests(request)).map(job => job.text)).toEqual(['终于下课了。']);
});

test('a narration-only message defaults to cloning its reference without emotion and can be disabled', async ({ page, request }) => {
    await setNarrator(page);
    await replaceMessage(page, '午后的教室安静下来。');
    await expect(playMessage(page)).toBeVisible();
    await expect(bubbles(page)).toHaveCount(0);
    await expect(current(page).locator('.breeze-dialogue')).toHaveCount(0);
    await playMessage(page).click();
    await expect.poll(async () => (await requests(request)).length).toBe(1);
    expect((await requests(request))[0]).toMatchObject({ text: '午后的教室安静下来。', voice_id: narratorVoice, speech_mode: 'clone', emotion: '', cfg_scale: 1 });
    await setNarrator(page, '');
    await expect(page.locator('#breeze-floating-controls')).toBeHidden();
    await expect(current(page).locator('.mes_text')).toHaveText('午后的教室安静下来。');
});

test('switching narrator modes preserves emotion but generates separate narration audio without changing dialogue', async ({ page, request }) => {
    await setNarrator(page, narratorVoice, '温柔沉静，像在讲一个故事');
    const prompt = await injection(page);
    await openStudio(page);
    await field(page, 'narrator-mode').selectOption('clone');
    await expect(field(page, 'narrator-emotion')).toBeDisabled();
    await expect(field(page, 'narrator-emotion')).toHaveValue('温柔沉静，像在讲一个故事');
    await expect.poll(() => narrator(page)).toEqual({ voiceId: narratorVoice, mode: 'clone', fetchMode: 'playback', targetChars: 100, emotion: '温柔沉静，像在讲一个故事' });
    await field(page, 'close').click();
    await replaceMessage(page, '阳光照进教室。\n' + speech('周启明', '我来带路。', 'softly reassuring'));
    await playMessage(page).click();
    await expect.poll(async () => (await requests(request)).length).toBe(2);
    await expect(bubbles(page)).toHaveAttribute('data-state', 'ready');
    const first = await requests(request);
    expect(first[0]).toMatchObject({ text: '阳光照进教室。', speech_mode: 'clone', emotion: '', cfg_scale: 1 });
    expect(first[1]).toMatchObject({ text: '我来带路。', emotion: 'softly reassuring' });
    expect(first[1].speech_mode).not.toBe('clone');

    await openStudio(page);
    await field(page, 'narrator-mode').selectOption('direction');
    await expect(field(page, 'narrator-emotion')).toBeEnabled();
    await expect(field(page, 'narrator-emotion')).toHaveValue('温柔沉静，像在讲一个故事');
    await field(page, 'close').click();
    await playMessage(page).click();
    await expect.poll(async () => (await requests(request)).length).toBe(3);
    await expect(bubbles(page)).toHaveAttribute('data-state', 'ready');
    const switched = await requests(request);
    expect(switched[2]).toMatchObject({ text: '阳光照进教室。', emotion: '温柔沉静，像在讲一个故事' });
    expect(switched[2].speech_mode).not.toBe('clone');
    expect(switched[2].id).not.toBe(first[0].id);
    expect(switched.filter(job => job.text === '我来带路。')).toHaveLength(1);
    expect(await injection(page)).toBe(prompt);
});

test('older chats default to clone while retaining their saved narration emotion', async ({ page, request }) => {
    await page.evaluate(({ voiceId, emotion }) => {
        const demo = window.__breezeDemo;
        demo.context.chatMetadata.breeze_voice.narrator = { voiceId, emotion };
        demo.context.saveMetadata();
    }, { voiceId: narratorVoice, emotion: '保留这句旁白方向' });
    await page.reload();
    await expect(page.locator('#chat .breeze-bubble').first()).toHaveAttribute('data-state', 'idle');
    await openStudio(page);
    await expect(field(page, 'narrator-mode')).toHaveValue('clone');
    await expect(field(page, 'narrator-fetch-mode')).toHaveValue('playback');
    await expect(field(page, 'narrator-emotion')).toHaveValue('保留这句旁白方向');
    await expect(field(page, 'narrator-emotion')).toBeDisabled();
    await field(page, 'close').click();
    await replaceMessage(page, '旧聊天的旁白。');
    await playMessage(page).click();
    await expect.poll(async () => (await requests(request)).length).toBe(1);
    expect((await requests(request))[0]).toMatchObject({ speech_mode: 'clone', emotion: '', cfg_scale: 1 });
});

test('clone narration on an older backend requests an update instead of silently using direction', async ({ page, request }) => {
    await setNarrator(page);
    await page.route('**/breeze/health', route => route.fulfill({ json: { version: 1, loaded: true, queued: 0, running: false, streaming: true } }));
    await page.reload();
    await expect(page.locator('#chat .breeze-bubble').first()).toHaveAttribute('data-state', 'idle');
    await replaceMessage(page, '这段旁白需要克隆模式。');
    await playMessage(page).click();
    await openStudio(page);
    await expect(field(page, 'status')).toContainText(/更新.*重启|重启.*更新/);
    expect(await requests(request)).toEqual([]);
});

test('live pregeneration waits for narration boundaries and complete tags, then flushes the final tail once', async ({ page, request }) => {
    await setNarrator(page, narratorVoice, undefined, 'auto');
    await configure(page, { readStreamingText: true, autoGenerate: true });
    await begin(page);
    let raw = '门外传来';
    await progress(page, raw);
    await page.waitForTimeout(350);
    expect(await requests(request)).toHaveLength(0);
    raw += '脚步声。\n[TTSVoice:周启明:happy:[笑]';
    await progress(page, raw);
    await expect.poll(async () => (await requests(request)).length).toBe(1);
    expect((await requests(request))[0].text).toBe('门外传来脚步声。');
    raw += '我回来了。';
    await progress(page, raw);
    await page.waitForTimeout(350);
    expect(await requests(request)).toHaveLength(1);
    raw += ']';
    await progress(page, raw);
    await expect.poll(async () => (await requests(request)).length).toBe(2);
    raw += '\n他把书放在桌上';
    await progress(page, raw);
    await page.waitForTimeout(350);
    expect(await requests(request)).toHaveLength(2);
    await finish(page);
    await expect.poll(async () => (await requests(request)).length).toBe(3);
    await page.evaluate(() => {
        const demo = window.__breezeDemo, id = demo.context.chat.length - 1;
        demo.emit('CHARACTER_MESSAGE_RENDERED', id);
        demo.emit('MESSAGE_UPDATED', id);
    });
    await page.waitForTimeout(350);
    expect((await requests(request)).map(job => job.text)).toEqual(['门外传来脚步声。', '[笑]我回来了。', '他把书放在桌上']);
    await expect(bubbles(page)).toHaveCount(1);
    expect(await page.evaluate(() => window.__breezeDemo.context.chat.at(-1).mes)).toBe(raw);
});

test('automatic streamed audio starts with narration and retains narration-dialogue-narration order', async ({ page, request }) => {
    await setNarrator(page);
    await configure(page, { readStreamingText: true, autoPlay: true, streaming: true });
    await begin(page);
    let raw = '教室门被推开。\n';
    await progress(page, raw);
    await page.waitForTimeout(350);
    expect(await requests(request)).toHaveLength(0);
    raw += '[TTSVoice:';
    await progress(page, raw);
    await expect.poll(() => page.evaluate(() => window.__narrationAudioStarts.length)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.__breezeDemo.context.streamingProcessor.isFinished)).toBe(false);
    raw += '周启明:happy:我来晚了。]' + '\n他快步走向座位。';
    await progress(page, raw);
    await finish(page);
    await expect.poll(async () => (await state(request)).streamEvents.filter(event => event.type === 'done').length).toBe(3);
    expect((await requests(request)).map(job => [job.text, job.voice_id, job.stream])).toEqual([
        ['教室门被推开。', narratorVoice, true], ['我来晚了。', '1'.repeat(32), true], ['他快步走向座位。', narratorVoice, true],
    ]);
    expect((await state(request)).cancelled).toEqual([]);
    await expect(bubbles(page)).toHaveCount(1);
});

for (const streamingText of [false, true]) {
    test(`continue with streaming text ${streamingText} reads only newly appended narration`, async ({ page, request }) => {
        await setNarrator(page, narratorVoice, undefined, 'auto');
        await configure(page, { readStreamingText: streamingText, autoGenerate: true });
        const previous = '他走到窗前，';
        const continuation = '向操场望去。\n' + speech('周启明', '他们已经开始了。');
        await replaceMessage(page, previous);
        await expect(playMessage(page)).toBeVisible();
        if (streamingText) {
            await page.evaluate(() => window.__breezeDemo.beginStream({ type: 'continue' }));
            await progress(page, continuation);
            await finish(page);
        } else {
            await page.evaluate(continuation => {
                const demo = window.__breezeDemo, id = demo.context.chat.length - 1;
                demo.emit('GENERATION_STARTED', 'continue', {}, false);
                demo.context.chat[id].mes += continuation;
                document.querySelector(`.mes[mesid="${id}"] .mes_text`).textContent = demo.context.chat[id].mes;
                demo.emit('MESSAGE_RECEIVED', id, 'continue');
                demo.emit('CHARACTER_MESSAGE_RENDERED', id, 'continue');
                demo.emit('GENERATION_ENDED');
            }, continuation);
        }
        await expect.poll(async () => (await requests(request)).length).toBe(2);
        await expect(bubbles(page)).toHaveAttribute('data-state', 'ready');
        expect((await requests(request)).map(job => job.text)).toEqual(['向操场望去。', '他们已经开始了。']);
        expect(await page.evaluate(() => window.__breezeDemo.context.chat.at(-1).mes)).toBe(previous + continuation);
        // A later manual replay still includes the complete narration.
        await playMessage(page).click();
        await expect.poll(async () => (await requests(request)).length).toBe(3);
        expect((await requests(request))[2].text).toBe(previous + '向操场望去。');
    });
}

test('the narrator card keeps its controls usable on desktop and narrow screens', async ({ page }) => {
    await openStudio(page);
    await expect(field(page, 'narrator-voice')).toBeVisible();
    await expect(field(page, 'narrator-fetch-mode')).toBeVisible();
    await expect(field(page, 'narrator-emotion')).toBeVisible();
    await page.screenshot({ path: 'test-results/narrator-desktop.png' });
    await page.setViewportSize({ width: 375, height: 812 });
    await field(page, 'narrator-emotion').scrollIntoViewIfNeeded();
    await expect(field(page, 'narrator-emotion')).toBeVisible();
    await expect(field(page, 'narrator-voice')).toBeVisible();
    const dimensions = await studio(page).locator('.narrator-card').evaluate(card => {
        const rect = card.getBoundingClientRect();
        return { width: window.innerWidth, left: rect.left, right: rect.right,
            client: card.clientWidth, scroll: card.scrollWidth,
            controls: [...card.querySelectorAll('select,input,button')].map(node => {
                const bounds = node.getBoundingClientRect();
                return { left: bounds.left, right: bounds.right, width: bounds.width };
            }) };
    });
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client + 1);
    expect(dimensions.left).toBeGreaterThanOrEqual(0);
    expect(dimensions.right).toBeLessThanOrEqual(dimensions.width);
    for (const bounds of dimensions.controls) {
        expect(bounds.left).toBeGreaterThanOrEqual(dimensions.left);
        expect(bounds.right).toBeLessThanOrEqual(dimensions.right);
        expect(bounds.width).toBeGreaterThan(30);
    }
    await page.screenshot({ path: 'test-results/narrator-mobile.png' });
});

for (const action of ['stop', 'chat']) {
    test(`${action} cancels an active narrator and drops later dialogue and narration`, async ({ page, request }) => {
        await setNarrator(page);
        await configure(page, { readStreamingText: true, autoPlay: true, streaming: true });
        await begin(page);
        await progress(page, '第一句旁白正在播放。\n' + speech('周启明', '这一句不应该继续播放。') + '\n后面的旁白也不播放。');
        await expect.poll(() => page.evaluate(() => window.__narrationAudioStarts.length)).toBeGreaterThan(0);
        await page.evaluate(action => {
            if (action === 'stop') window.__breezeDemo.stopStream();
            else window.__breezeDemo.switchChat('cancel-narrator-chat');
        }, action);
        await expect.poll(async () => (await state(request)).cancelled.length).toBe(1);
        await page.waitForTimeout(350);
        const result = await state(request);
        expect(result.requests).toHaveLength(1);
        expect(result.requests[0]).toMatchObject({ text: '第一句旁白正在播放。', voice_id: narratorVoice });
        expect(result.jobs[result.requests[0].id].status).toBe('cancelled');
        expect(result.streamEvents.some(event => event.type === 'done')).toBe(false);
        expect(await page.evaluate(() => Object.keys(window.__breezeDemo.context.chatMetadata.breeze_voice.cache))).toEqual([]);
    });
}
