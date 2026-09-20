import { test, expect } from '@playwright/test';

const studio = page => page.locator('#breeze-studio-host dialog');
const panel = page => page.locator('#breeze-floating-controls');
const master = page => panel(page).locator('[data-master-toggle]:visible');
const setting = (page, name) => studio(page).locator(`[data-setting="${name}"]`);
const control = (page, name) => panel(page).locator(`.breeze-message-${name}`);
const prompt = page => page.evaluate(() => window.__breezeDemo.context.extensionPrompts.breeze_voice_protocol?.value);
const state = async request => (await request.get('/__demo/state')).json();
const speech = text => `[TTSVoice:周启明:default:${text}]`;

async function openStudio(page, tab = 'connection') {
    await page.getByRole('button', { name: '打开扩展菜单' }).click();
    await page.locator('#breeze_studio_wand_entry').click();
    await studio(page).locator(`[data-tab="${tab}"]`).click();
}

async function configure(page, values) {
    await openStudio(page);
    for (const [name, value] of Object.entries(values)) {
        const input = setting(page, name);
        if (await input.isChecked() !== value) await input.locator('..').click();
        await expect(input).toBeChecked({ checked: value });
    }
    await studio(page).locator('[data-close]').click();
}

async function expectDisabledPlayback(page) {
    await expect(panel(page)).toBeVisible();
    await expect(master(page)).toBeEnabled();
    for (const name of ['play', 'pause', 'stop', 'refresh']) await expect(control(page, name)).toBeDisabled();
    await expect(panel(page).getByRole('slider', { name: '本条语音播放进度' })).toBeDisabled();
}

async function replaceMessage(page, raw) {
    await page.evaluate(raw => {
        const demo = window.__breezeDemo;
        demo.context.chat[0].mes = raw;
        document.querySelector('#chat .mes_text').textContent = raw;
        demo.emit('MESSAGE_UPDATED', 0);
    }, raw);
}

test.beforeEach(async ({ page, request }) => {
    await request.post('/__demo/reset');
    await page.addInitScript(() => {
        window.__masterContexts = [];
        const OriginalContext = window.AudioContext;
        window.AudioContext = class extends OriginalContext {
            constructor(...args) { super(...args); window.__masterContexts.push(this); }
        };
    });
    await page.goto('/');
    await expect(master(page)).toHaveAttribute('role', 'switch');
    await expect(master(page)).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => prompt(page)).toContain('TTSVoice');
});

test('settings and floating switches share one enabled state and clear injection immediately', async ({ page }) => {
    await master(page).click();
    expect(await prompt(page)).toBe('');
    await expect(master(page)).toHaveAttribute('aria-checked', 'false');
    await expectDisabledPlayback(page);
    await openStudio(page);
    await expect(setting(page, 'enabled')).not.toBeChecked();
    await expect(setting(page, 'enabled').locator('..')).toContainText('Breeze 总开关');
    await setting(page, 'enabled').locator('..').click();
    await studio(page).locator('[data-close]').click();
    await expect(master(page)).toHaveAttribute('aria-checked', 'true');
    await expect(control(page, 'play')).toBeEnabled();
    await expect.poll(() => prompt(page)).toContain('TTSVoice');
    await configure(page, { enabled: false });
    await expect(master(page)).toHaveAttribute('aria-checked', 'false');
    await master(page).click();
    await openStudio(page);
    await expect(setting(page, 'enabled')).toBeChecked();
});

test('the mobile compact button opens the panel before changing the saved master switch', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 900 });
    await replaceMessage(page, '没有语音标签的普通回复。');
    await expect(page.locator('#chat .breeze-bubble')).toHaveCount(0);
    await expectDisabledPlayback(page);
    await master(page).click();
    await panel(page).getByRole('button', { name: '收起语音面板', exact: true }).click();
    await expect(master(page)).toHaveCount(0);
    await expect(panel(page).locator('[data-expand]')).toHaveText('Breeze');
    await expect(panel(page).locator('[data-expand]')).toBeInViewport();
    await page.reload();
    await expect(panel(page).getByRole('button', { name: '展开语音面板', exact: true })).toBeVisible();
    await expect(master(page)).toHaveCount(0);
    expect(await prompt(page)).toBe('');
    await page.screenshot({ path: 'test-results/master-toggle-compact-375.png' });
    await panel(page).getByRole('button', { name: '展开语音面板', exact: true }).focus();
    await page.keyboard.press('Space');
    await expect(master(page)).toHaveAttribute('aria-checked', 'false');
    await expect(master(page)).toBeInViewport();
    await expectDisabledPlayback(page);
    await master(page).focus();
    await page.keyboard.press('Space');
    await expect(master(page)).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => prompt(page)).toContain('TTSVoice');
    await expect(control(page, 'play')).toBeEnabled();
    await expect(master(page)).toHaveAttribute('aria-checked', 'true');
    await page.screenshot({ path: 'test-results/master-toggle-expanded-375.png' });
});

test('off survives generation, presets, chat changes and reload without changing saved prompt or voice preferences', async ({ page, request }) => {
    await configure(page, { autoGenerate: true, autoPlay: true, readStreamingText: true });
    await openStudio(page, 'prompt');
    const template = '保留自定义规则。\n{{bound_characters_section}}\n{{vocal_events}}';
    await studio(page).locator('[data-prompt-template]').fill(template);
    await studio(page).locator('[data-save-prompt]').click();
    await studio(page).locator('[data-vocal-events]').fill('[轻笑]');
    await studio(page).locator('[data-new-extra-prompt]').click();
    await studio(page).locator('[data-extra-prompt]').fill('保留本聊天额外语料。');
    await studio(page).locator('[data-close]').click();
    const before = await page.evaluate(() => ({
        settings: window.__breezeDemo.context.extensionSettings.breeze_voice,
        metadata: window.__breezeDemo.context.chatMetadata,
    }));
    const originalPrompt = await prompt(page);
    await master(page).click();
    expect(await prompt(page)).toBe('');
    await page.evaluate(() => window.__breezeDemo.beginStream());
    expect(await prompt(page)).toBe('');
    await page.evaluate(() => window.__breezeDemo.emit('GENERATION_AFTER_COMMANDS', 'normal'));
    expect(await prompt(page)).toBe('');
    await page.evaluate(raw => window.__breezeDemo.streamText(raw), speech('关闭期间不能生成语音。'));
    await page.evaluate(() => window.__breezeDemo.finishStream());
    for (const event of ['GENERATION_STOPPED', 'PRESET_CHANGED', 'OAI_PRESET_CHANGED_AFTER']) {
        await page.evaluate(event => window.__breezeDemo.emit(event), event);
        expect(await prompt(page)).toBe('');
    }
    await page.evaluate(() => window.__breezeDemo.switchChat('master-other-chat'));
    expect(await prompt(page)).toBe('');
    await expect(master(page)).toHaveAttribute('aria-checked', 'false');
    await page.evaluate(() => window.__breezeDemo.switchChat('demo-campus-chat'));
    await page.reload();
    await expect(master(page)).toHaveAttribute('aria-checked', 'false');
    expect(await prompt(page)).toBe('');
    const after = await page.evaluate(() => ({
        settings: window.__breezeDemo.context.extensionSettings.breeze_voice,
        metadata: window.__breezeDemo.context.chatMetadata,
    }));
    expect(after.settings).toEqual({ ...before.settings, enabled: false });
    expect(after.metadata).toEqual(before.metadata);
    await expectDisabledPlayback(page);
    // Cross the automatic queue scheduling window after the final refresh.
    await page.waitForTimeout(350);
    expect((await state(request)).requests).toEqual([]);
    await master(page).click();
    await expect.poll(() => prompt(page)).toBe(originalPrompt);
});

test('reenabling keeps automatic prompt injection off when it was independently disabled', async ({ page }) => {
    await openStudio(page, 'prompt');
    await setting(page, 'injectPrompt').locator('..').click();
    await expect(setting(page, 'injectPrompt')).not.toBeChecked();
    await studio(page).locator('[data-close]').click();
    await master(page).click();
    await page.reload();
    await expect(master(page)).toHaveAttribute('aria-checked', 'false');
    await master(page).click();
    await expect(master(page)).toHaveAttribute('aria-checked', 'true');
    expect(await prompt(page)).toBe('');
    await openStudio(page, 'prompt');
    await expect(setting(page, 'injectPrompt')).not.toBeChecked();
    await studio(page).locator('[data-save-prompt]').click();
    expect(await prompt(page)).toBe('');
    await expect(studio(page).locator('[data-prompt-preview]')).not.toHaveValue('');
    await setting(page, 'injectPrompt').locator('..').click();
    await expect.poll(() => prompt(page)).toContain('TTSVoice');
});

test('turning off during PCM playback cancels the stream and stops the remaining message queue', async ({ page, request }) => {
    await configure(page, { streaming: true });
    await replaceMessage(page, [speech('正在播放的流式语音。'), speech('关闭后不能播放的下一句。')].join('\n'));
    await expect(control(page, 'play')).toBeEnabled();
    await control(page, 'play').click();
    await expect.poll(() => page.evaluate(() => window.__masterContexts.some(context => context.state === 'running'))).toBe(true);
    const first = (await state(request)).requests[0];
    await master(page).click();
    expect(await prompt(page)).toBe('');
    await expect.poll(async () => (await state(request)).cancelled).toContain(first.id);
    await expect.poll(() => page.evaluate(() => window.__masterContexts.every(context => context.state !== 'running'))).toBe(true);
    await expectDisabledPlayback(page);
    await page.waitForTimeout(350);
    const stopped = await state(request);
    expect(stopped.requests).toHaveLength(1);
    expect(stopped.streamEvents.some(event => event.id === first.id && event.type === 'done')).toBe(false);
    expect(await page.evaluate(() => Object.keys(window.__breezeDemo.context.chatMetadata.breeze_voice.cache))).toEqual([]);
});

test('turning off cancels pending ordinary synthesis and blocks delayed automatic work', async ({ page, request }) => {
    await configure(page, { autoGenerate: true, autoPlay: true, readStreamingText: true });
    // Keep the first synthesis pending while preserving the demo server's real cancellation endpoint.
    await page.route('**/breeze/jobs', async route => {
        const response = await route.fetch();
        const job = await response.json();
        await route.fulfill({ response, json: { ...job, status: 'running', audio_url: undefined } });
    });
    await page.route(/\/breeze\/jobs\/[a-f0-9]{32}$/, async route => {
        if (route.request().method() !== 'GET') return route.continue();
        const id = new URL(route.request().url()).pathname.split('/').at(-1);
        await route.fulfill({ json: { id, status: 'running' } });
    });
    await page.evaluate(() => window.__breezeDemo.beginStream());
    await page.evaluate(raw => window.__breezeDemo.streamText(raw), [speech('等待合成完成的第一句。'), speech('队列中不得继续的第二句。')].join('\n'));
    await expect.poll(async () => (await state(request)).requests.length).toBe(1);
    const first = (await state(request)).requests[0];
    await master(page).click();
    await expect.poll(async () => (await state(request)).cancelled).toContain(first.id);
    await page.evaluate(() => window.__breezeDemo.finishStream());
    await expectDisabledPlayback(page);
    await page.waitForTimeout(350);
    const stopped = await state(request);
    expect(stopped.requests).toHaveLength(1);
    expect(stopped.audioRequests).toEqual([]);
    expect(await prompt(page)).toBe('');
    expect(await page.evaluate(() => Object.keys(window.__breezeDemo.context.chatMetadata.breeze_voice.cache))).toEqual([]);
});
