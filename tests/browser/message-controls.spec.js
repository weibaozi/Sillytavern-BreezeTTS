import { test, expect } from '@playwright/test';

const studio = page => page.locator('#breeze-studio-host').locator('dialog');
const current = page => page.locator('#chat .mes').last();
const panel = page => page.locator('#breeze-floating-controls');
const controls = page => panel(page).locator('.breeze-message-controls');
const play = page => controls(page).locator('.breeze-message-play');
const pause = page => controls(page).locator('.breeze-message-pause');
const stop = page => controls(page).locator('.breeze-message-stop');
const refresh = page => controls(page).locator('.breeze-message-refresh');
const state = async request => (await request.get('/__demo/state')).json();
const speech = text => `[TTSVoice:周启明:default:${text}]`;

async function openStudio(page, tab = 'characters') {
    await page.getByRole('button', { name: '打开扩展菜单' }).click();
    await page.locator('#breeze_studio_wand_entry').click();
    await studio(page).locator(`[data-tab="${tab}"]`).click();
}

async function configure(page, values) {
    await openStudio(page, 'connection');
    for (const [key, value] of Object.entries(values)) {
        const input = studio(page).locator(`[data-setting="${key}"]`);
        if (await input.isChecked() !== value) await input.locator('..').click();
        await expect(input).toBeChecked({ checked: value });
    }
    await studio(page).locator('[data-close]').click();
}

async function replaceMessage(page, raw) {
    await page.evaluate(raw => {
        const demo = window.__breezeDemo, id = demo.context.chat.length - 1;
        demo.context.chat[id].mes = raw;
        document.querySelector(`.mes[mesid="${id}"] .mes_text`).textContent = raw;
        demo.emit('MESSAGE_UPDATED', id);
    }, raw);
    await expect(current(page).locator('.breeze-bubble')).toHaveCount(raw.split('[TTSVoice:').length - 1);
}

const probe = (page, streaming) => page.evaluate(streaming => {
    const source = streaming ? window.__controlsContexts.at(-1) : window.__controlsAudio.at(-1);
    return source ? { time: source.currentTime, paused: streaming ? source.state === 'suspended' : source.paused,
        closed: streaming ? source.state === 'closed' : !source.hasAttribute('src') } : null;
}, streaming);

test.beforeEach(async ({ page, request }) => {
    await request.post('/__demo/reset');
    await page.addInitScript(() => {
        window.__controlsAudio = [];
        window.__controlsContexts = [];
        window.__controlsStarts = [];
        const OriginalAudio = window.Audio;
        window.Audio = function (...args) {
            const audio = new OriginalAudio(...args);
            audio.playbackRate = .2;
            window.__controlsAudio.push(audio);
            return audio;
        };
        window.Audio.prototype = OriginalAudio.prototype;
        const OriginalContext = window.AudioContext;
        window.AudioContext = class extends OriginalContext {
            constructor(...args) { super(...args); window.__controlsContexts.push(this); }
        };
        const start = AudioBufferSourceNode.prototype.start;
        AudioBufferSourceNode.prototype.start = function (...args) {
            window.__controlsStarts.push({ at: Date.now(), state: this.context.state });
            return start.apply(this, args);
        };
    });
    await page.goto('/');
    await expect(current(page).locator('.breeze-bubble').first()).toHaveAttribute('data-state', 'idle');
    await expect(panel(page)).toHaveCount(1);
    await expect(page.locator('#chat .breeze-message-controls')).toHaveCount(0);
    await expect(controls(page).locator('button')).toHaveCount(4);
});

for (const width of [1440, 375]) {
    test(`${width}px floating controls stay in the viewport with readable labels despite hostile host button styles`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.screenshot({ path: `test-results/floating-controls-${width}.png` });
        await page.addStyleTag({ content: 'button, .menu_button { width: min-content !important; white-space: normal !important; overflow-wrap: anywhere !important; padding: 60px !important; font-size: 70px !important; }' });
        await expect(pause(page)).toBeDisabled();
        await expect(stop(page)).toBeDisabled();
        const check = async () => {
            const panelBounds = await panel(page).evaluate(node => {
                const rect = node.getBoundingClientRect();
                return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
                    viewportHeight: innerHeight, controls: [...node.shadowRoot.querySelectorAll('button,select,input')]
                        .filter(control => control.getBoundingClientRect().width > 0)
                        .map(control => {
                            const bound = control.getBoundingClientRect();
                            return { left: bound.left, right: bound.right, top: bound.top, bottom: bound.bottom };
                        }) };
            });
            expect(panelBounds.left).toBeGreaterThanOrEqual(0);
            expect(panelBounds.right).toBeLessThanOrEqual(width);
            expect(panelBounds.top).toBeGreaterThanOrEqual(0);
            expect(panelBounds.bottom).toBeLessThanOrEqual(panelBounds.viewportHeight);
            for (const bound of panelBounds.controls) {
                expect(bound.left).toBeGreaterThanOrEqual(panelBounds.left - 1);
                expect(bound.right).toBeLessThanOrEqual(panelBounds.right + 1);
                expect(bound.top).toBeGreaterThanOrEqual(panelBounds.top - 1);
                expect(bound.bottom).toBeLessThanOrEqual(panelBounds.bottom + 1);
            }
            const bounds = await controls(page).evaluate(node => {
                const parent = node.getBoundingClientRect();
                return [...node.querySelectorAll('button')].map(button => {
                    const rect = button.getBoundingClientRect(), text = document.createRange();
                    text.selectNodeContents(button);
                    return { width: rect.width, height: rect.height, left: rect.left, right: rect.right,
                        top: rect.top, parentLeft: parent.left, parentRight: parent.right,
                        labelLines: text.getClientRects().length, clientWidth: button.clientWidth, scrollWidth: button.scrollWidth };
                });
            });
            for (const bound of bounds) {
                expect(bound.labelLines).toBe(1);
                expect(bound.scrollWidth).toBeLessThanOrEqual(bound.clientWidth + 1);
                expect(bound.width).toBeGreaterThan(bound.height);
                expect(bound.height).toBeLessThanOrEqual(44);
                expect(bound.left).toBeGreaterThanOrEqual(bound.parentLeft - 1);
                expect(bound.right).toBeLessThanOrEqual(Math.min(bound.parentRight, width) + 1);
            }
            return bounds;
        };
        const initial = await check();
        expect(initial[1].top).toBe(initial[0].top);
        expect(initial[3].top).toBe(initial[2].top);
        expect(initial[2].top).toBeGreaterThan(initial[0].top);
        await refresh(page).evaluate(node => { node.textContent = '重新获取中 99/100'; node.disabled = true; });
        await check();
    });
}

test('narration chunk target fits the studio and exposes its range and default on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 900 });
    await panel(page).getByRole('button', { name: '收起语音面板', exact: true }).click();
    await openStudio(page);
    const input = studio(page).locator('[data-narrator-target-chars]');
    await expect(input).toHaveValue('100');
    await expect(input).toHaveAttribute('min', '20');
    await expect(input).toHaveAttribute('max', '1000');
    await expect(input).toHaveAttribute('step', '1');
    await expect(input).toHaveAccessibleName('旁白切片目标字数 跨换行累计，目标内按最后完整句子切分；单句过长保留整句。普通引号内容也由旁白朗读。');
    const bounds = await input.evaluate(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right }));
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(375);
});

for (const streaming of [false, true]) {
    const mode = streaming ? 'PCM streaming' : 'ordinary audio';
    test(`${mode} can pause while preparing and resumes the same request before stopping`, async ({ page, request }) => {
        await configure(page, { streaming });
        await replaceMessage(page, speech('等待合成完成后再开始朗读。'));
        let release;
        const held = new Promise(resolve => { release = resolve; });
        await page.route('**/breeze/jobs', async route => {
            const response = await route.fetch();
            await held;
            await route.fulfill({ response });
        });
        await play(page).click();
        await expect.poll(async () => (await state(request)).requests.length).toBe(1);
        await expect(pause(page)).toBeEnabled();
        await pause(page).click();
        await expect(pause(page)).toHaveAttribute('aria-pressed', 'true');
        release();
        await page.waitForTimeout(250);
        expect(await page.evaluate(() => window.__controlsStarts.length)).toBe(0);
        expect(await page.evaluate(() => window.__controlsAudio.length)).toBe(0);
        await pause(page).click();
        if (streaming) await expect.poll(() => page.evaluate(() => window.__controlsStarts.length)).toBeGreaterThan(0);
        else await expect.poll(async () => (await probe(page, false))?.time ?? 0).toBeGreaterThan(.015);
        expect((await state(request)).requests).toHaveLength(1);
        await stop(page).click();
        await expect(pause(page)).toBeDisabled();
        await expect(stop(page)).toBeDisabled();
        await expect.poll(async () => (await probe(page, streaming))?.closed).toBe(true);
    });

    test(`${mode} freezes the audio clock, continues in place and stops later queued speech`, async ({ page, request }) => {
        await configure(page, { streaming });
        await replaceMessage(page, [speech('第一句正在朗读。'), speech('后面的第二句。'), speech('第三句不能在停止后播放。')].join('\n'));
        await play(page).click();
        await expect.poll(async () => (await probe(page, streaming))?.time ?? 0).toBeGreaterThan(.03);
        await pause(page).click();
        await expect.poll(async () => (await probe(page, streaming))?.paused).toBe(true);
        const frozen = (await probe(page, streaming)).time;
        await page.waitForTimeout(220);
        expect(Math.abs((await probe(page, streaming)).time - frozen)).toBeLessThan(.015);
        await pause(page).click();
        await expect.poll(async () => (await probe(page, streaming))?.time ?? 0).toBeGreaterThan(frozen + .02);
        await stop(page).click();
        await expect(pause(page)).toBeDisabled();
        await expect(stop(page)).toBeDisabled();
        await expect.poll(async () => (await probe(page, streaming))?.closed).toBe(true);
        const captured = (await state(request)).requests.length;
        await page.waitForTimeout(350);
        const result = await state(request);
        expect(result.requests).toHaveLength(captured);
        expect(result.requests.some(job => job.text === '第三句不能在停止后播放。')).toBe(false);
        if (streaming) expect(result.cancelled).toHaveLength(1);
        else expect(await page.evaluate(() => window.__controlsAudio.length)).toBe(1);
    });
}

test('automatic streamed batches preserve pause while new text arrives and across completed transport batches', async ({ page, request }) => {
    await configure(page, { readStreamingText: true, autoPlay: true, streaming: true });
    await page.evaluate(() => window.__breezeDemo.beginStream());
    const first = speech('先朗读第一句。');
    await page.evaluate(raw => window.__breezeDemo.streamText(raw), first);
    await expect.poll(() => page.evaluate(() => window.__controlsStarts.length)).toBe(2);
    await expect.poll(async () => (await probe(page, true))?.time ?? 0).toBeGreaterThan(.65);
    await pause(page).click();
    await expect(pause(page)).toHaveAttribute('aria-pressed', 'true');
    await page.evaluate(raw => window.__breezeDemo.streamText(raw), first + '\n' + speech('追加的第二句只能在继续后播放。'));
    await page.evaluate(() => window.__breezeDemo.finishStream());
    await expect.poll(async () => (await state(request)).streamEvents.filter(event => event.type === 'done').length).toBe(1);
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.__controlsStarts.length)).toBe(2);
    await expect(pause(page)).toBeEnabled();
    await expect(pause(page)).toHaveAttribute('aria-pressed', 'true');
    await pause(page).click();
    await expect.poll(() => page.evaluate(() => window.__controlsStarts.length)).toBeGreaterThan(2);
    const result = await state(request);
    expect(result.requests.map(job => job.text)).toEqual(['先朗读第一句。', '追加的第二句只能在继续后播放。']);
    await stop(page).click();
    await expect(stop(page)).toBeDisabled();
});

test('refresh replaces cached character and narrator speech, repeats equal entries, skips unmapped speakers and never autoplays', async ({ page, request }) => {
    await openStudio(page);
    await studio(page).locator('[data-narrator-voice]').selectOption('3'.repeat(32));
    await studio(page).locator('[data-close]').click();
    const raw = ['晨光照进教室。', speech('同一句话。'), speech('同一句话。'),
        '[TTSVoice:林知夏:default:我来回答。]', '[TTSVoice:沈予安:New:这个角色还未绑定。]', '他们收起课本。'].join('\n');
    await replaceMessage(page, raw);
    await page.evaluate(() => {
        const originalPlay = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function (...args) { this.playbackRate = 4; return originalPlay.apply(this, args); };
    });
    await play(page).click();
    await expect.poll(async () => (await state(request)).requests.length).toBe(4);
    await expect(stop(page)).toBeDisabled();
    const original = await state(request);
    const originalIds = original.requests.map(job => job.id);
    const audioCount = await page.evaluate(() => window.__controlsAudio.length);
    expect(audioCount).toBe(5);

    let release;
    const held = new Promise(resolve => { release = resolve; });
    let gated = false;
    await page.route('**/breeze/jobs', async route => {
        const response = await route.fetch();
        if (!gated) { gated = true; await held; }
        await route.fulfill({ response });
    });
    await refresh(page).click();
    await expect(refresh(page)).toBeDisabled();
    await expect(refresh(page)).toHaveText(/重新获取中\s+0\/5/);
    await expect(controls(page)).toHaveAttribute('data-state', 'refreshing');
    await expect(panel(page).getByRole('combobox', { name: '朗读的回复' })).toBeDisabled();
    await expect(panel(page).getByRole('slider', { name: '本条语音播放进度' })).toBeDisabled();
    await expect(stop(page)).toBeEnabled();
    await expect(pause(page)).toBeDisabled();
    release();
    await expect(refresh(page)).toBeEnabled();
    await expect(refresh(page)).toHaveText('↻ 重新获取');
    await expect(panel(page).locator('.breeze-message-feedback')).toHaveText('已重新获取 5 段语音。');
    const after = await state(request), refreshed = after.requests.slice(original.requests.length);
    expect(refreshed.map(job => [job.text, job.voice_id])).toEqual([
        ['晨光照进教室。', '3'.repeat(32)], ['同一句话。', '1'.repeat(32)], ['同一句话。', '1'.repeat(32)],
        ['我来回答。', '2'.repeat(32)], ['他们收起课本。', '3'.repeat(32)],
    ]);
    expect(new Set(refreshed.map(job => job.id)).size).toBe(5);
    expect(refreshed.every(job => !job.stream)).toBe(true);
    const cacheIds = await page.evaluate(() => Object.values(window.__breezeDemo.context.chatMetadata.breeze_voice.cache).map(record => record.id));
    expect(cacheIds).toHaveLength(4);
    expect(cacheIds.some(id => originalIds.includes(id))).toBe(false);
    expect(cacheIds).toContain(refreshed[2].id);
    expect(await page.evaluate(() => window.__controlsAudio.length)).toBe(audioCount);
    expect(await page.evaluate(() => window.__controlsStarts.length)).toBe(0);
    await play(page).click();
    await expect(stop(page)).toBeDisabled();
    expect((await state(request)).requests).toHaveLength(9);
    expect(await page.evaluate(() => window.__breezeDemo.context.chat.at(-1).mes)).toBe(raw);
});

test('refresh stops an active stream and only prepares replacement speech', async ({ page, request }) => {
    await configure(page, { streaming: true });
    await replaceMessage(page, [speech('第一句正在流式播放。'), speech('重新获取后只生成不播放。')].join('\n'));
    await play(page).click();
    await expect.poll(() => page.evaluate(() => window.__controlsStarts.length)).toBeGreaterThan(0);
    const starts = await page.evaluate(() => window.__controlsStarts.length);
    await refresh(page).click();
    await expect(refresh(page)).toBeEnabled();
    await expect(panel(page).locator('.breeze-message-feedback')).toHaveText('已重新获取 2 段语音。');
    await expect.poll(async () => (await probe(page, true))?.closed).toBe(true);
    const result = await state(request);
    expect(result.requests).toHaveLength(3);
    expect(result.requests[0].stream).toBe(true);
    expect(result.requests.slice(1).every(job => !job.stream)).toBe(true);
    expect(result.cancelled).toEqual([result.requests[0].id]);
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => window.__controlsStarts.length)).toBe(starts);
    expect(await page.evaluate(() => window.__controlsAudio.length)).toBe(0);
});

for (const action of ['stop', 'chat']) {
    test(`${action} cancels refresh and prevents a late job from entering caches or playing`, async ({ page, request }) => {
        await replaceMessage(page, [speech('这一句的响应暂时延迟。'), speech('后续这一句必须取消。')].join('\n'));
        let release;
        const held = new Promise(resolve => { release = resolve; });
        await page.route('**/breeze/jobs', async route => {
            const response = await route.fetch();
            await held;
            await route.fulfill({ response }).catch(() => {});
        });
        await refresh(page).click();
        await expect.poll(async () => (await state(request)).requests.length).toBe(1);
        await expect(refresh(page)).toBeDisabled();
        if (action === 'stop') await stop(page).click();
        else await page.evaluate(() => window.__breezeDemo.switchChat('cancel-refresh-other-chat'));
        release();
        await expect(refresh(page)).toBeEnabled();
        await expect(stop(page)).toBeDisabled();
        await page.waitForTimeout(250);
        expect((await state(request)).requests).toHaveLength(1);
        expect(await page.evaluate(() => window.__controlsAudio.length)).toBe(0);
        expect(await page.evaluate(() => window.__controlsStarts.length)).toBe(0);
        expect(await page.evaluate(() => Object.keys(window.__breezeDemo.context.chatMetadata.breeze_voice.cache))).toEqual([]);
        if (action === 'chat') {
            const singleton = await panel(page).elementHandle();
            await page.evaluate(() => window.__breezeDemo.switchChat('demo-campus-chat'));
            await expect.poll(() => singleton.evaluate(node => node.isConnected)).toBe(true);
            await expect(panel(page)).toHaveCount(1);
            await expect(panel(page).getByRole('combobox', { name: '朗读的回复' })).toHaveValue('');
            await expect(refresh(page)).toBeEnabled();
            expect(await page.evaluate(() => Object.keys(window.__breezeDemo.context.chatMetadata.breeze_voice.cache))).toEqual([]);
        }
        // Normal playback must make new requests as well; a discarded response
        // must not survive only in the in-memory cache.
        await page.unroute('**/breeze/jobs');
        await play(page).click();
        await expect.poll(async () => (await state(request)).requests.length).toBe(3);
        await stop(page).click();
        const result = await state(request);
        expect(result.requests.slice(1).map(job => job.text)).toEqual(['这一句的响应暂时延迟。', '后续这一句必须取消。']);
        const cached = await page.evaluate(() => Object.values(window.__breezeDemo.context.chatMetadata.breeze_voice.cache).map(record => record.id));
        expect(cached).not.toContain(result.requests[0].id);
    });
}
