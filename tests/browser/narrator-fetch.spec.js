import { test, expect } from '@playwright/test';

const narratorVoice = '3'.repeat(32);
const studio = page => page.locator('#breeze-studio-host dialog');
const field = (page, name) => studio(page).locator(`[data-${name}]`);
const panel = page => page.locator('#breeze-floating-controls');
const control = (page, name) => panel(page).locator(`.breeze-message-${name}`);
const timeline = page => panel(page).getByRole('slider', { name: '本条语音播放进度' });
const state = async request => (await request.get('/__demo/state')).json();
const requests = async request => (await state(request)).requests;
const dialogue = text => `[TTSVoice:周启明:happy:${text}]`;
const story = ['门外响起脚步声。', dialogue('我回来了。'), '他把书放在桌上。', dialogue('今天很顺利。'), '窗外的雨停了。'].join('\n');
const allTexts = ['门外响起脚步声。', '我回来了。', '他把书放在桌上。', '今天很顺利。', '窗外的雨停了。'];
const dialogueTexts = [allTexts[1], allTexts[3]];
const playedIds = page => page.evaluate(() => window.__fetchAudioPlayed.map(src => src.match(/\/jobs\/([^/]+)\/audio/)?.[1]));

async function openStudio(page, tab = 'characters') {
    await page.getByRole('button', { name: '打开扩展菜单' }).click();
    await page.locator('#breeze_studio_wand_entry').click();
    await studio(page).locator(`[data-tab="${tab}"]`).click();
}

async function setNarrator(page, fetchMode) {
    await openStudio(page);
    await field(page, 'narrator-voice').selectOption(narratorVoice);
    if (fetchMode !== undefined) await field(page, 'narrator-fetch-mode').selectOption(fetchMode);
    await expect(field(page, 'narrator-fetch-mode')).toHaveValue(fetchMode ?? 'playback');
    await field(page, 'close').click();
}

async function configure(page, settings) {
    await openStudio(page, 'connection');
    for (const [name, enabled] of Object.entries(settings)) {
        const checkbox = studio(page).locator(`[data-setting="${name}"]`);
        if (await checkbox.isChecked() !== enabled) await checkbox.locator('..').click();
        await expect(checkbox).toBeChecked({ checked: enabled });
    }
    await field(page, 'close').click();
}

async function replaceMessage(page, raw = story) {
    await page.evaluate(raw => {
        const demo = window.__breezeDemo, id = demo.context.chat.length - 1;
        demo.context.chat[id].mes = raw;
        document.querySelector(`.mes[mesid="${id}"] .mes_text`).textContent = raw;
        demo.emit('MESSAGE_UPDATED', id);
    }, raw);
    await expect(page.locator('#chat .mes').last().locator('.breeze-bubble')).toHaveCount(raw.split('[TTSVoice:').length - 1);
}

async function generate(page, readStreamingText) {
    await page.evaluate(() => window.__breezeDemo.beginStream());
    await page.evaluate(raw => window.__breezeDemo.streamText(raw), story);
    if (readStreamingText) await page.waitForTimeout(350);
    await page.evaluate(() => window.__breezeDemo.finishStream());
}

async function seek(page, percent) {
    await expect(timeline(page)).toBeEnabled();
    await timeline(page).evaluate((node, value) => {
        node.value = String(value);
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
    }, percent);
}

test.beforeEach(async ({ page, request }) => {
    await request.post('/__demo/reset');
    await page.addInitScript(() => {
        window.__fetchAudioPlayed = [];
        const play = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function (...args) {
            window.__fetchAudioPlayed.push(this.getAttribute('src'));
            return play.apply(this, args);
        };
    });
    await page.goto('/');
    await expect(page.locator('#chat .breeze-bubble').first()).toHaveAttribute('data-state', 'idle');
});

for (const readStreamingText of [false, true]) {
    test(`default playback skips generate-only narration with streaming text ${readStreamingText} and manual playback restores story order`, async ({ page, request }) => {
        await setNarrator(page);
        await configure(page, { readStreamingText, autoGenerate: true, autoPlay: false, streaming: false });
        await generate(page, readStreamingText);
        await expect.poll(async () => (await requests(request)).map(job => job.text)).toEqual(dialogueTexts);
        await expect(page.locator('#chat .mes').last().locator('.breeze-bubble[data-state="ready"]')).toHaveCount(2);
        await page.waitForTimeout(350);
        expect((await requests(request)).map(job => job.text)).toEqual(dialogueTexts);
        expect(await playedIds(page)).toEqual([]);

        await control(page, 'play').click();
        await expect.poll(async () => (await playedIds(page)).length).toBe(5);
        await expect(control(page, 'stop')).toBeDisabled();
        const jobs = await requests(request);
        expect(jobs).toHaveLength(5);
        expect(await playedIds(page)).toEqual(allTexts.map(text => jobs.find(job => job.text === text).id));
        expect(jobs.filter(job => job.voice_id === narratorVoice).map(job => job.text)).toEqual([allTexts[0], allTexts[2], allTexts[4]]);
    });

    for (const autoPlay of [false, true]) {
        test(`off omits automatic narration with streaming text ${readStreamingText} and autoplay ${autoPlay}`, async ({ page, request }) => {
            await setNarrator(page, 'off');
            await configure(page, { readStreamingText, autoGenerate: true, autoPlay, streaming: false });
            await generate(page, readStreamingText);
            await expect.poll(async () => (await requests(request)).map(job => job.text)).toEqual(dialogueTexts);
            if (autoPlay) {
                await expect.poll(async () => (await playedIds(page)).length).toBe(2);
                await expect(control(page, 'stop')).toBeDisabled();
            } else {
                await expect(page.locator('#chat .mes').last().locator('.breeze-bubble[data-state="ready"]')).toHaveCount(2);
            }
            await page.waitForTimeout(350);
            expect((await requests(request)).map(job => job.text)).toEqual(dialogueTexts);
            expect(await playedIds(page)).toEqual(autoPlay ? (await requests(request)).map(job => job.id) : []);
        });
    }
}

test('off excludes already cached narration from play, seek, and refetch while preserving narrator settings', async ({ page, request }) => {
    await setNarrator(page);
    await replaceMessage(page);
    await control(page, 'refresh').click();
    await expect(control(page, 'feedback')).toHaveText('已重新获取 5 段语音。');
    const cached = await requests(request);
    expect(cached.map(job => job.text)).toEqual(allTexts);

    await setNarrator(page, 'off');
    const narrator = await page.evaluate(() => window.__breezeDemo.context.chatMetadata.breeze_voice.narrator);
    expect(narrator).toMatchObject({ voiceId: narratorVoice, mode: 'clone', fetchMode: 'off', emotion: '平稳口气，配音' });
    await control(page, 'play').click();
    await expect.poll(() => playedIds(page)).toEqual([cached[1].id, cached[3].id]);
    await expect(control(page, 'stop')).toBeDisabled();
    expect(await requests(request)).toHaveLength(5);

    await page.evaluate(() => { window.__fetchAudioPlayed = []; });
    await seek(page, 10);
    await expect.poll(() => playedIds(page)).toEqual([cached[1].id, cached[3].id]);
    await expect(control(page, 'stop')).toBeDisabled();
    expect(await requests(request)).toHaveLength(5);

    await control(page, 'refresh').click();
    await expect(control(page, 'feedback')).toHaveText('已重新获取 2 段语音。');
    expect((await requests(request)).slice(5).map(job => job.text)).toEqual(dialogueTexts);
    await replaceMessage(page, '这段缓存旁白关闭后没有可朗读内容。');
    await expect(panel(page)).toBeHidden();
});

test('playback seeking explicitly prepares narration and begins inside the narration timeline', async ({ page, request }) => {
    await setNarrator(page);
    await replaceMessage(page);
    await seek(page, 45);
    await expect.poll(async () => (await requests(request)).map(job => job.text)).toEqual(allTexts);
    const jobs = await requests(request);
    await expect.poll(() => playedIds(page)).toEqual([jobs[2].id, jobs[3].id, jobs[4].id]);
    await expect(control(page, 'stop')).toBeDisabled();
    expect(jobs.every(job => !job.stream)).toBe(true);
});
