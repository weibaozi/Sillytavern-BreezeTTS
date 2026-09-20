import { test, expect } from '@playwright/test';

const studio = page => page.locator('#breeze-studio-host').locator('dialog');
const current = page => page.locator('#chat .mes').last();
const body = page => current(page).locator('.mes_text');
const bubbles = page => current(page).locator('.breeze-bubble');
const demoState = async request => (await request.get('/__demo/state')).json();
const requests = async request => (await demoState(request)).requests;
const speech = (name, text, emotion = 'happy') => `[TTSVoice:${name}:${emotion}:${text}]`;

async function openConnection(page) {
    await page.getByRole('button', { name: '打开扩展菜单' }).click();
    await page.locator('#breeze_studio_wand_entry').click();
    await studio(page).locator('[data-tab="connection"]').click();
}

async function configure(page, settings) {
    await openConnection(page);
    for (const [key, enabled] of Object.entries(settings)) {
        const control = studio(page).locator(`[data-setting="${key}"]`);
        if (await control.isChecked() !== enabled) await control.locator('..').click();
        await expect(control).toBeChecked({ checked: enabled });
    }
    await studio(page).locator('[data-close]').click();
}

const begin = page => page.evaluate(() => window.__breezeDemo.beginStream());
const progress = (page, text, redrawDelay = 0, rawBeforeRedraw = false) => page.evaluate(({ text, redrawDelay, rawBeforeRedraw }) => window.__breezeDemo.streamText(text, { redrawDelay, rawBeforeRedraw }), { text, redrawDelay, rawBeforeRedraw });
const finish = (page, endBeforeReceive = false) => page.evaluate(endBeforeReceive => window.__breezeDemo.finishStream({ endBeforeReceive }), endBeforeReceive);

test.beforeEach(async ({ page, request }) => {
    await request.post('/__demo/reset');
    await page.addInitScript(() => {
        window.__liveAudioStarts = [];
        const start = AudioBufferSourceNode.prototype.start;
        AudioBufferSourceNode.prototype.start = function (...args) {
            window.__liveAudioStarts.push({ at: Date.now(), state: this.context.state });
            return start.apply(this, args);
        };
    });
    await page.goto('/');
    await expect(page.locator('#chat .breeze-bubble').first()).toHaveAttribute('data-state', 'idle');
});

test('read streaming text is independent of audio streaming and persists across reload', async ({ page }) => {
    await openConnection(page);
    await expect(studio(page).locator('[data-setting="readStreamingText"]')).not.toBeChecked();
    await expect(studio(page).locator('[data-setting="streaming"]')).not.toBeChecked();
    await studio(page).locator('[data-setting="readStreamingText"]').locator('..').click();
    await expect.poll(() => page.evaluate(() => window.__breezeDemo.context.extensionSettings.breeze_voice.readStreamingText)).toBe(true);
    await expect(studio(page).locator('[data-setting="streaming"]')).not.toBeChecked();
    await page.reload();
    await expect(page.locator('#chat .breeze-bubble').first()).toHaveAttribute('data-state', 'idle');
    await openConnection(page);
    await expect(studio(page).locator('[data-setting="readStreamingText"]')).toBeChecked();
    await expect(studio(page).locator('[data-setting="streaming"]')).not.toBeChecked();
});

test('pre-redraw token events hide incomplete metadata and expose only safe dialogue before the outer bracket closes', async ({ page, request }) => {
    await configure(page, { readStreamingText: true, autoGenerate: true });
    await begin(page);
    const intro = '他抬起头。\n';
    for (const partial of ['[TTSVo', '[TTSVoice:', '[TTSVoice:周启明:', '[TTSVoice:周启明:happy:', '[TTSVoice:周启明:happy:[笑', '[TTSVoice:周启明:happy:[笑]']) {
        await progress(page, intro + partial, 80);
        await expect.poll(() => body(page).innerText()).not.toContain('[TTS');
        await expect(body(page)).toContainText('他抬起头。');
        const visible = await body(page).innerText();
        expect(visible).not.toContain('周启明');
        expect(visible).not.toContain('happy');
        expect(visible).not.toContain('[笑');
        await expect(bubbles(page)).toHaveCount(0);
        expect(await requests(request)).toHaveLength(0);
    }
    const partial = intro + '[TTSVoice:周启明:happy:[笑]先去食堂，';
    await progress(page, partial, 80);
    await expect(body(page)).toContainText('先去食堂，');
    expect(await body(page).innerText()).not.toContain('[TTS');
    expect(await page.evaluate(() => window.__breezeDemo.context.chat.at(-1).mes)).toBe(partial);
    await expect(bubbles(page)).toHaveCount(0);
    expect(await requests(request)).toHaveLength(0);
    const complete = partial + '边吃边聊。]';
    await progress(page, complete, 80);
    await expect(bubbles(page)).toHaveCount(1);
    await expect.poll(async () => (await requests(request)).length).toBe(1);
    expect((await requests(request))[0].text).toBe('[笑]先去食堂，边吃边聊。');
    const trace = await page.evaluate(() => window.__breezeDemo.hostStreamTrace);
    expect(trace[1]).toEqual({ phase: 'token', raw: '' });
    expect(trace[2]).toEqual({ phase: 'redraw', raw: intro + '[TTSVo' });
    await finish(page);
    await expect(bubbles(page)).toHaveAttribute('data-state', 'ready');
    expect(await requests(request)).toHaveLength(1);
});

test('rendering incomplete tags still works with live reading off, but speech waits for reply completion', async ({ page, request }) => {
    await configure(page, { autoGenerate: true });
    await begin(page);
    const partial = '[TTSVoice:周启明:happy:先去';
    await progress(page, partial);
    await expect(body(page)).toContainText('先去');
    await expect.poll(() => body(page).innerText()).not.toContain('[TTS');
    const full = speech('周启明', '先去食堂。');
    await progress(page, full);
    await expect(bubbles(page)).toHaveCount(1);
    // Deliberately cross the automatic scheduler window: no request may start yet.
    await page.waitForTimeout(350);
    expect(await requests(request)).toHaveLength(0);
    await finish(page, true);
    await expect.poll(async () => (await requests(request)).length).toBe(1);
    await expect(bubbles(page)).toHaveAttribute('data-state', 'ready');
});

test('raw text advancing ahead of the DOM preserves the safe partial wrapper until the next host redraw', async ({ page, request }) => {
    await configure(page, { readStreamingText: true, autoGenerate: true });
    await begin(page);
    const first = '[TTSVoice:周启明:happy:[笑]今天先';
    await progress(page, first);
    await expect(body(page)).toContainText('今天先');
    await expect.poll(() => body(page).innerText()).not.toContain('[TTS');

    const second = first + '吃饭，';
    const redraw = progress(page, second, 400, true);
    await expect.poll(() => page.evaluate(() => window.__breezeDemo.context.chat.at(-1).mes)).toBe(second);
    // Cross the plugin render/automatic timer windows while the host is awaiting
    // reasoning updates. Raw is new; the visible host DOM is still the old frame.
    await page.waitForTimeout(140);
    expect(await body(page).innerText()).toContain('今天先');
    expect(await body(page).innerText()).not.toContain('吃饭');
    expect(await body(page).innerText()).not.toContain('[TTS');
    expect(await body(page).innerText()).not.toContain('[笑');
    await expect(bubbles(page)).toHaveCount(0);
    expect(await requests(request)).toHaveLength(0);
    await redraw;
    await expect(body(page)).toContainText('今天先吃饭，');
    expect(await body(page).innerText()).not.toContain('[TTS');

    const complete = second + '然后上课。]';
    const completeRedraw = progress(page, complete, 400, true);
    await expect.poll(() => page.evaluate(() => window.__breezeDemo.context.chat.at(-1).mes)).toBe(complete);
    await page.waitForTimeout(140);
    expect(await body(page).innerText()).toContain('今天先吃饭，');
    expect(await body(page).innerText()).not.toContain('然后上课');
    expect(await body(page).innerText()).not.toContain('[TTS');
    await expect(bubbles(page)).toHaveCount(0);
    expect(await requests(request)).toHaveLength(0);
    await completeRedraw;
    await expect(body(page)).toContainText('今天先吃饭，然后上课。');
    await expect(bubbles(page)).toHaveCount(1);
    await expect.poll(async () => (await requests(request)).length).toBe(1);
    await finish(page);
    await expect(bubbles(page)).toHaveAttribute('data-state', 'ready');
    expect((await requests(request)).map(job => job.text)).toEqual(['[笑]今天先吃饭，然后上课。']);
    expect(await page.evaluate(() => window.__breezeDemo.context.chat.at(-1).mes)).toBe(complete);
});

test('new tokens and reply completion do not resubmit completed sentences; later sentences remain ordered', async ({ page, request }) => {
    await configure(page, { readStreamingText: true, autoGenerate: true });
    await begin(page);
    let raw = speech('周启明', '[笑]先去食堂。');
    await progress(page, raw);
    await expect.poll(async () => (await requests(request)).length).toBe(1);
    for (const addition of ['\n', '林知夏', '收起课本。\n']) {
        raw += addition;
        await progress(page, raw);
    }
    raw += speech('林知夏', '我来带路。');
    await progress(page, raw);
    await expect.poll(async () => (await requests(request)).length).toBe(2);
    await expect(bubbles(page)).toHaveCount(2);
    await progress(page, raw + '\n两人向门口走去。');
    await finish(page);
    await page.waitForTimeout(350);
    expect((await requests(request)).map(job => job.text)).toEqual(['[笑]先去食堂。', '我来带路。']);
    expect((await demoState(request)).cancelled).toEqual([]);
    await expect(bubbles(page).nth(0)).toHaveAttribute('data-state', 'ready');
    await expect(bubbles(page).nth(1)).toHaveAttribute('data-state', 'ready');
});

test('non-streaming continue synthesizes only the appended utterance without a token event', async ({ page, request }) => {
    await configure(page, { readStreamingText: true, autoGenerate: true });
    const previous = speech('周启明', '这句已经在原消息里了。');
    const next = '\n他再次开口。\n' + speech('周启明', '这一句是新续写的。');
    await page.evaluate(previous => {
        const demo = window.__breezeDemo, id = demo.context.chat.length - 1;
        demo.context.chat[id].mes = previous;
        document.querySelector('.mes[mesid="' + id + '"] .mes_text').textContent = previous;
        demo.emit('MESSAGE_UPDATED', id);
    }, previous);
    await expect(bubbles(page)).toHaveCount(1);
    await page.evaluate(next => {
        const demo = window.__breezeDemo, id = demo.context.chat.length - 1;
        demo.emit('GENERATION_STARTED', 'continue', {}, false);
        demo.context.chat[id].mes += next;
        document.querySelector('.mes[mesid="' + id + '"] .mes_text').textContent = demo.context.chat[id].mes;
        demo.emit('MESSAGE_RECEIVED', id, 'continue');
        demo.emit('CHARACTER_MESSAGE_RENDERED', id, 'continue');
        demo.emit('GENERATION_ENDED');
    }, next);
    await expect(bubbles(page)).toHaveCount(2);
    await expect(bubbles(page).nth(1)).toHaveAttribute('data-state', 'ready');
    await expect(bubbles(page).nth(0)).toHaveAttribute('data-state', 'idle');
    expect((await requests(request)).map(job => job.text)).toEqual(['这一句是新续写的。']);
    expect(await page.evaluate(() => window.__breezeDemo.hostStreamTrace)).toEqual([]);
    expect(await page.evaluate(() => window.__breezeDemo.context.chat.at(-1).mes)).toBe(previous + next);
});

test('streaming continue reads a newly completed partial tag and later new dialogue but skips earlier complete tags', async ({ page, request }) => {
    await configure(page, { readStreamingText: true, autoGenerate: true });
    const previous = speech('周启明', '这句是上一轮完成的。') + '\n[TTSVoice:林知夏:happy:[笑]下';
    await page.evaluate(previous => {
        const demo = window.__breezeDemo, id = demo.context.chat.length - 1;
        demo.context.chat[id].mes = previous;
        document.querySelector('.mes[mesid="' + id + '"] .mes_text').textContent = previous;
        demo.emit('MESSAGE_UPDATED', id);
    }, previous);
    await expect(bubbles(page)).toHaveCount(1);
    expect(await page.evaluate(() => window.__breezeDemo.beginStream({ type: 'continue' }))).toBe(0);
    expect(await page.evaluate(() => window.__breezeDemo.context.chat.length)).toBe(1);
    await progress(page, '午');
    await expect(body(page)).toContainText('下午');
    await expect.poll(() => body(page).innerText()).not.toContain('[TTSVoice');
    await expect(bubbles(page)).toHaveCount(1);
    expect(await requests(request)).toHaveLength(0);
    let continuation = '午好。]';
    await progress(page, continuation);
    await expect.poll(async () => (await requests(request)).length).toBe(1);
    expect((await requests(request))[0].text).toBe('[笑]下午好。');
    continuation += '\n' + speech('周启明', '继续去教室吧。');
    await progress(page, continuation);
    await expect.poll(async () => (await requests(request)).length).toBe(2);
    await finish(page);
    await expect(bubbles(page)).toHaveCount(3);
    await expect(bubbles(page).nth(0)).toHaveAttribute('data-state', 'idle');
    await expect(bubbles(page).nth(1)).toHaveAttribute('data-state', 'ready');
    await expect(bubbles(page).nth(2)).toHaveAttribute('data-state', 'ready');
    expect((await requests(request)).map(job => job.text)).toEqual(['[笑]下午好。', '继续去教室吧。']);
    expect(await page.evaluate(() => window.__breezeDemo.context.chat[0].mes)).toBe(previous + continuation);
});

test('PCM playback can start while text continues without cancelling the first utterance or reordering the second', async ({ page, request }) => {
    await configure(page, { readStreamingText: true, autoPlay: true, streaming: true });
    await begin(page);
    const first = speech('周启明', '咱们先去食堂。');
    await progress(page, first);
    await expect.poll(() => page.evaluate(() => window.__liveAudioStarts.length)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.__breezeDemo.context.streamingProcessor.isFinished)).toBe(false);
    expect((await requests(request))[0].stream).toBe(true);
    const raw = first + '\n' + speech('林知夏', '好，我带路。');
    await progress(page, raw);
    await progress(page, raw + '\n她笑着走向门口。');
    await expect.poll(async () => (await requests(request)).length).toBe(2);
    await finish(page);
    await expect(bubbles(page).nth(1)).toHaveAttribute('data-state', 'ready');
    const state = await demoState(request);
    expect(state.requests.map(job => job.text)).toEqual(['咱们先去食堂。', '好，我带路。']);
    expect(state.cancelled).toEqual([]);
    expect(state.streamEvents.filter(event => event.type === 'done').map(event => event.id)).toEqual(state.requests.map(job => job.id));
});

for (const action of ['stop', 'edit', 'swipe', 'chat']) {
    test(`${action} cancels live speech and clears the queued later utterance`, async ({ page, request }) => {
        await configure(page, { readStreamingText: true, autoPlay: true, streaming: true });
        await begin(page);
        await progress(page, speech('周启明', '这一句正在播放。') + '\n' + speech('林知夏', '这一句不应在取消后播放。'));
        await expect.poll(() => page.evaluate(() => window.__liveAudioStarts.length)).toBeGreaterThan(0);
        await page.evaluate(action => {
            const demo = window.__breezeDemo;
            const id = demo.context.streamingProcessor.messageId;
            if (action === 'stop') demo.stopStream();
            if (action === 'edit') {
                demo.context.chat[id].mes = '用户已重新编辑这条消息。';
                document.querySelector('.mes[mesid="' + id + '"] .mes_text').textContent = demo.context.chat[id].mes;
                demo.emit('MESSAGE_EDITED', id);
            }
            if (action === 'swipe') {
                demo.context.chat[id].swipe_id++;
                demo.emit('MESSAGE_SWIPED', id);
            }
            if (action === 'chat') demo.switchChat('cancel-live-demo');
        }, action);
        await expect.poll(async () => (await demoState(request)).cancelled.length).toBe(1);
        // Allow an erroneously retained queue to become observable after cancellation.
        await page.waitForTimeout(350);
        const state = await demoState(request);
        expect(state.requests).toHaveLength(1);
        expect(state.jobs[state.requests[0].id].status).toBe('cancelled');
        expect(state.streamEvents.some(event => event.type === 'done')).toBe(false);
        expect(await page.evaluate(() => Object.keys(window.__breezeDemo.context.chatMetadata.breeze_voice.cache))).toEqual([]);
    });
}

test('generated dialogue follows the host quote theme instead of narration color and updates with theme changes', async ({ page }) => {
    const quote = page.locator('#chat .breeze-dialogue').first();
    await expect(quote).toBeVisible();
    await expect(quote).toHaveCSS('color', 'rgb(225, 138, 36)');
    expect(await quote.evaluate(node => node.tagName)).toBe('Q');
    expect(await quote.evaluate(node => getComputedStyle(node, '::before').content)).toBe('""');
    expect(await quote.evaluate(node => getComputedStyle(node, '::after').content)).toBe('""');
    await page.addStyleTag({ content: ':root { --SmartThemeQuoteColor: rgb(122, 77, 199); }' });
    await expect(quote).toHaveCSS('color', 'rgb(122, 77, 199)');
    await page.screenshot({ path: 'test-results/live-text-theme.png' });
});
