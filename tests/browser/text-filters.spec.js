import { test, expect } from '@playwright/test';

const studio = page => page.locator('#breeze-studio-host').locator('dialog');
const editor = page => studio(page).locator('[data-text-filter-editor]');
const rows = page => editor(page).locator('[data-text-filter-row]');
const current = page => page.locator('#chat .mes').last();
const bubbles = page => current(page).locator('.breeze-bubble');
const controls = page => page.locator('#breeze-floating-controls');
const playMessage = page => controls(page).locator('.breeze-message-play');
const state = async request => (await request.get('/__demo/state')).json();
const jobs = async request => (await state(request)).requests;
const rules = page => page.evaluate(() => window.__breezeDemo.context.extensionSettings.breeze_voice.textFilters);
const prompt = page => page.evaluate(() => window.__breezeDemo.context.extensionPrompts.breeze_voice_protocol?.value);
const rawMessage = page => page.evaluate(() => window.__breezeDemo.context.chat.at(-1).mes);
const renderedMessage = page => current(page).locator('.mes_text').evaluate(node => {
    const copy = node.cloneNode(true);
    copy.querySelectorAll('.breeze-bubble').forEach(button => button.remove());
    return copy.textContent;
});
const speech = (speaker, text) => `[TTSVoice:${speaker}:happy:${text}]`;
const narratorVoice = '3'.repeat(32);

async function openStudio(page, tab = 'connection') {
    await page.getByRole('button', { name: '打开扩展菜单' }).click();
    await page.locator('#breeze_studio_wand_entry').click();
    await studio(page).locator(`[data-tab="${tab}"]`).click();
}

async function configure(page, settings) {
    await openStudio(page);
    for (const [name, enabled] of Object.entries(settings)) {
        const control = studio(page).locator(`[data-setting="${name}"]`);
        if (await control.isChecked() !== enabled) await control.locator('..').click();
        await expect(control).toBeChecked({ checked: enabled });
    }
    await studio(page).locator('[data-close]').click();
}

async function setNarrator(page, fetchMode = 'playback') {
    await openStudio(page, 'characters');
    await studio(page).locator('[data-narrator-voice]').selectOption(narratorVoice);
    await studio(page).locator('[data-narrator-fetch-mode]').selectOption(fetchMode);
    await studio(page).locator('[data-close]').click();
}

async function stageRules(page, values) {
    while (await rows(page).count()) await rows(page).first().locator('[data-delete-text-filter]').click();
    for (const value of values) {
        await editor(page).locator('[data-add-text-filter]').click();
        const row = rows(page).last();
        await row.locator('[data-text-filter-match]').fill(value.text);
        await row.locator('[data-text-filter-enabled]').setChecked(value.enabled);
    }
}

async function saveRules(page, values) {
    await openStudio(page);
    await stageRules(page, values);
    await editor(page).locator('[data-save-text-filters]').click();
    await expect.poll(() => rules(page)).toEqual(values);
    await studio(page).locator('[data-close]').click();
}

async function replaceMessage(page, raw) {
    await page.evaluate(raw => {
        const demo = window.__breezeDemo, id = demo.context.chat.length - 1;
        demo.context.chat[id].mes = raw;
        document.querySelector(`.mes[mesid="${id}"] .mes_text`).textContent = raw;
        demo.emit('MESSAGE_UPDATED', id);
    }, raw);
    await expect(bubbles(page)).toHaveCount(raw.split('[TTSVoice:').length - 1);
}

test.beforeEach(async ({ page, request }) => {
    await request.post('/__demo/reset');
    await page.goto('/');
    await expect(page.locator('#chat .breeze-bubble').first()).toHaveAttribute('data-state', 'idle');
});

for (const streaming of [false, true]) {
    test(`default ellipsis filter changes role and narration requests in ${streaming ? 'PCM streaming' : 'ordinary audio'} only`, async ({ page, request }) => {
        await setNarrator(page);
        if (streaming) await configure(page, { streaming: true });
        const originalPrompt = await prompt(page);
        const raw = '窗外……下着雨。\n' + speech('周启明', '等……等我，别……走。') + '\n她……停下脚步。';
        await replaceMessage(page, raw);
        const visible = await renderedMessage(page);
        await expect(current(page).locator('.breeze-dialogue')).toContainText('等……等我，别……走。');

        await playMessage(page).click();
        await expect.poll(async () => (await jobs(request)).map(job => [job.text, job.voice_id])).toEqual([
            ['窗外 下着雨。', narratorVoice],
            ['等 等我，别 走。', '1'.repeat(32)],
            ['她 停下脚步。', narratorVoice],
        ]);
        await expect(controls(page).locator('.breeze-message-stop')).toBeDisabled();
        for (const job of await jobs(request)) expect(Boolean(job.stream)).toBe(streaming);
        expect(await rawMessage(page)).toBe(raw);
        expect(await renderedMessage(page)).toBe(visible);
        expect(await prompt(page)).toBe(originalPrompt);
        expect((await state(request)).cancelled).toEqual([]);
    });
}

test('live text pregeneration filters complete role and narration chunks without editing the streamed message', async ({ page, request }) => {
    await setNarrator(page, 'auto');
    await configure(page, { readStreamingText: true, autoGenerate: true });
    const originalPrompt = await prompt(page);
    await page.evaluate(() => window.__breezeDemo.beginStream());
    const prefix = '门外……传来脚步声。\n';
    const partial = prefix + '[TTSVoice:周启明:happy:我……';
    await page.evaluate(text => window.__breezeDemo.streamText(text), partial);
    await expect.poll(async () => (await jobs(request)).map(job => job.text)).toEqual(['门外 传来脚步声。']);
    await expect(bubbles(page)).toHaveCount(0);
    const raw = prefix + speech('周启明', '我……回来了。') + '\n他……放下书包';
    await page.evaluate(text => window.__breezeDemo.streamText(text), raw);
    await expect.poll(async () => (await jobs(request)).map(job => job.text)).toEqual(['门外 传来脚步声。', '我 回来了。']);
    await page.evaluate(() => window.__breezeDemo.finishStream());
    await expect.poll(async () => (await jobs(request)).map(job => job.text)).toEqual(['门外 传来脚步声。', '我 回来了。', '他 放下书包']);
    await expect(bubbles(page)).toHaveAttribute('data-state', 'ready');
    expect(await rawMessage(page)).toBe(raw);
    await expect(current(page).locator('.mes_text')).toContainText('门外……传来脚步声。');
    await expect(current(page).locator('.breeze-dialogue')).toContainText('我……回来了。');
    expect(await prompt(page)).toBe(originalPrompt);
});

test('filter drafts require Save, while disabled rules and an explicitly empty list persist globally', async ({ page, request }) => {
    const defaults = [{ text: '……', enabled: true }];
    await controls(page).getByRole('button', { name: '收起语音面板', exact: true }).click();
    await openStudio(page);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first().locator('[data-text-filter-match]')).toHaveValue('……');
    await expect(rows(page).first().locator('[data-text-filter-enabled]')).toBeChecked();
    for (const width of [1440, 375]) {
        await page.setViewportSize({ width, height: width === 375 ? 900 : 1000 });
        await editor(page).scrollIntoViewIfNeeded();
        const bounds = await editor(page).evaluate(node => {
            const rect = node.getBoundingClientRect();
            return { left: rect.left, right: rect.right, scroll: node.scrollWidth, width: node.clientWidth };
        });
        expect(bounds.left).toBeGreaterThanOrEqual(0);
        expect(bounds.right).toBeLessThanOrEqual(width);
        expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1);
        await page.screenshot({ path: `test-results/text-filters-${width}.png` });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    const saves = await page.evaluate(() => window.__breezeDemo.settingsSaves);
    await rows(page).first().locator('[data-text-filter-match]').fill('未保存的草稿');
    await rows(page).first().locator('[data-text-filter-enabled]').uncheck();
    expect(await rules(page)).toEqual(defaults);
    expect(await page.evaluate(() => window.__breezeDemo.settingsSaves)).toBe(saves);
    await page.reload();
    await openStudio(page);
    await expect(rows(page).first().locator('[data-text-filter-match]')).toHaveValue('……');
    await expect(rows(page).first().locator('[data-text-filter-enabled]')).toBeChecked();

    const saved = [{ text: '……', enabled: false }, { text: '字面.*规则', enabled: true }];
    await stageRules(page, saved);
    expect(await rules(page)).toEqual(defaults);
    await editor(page).locator('[data-save-text-filters]').click();
    await expect.poll(() => rules(page)).toEqual(saved);
    await page.evaluate(() => window.__breezeDemo.switchChat('text-filter-other-chat'));
    expect(await rules(page)).toEqual(saved);
    await page.reload();
    await openStudio(page);
    await expect(rows(page)).toHaveCount(2);
    await expect(rows(page).first().locator('[data-text-filter-enabled]')).not.toBeChecked();
    await expect(rows(page).nth(1).locator('[data-text-filter-match]')).toHaveValue('字面.*规则');

    await stageRules(page, []);
    expect(await rules(page)).toEqual(saved);
    await editor(page).locator('[data-save-text-filters]').click();
    await expect.poll(() => rules(page)).toEqual([]);
    await editor(page).locator('[data-reset-text-filters]').click();
    await expect(rows(page)).toHaveCount(1);
    expect(await rules(page)).toEqual([]);
    await page.reload();
    await openStudio(page);
    await expect(rows(page)).toHaveCount(0);
    expect(await rules(page)).toEqual([]);
    await studio(page).locator('[data-close]').click();
    await replaceMessage(page, speech('周启明', '空规则……保留省略号。'));
    await bubbles(page).click();
    await expect(bubbles(page)).toHaveAttribute('data-state', 'ready');
    expect((await jobs(request)).map(job => job.text)).toEqual(['空规则……保留省略号。']);
});

test('multiple rules match literal substrings, retain disabled text, and preserve surrounding spaces', async ({ page, request }) => {
    await setNarrator(page);
    const originalPrompt = await prompt(page);
    const raw = '风.+雨$&停保留。\n' + speech('周启明', '甲 .+ 乙$&丙保留丁.+戊。');
    await replaceMessage(page, raw);
    const visible = await renderedMessage(page);
    await saveRules(page, [
        { text: '.+', enabled: true },
        { text: '$&', enabled: true },
        { text: '保留', enabled: false },
    ]);
    expect(await renderedMessage(page)).toBe(visible);
    await playMessage(page).click();
    await expect.poll(async () => (await jobs(request)).map(job => job.text)).toEqual(['风 雨 停保留。', '甲   乙 丙保留丁 戊。']);
    await expect(bubbles(page)).toHaveAttribute('data-state', 'ready');
    expect(await rawMessage(page)).toBe(raw);
    expect(await prompt(page)).toBe(originalPrompt);
});

test('saving a filter cancels active speech and avoids unfiltered memory or persisted cache', async ({ page, request }) => {
    const raw = speech('周启明', '前……后。');
    await saveRules(page, [{ text: '……', enabled: false }]);
    await replaceMessage(page, raw);
    await bubbles(page).click();
    await expect(bubbles(page)).toHaveAttribute('data-state', 'ready');
    const unfiltered = (await jobs(request))[0];
    expect(unfiltered.text).toBe('前……后。');
    await configure(page, { streaming: true });
    await replaceMessage(page, speech('周启明', '取消……中的语音。'));
    await bubbles(page).click();
    await expect(bubbles(page)).toHaveAttribute('data-state', 'playing');
    const active = (await jobs(request))[1];
    await openStudio(page);
    await rows(page).first().locator('[data-text-filter-enabled]').check();
    await editor(page).locator('[data-save-text-filters]').click();
    await expect.poll(() => rules(page)).toEqual([{ text: '……', enabled: true }]);
    await studio(page).locator('[data-close]').click();
    await expect.poll(async () => (await state(request)).cancelled).toContain(active.id);
    expect(await page.evaluate(() => Object.values(window.__breezeDemo.context.chatMetadata.breeze_voice.cache).map(record => record.id))).not.toContain(active.id);
    await replaceMessage(page, raw);
    await expect(bubbles(page)).toHaveAttribute('data-state', 'idle');
    await bubbles(page).click();
    await expect(bubbles(page)).toHaveAttribute('data-state', 'ready');
    expect((await jobs(request)).map(job => job.text)).toEqual(['前……后。', '取消……中的语音。', '前 后。']);
    const filtered = (await jobs(request))[2];
    expect(filtered.id).not.toBe(unfiltered.id);

    await page.reload();
    await replaceMessage(page, raw);
    await bubbles(page).click();
    await expect(bubbles(page)).toHaveAttribute('data-state', 'ready');
    expect(await jobs(request)).toHaveLength(3);
    const audio = (await state(request)).audioRequests.filter(entry => entry.path.includes('/breeze/jobs/'));
    expect(audio.at(-1).path).toBe(`/breeze/jobs/${filtered.id}/audio`);
});

test('a filtered-only segment does not create a job or interrupt automatic playback of later segments', async ({ page, request }) => {
    await setNarrator(page, 'auto');
    await configure(page, { readStreamingText: true, autoGenerate: true, autoPlay: true });
    const raw = '……\n' + speech('周启明', '……') + '\n' + speech('林知夏', '继续……说。') + '\n尾声……结束。';
    await page.evaluate(() => window.__breezeDemo.beginStream());
    await page.evaluate(text => window.__breezeDemo.streamText(text), raw);
    await page.evaluate(() => window.__breezeDemo.finishStream());
    await expect(bubbles(page)).toHaveCount(2);
    await expect(bubbles(page).first()).toHaveAttribute('data-state', 'filtered');
    await expect(bubbles(page).first()).toBeDisabled();
    await expect.poll(async () => (await jobs(request)).map(job => [job.text, job.voice_id])).toEqual([
        ['继续 说。', '2'.repeat(32)], ['尾声 结束。', narratorVoice],
    ]);
    await expect.poll(async () => (await state(request)).audioRequests.filter(entry => entry.path.includes('/breeze/jobs/')).length).toBe(2);
    await expect(bubbles(page).last()).toHaveAttribute('data-state', 'ready');
    await expect(controls(page).locator('.breeze-message-stop')).toBeDisabled();
    expect((await state(request)).cancelled).toEqual([]);
    expect(await rawMessage(page)).toBe(raw);
});

test('an entirely filtered reply keeps its original display and creates no audio jobs', async ({ page, request }) => {
    await setNarrator(page, 'auto');
    await configure(page, { readStreamingText: true, autoGenerate: true, autoPlay: true });
    const raw = '……\n' + speech('周启明', '……') + '\n……';
    // Remove earlier playable replies too, leaving only the global switch available.
    await replaceMessage(page, raw);
    await expect(controls(page)).toBeVisible();
    await expect(playMessage(page)).toBeDisabled();
    await page.evaluate(() => window.__breezeDemo.beginStream());
    await page.evaluate(text => window.__breezeDemo.streamText(text), raw);
    await page.evaluate(() => window.__breezeDemo.finishStream());
    await expect(bubbles(page)).toHaveAttribute('data-state', 'filtered');
    await expect(bubbles(page)).toBeDisabled();
    await expect(bubbles(page)).toContainText('已过滤');
    await expect(controls(page)).toBeVisible();
    await expect(playMessage(page)).toBeDisabled();
    // Cross the automatic queue's scheduling window to detect delayed empty requests.
    await page.waitForTimeout(350);
    const result = await state(request);
    expect(result.requests).toEqual([]);
    expect(result.audioRequests).toEqual([]);
    expect(result.cancelled).toEqual([]);
    expect(await rawMessage(page)).toBe(raw);
    await expect(current(page).locator('.breeze-dialogue')).toContainText('……');
});
