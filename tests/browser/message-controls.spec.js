import { test, expect } from '@playwright/test';

const studio = page => page.locator('#breeze-studio-host').locator('dialog');
const current = page => page.locator('#chat .mes').last();
const controls = page => current(page).locator('.breeze-message-controls');
const play = page => controls(page).locator('.breeze-message-play');
const pause = page => controls(page).locator('.breeze-message-pause');
const stop = page => controls(page).locator('.breeze-message-stop');
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
    await expect(controls(page).locator('button')).toHaveCount(3);
});

for (const width of [1440, 375]) {
    test(`${width}px message controls stay horizontal and wrap as complete buttons despite host button sizing`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.addStyleTag({ content: '.menu_button { width: min-content; } #chat button { width: min-content; white-space: normal; overflow-wrap: anywhere; }' });
        await expect(pause(page)).toBeDisabled();
        await expect(stop(page)).toBeDisabled();
        await expect(controls(page)).toHaveCSS('flex-wrap', 'wrap');
        const check = async () => {
            const bounds = await controls(page).evaluate(node => {
                const parent = node.getBoundingClientRect();
                return [...node.querySelectorAll('button')].map(button => {
                    const rect = button.getBoundingClientRect(), style = getComputedStyle(button);
                    return { width: rect.width, height: rect.height, left: rect.left, right: rect.right,
                        top: rect.top, parentLeft: parent.left, parentRight: parent.right,
                        whiteSpace: style.whiteSpace, flexShrink: style.flexShrink };
                });
            });
            for (const bound of bounds) {
                expect(bound.whiteSpace).toBe('nowrap');
                expect(bound.flexShrink).toBe('0');
                expect(bound.width).toBeGreaterThan(bound.height);
                expect(bound.height).toBeLessThanOrEqual(44);
                expect(bound.left).toBeGreaterThanOrEqual(bound.parentLeft - 1);
                expect(bound.right).toBeLessThanOrEqual(Math.min(bound.parentRight, width) + 1);
            }
            return bounds;
        };
        const initial = await check();
        expect(initial.every(button => button.top === initial[0].top)).toBe(true);
        await controls(page).evaluate(node => { node.style.maxWidth = '165px'; });
        const wrapped = await check();
        expect(wrapped.some(button => button.top > wrapped[0].top)).toBe(true);
    });
}

test('narration chunk target fits the studio and exposes its range and default on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 900 });
    await openStudio(page);
    const input = studio(page).locator('[data-narrator-target-chars]');
    await expect(input).toHaveValue('100');
    await expect(input).toHaveAttribute('min', '20');
    await expect(input).toHaveAttribute('max', '1000');
    await expect(input).toHaveAttribute('step', '1');
    await expect(input).toHaveAccessibleName('旁白切片目标字数 目标内按最后完整句子切分，单句过长保留整句；段落与对白边界分开。');
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
