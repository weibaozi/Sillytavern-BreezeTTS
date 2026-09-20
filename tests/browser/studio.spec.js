import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const voiceIds = ['1'.repeat(32), '2'.repeat(32), '3'.repeat(32)];
const panel = page => page.locator('#breeze-studio-host').locator('dialog');
const tab = (page, name) => panel(page).locator(`[data-tab="${name}"]`);
const card = (page, name) => panel(page).locator('[data-characters] .breeze-row').filter({ hasText: name });

async function openStudio(page) {
    await page.getByRole('button', { name: '打开扩展菜单' }).click();
    await page.locator('#breeze_studio_wand_entry').click();
    await expect(panel(page)).toBeVisible();
    await tab(page, 'characters').click();
    await expect(panel(page).locator('[data-characters] select')).toHaveCount(3);
    await expect(card(page, '周启明').locator('select')).toHaveValue(voiceIds[0]);
}

test.beforeEach(async ({ page, request }) => {
    await request.post('/__demo/reset');
    await page.goto('/');
    await expect(page.locator('#breeze_studio_wand_entry')).toBeAttached();
});

test('wand menu opens isolated studio; navigation, persistence, escape and reopen', async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.locator('#extensionsMenu #breeze_studio_wand_entry')).toHaveCount(1);
    await expect(page.locator('#send_form > .breeze-launch')).toHaveCount(0);
    await expect(page.locator('#extensions_settings button')).toHaveCount(0);
    await openStudio(page);
    await expect(panel(page).locator('[data-page="characters"]')).toBeVisible();
    await expect(card(page, '林知夏').locator('select')).toHaveValue(voiceIds[1]);
    await expect(card(page, '沈予安').locator('select')).toHaveValue('');
    await expect(panel(page).locator('[data-character-count]')).toHaveText('3');
    await expect(panel(page).locator('[data-bound-count]')).toHaveText('2');
    await expect(panel(page).locator('[data-voice-count]')).toHaveText('3');
    expect(await page.evaluate(() => !!document.querySelector('#breeze-studio-host').shadowRoot)).toBe(true);
    expect(await page.evaluate(() => document.querySelector('[data-setting="baseUrl"]'))).toBeNull();

    await tab(page, 'connection').click();
    await panel(page).locator('.switch-row').filter({ has: page.locator('[data-setting="autoPlay"]') }).click();
    await expect(panel(page).locator('[data-setting="autoPlay"]')).toBeChecked();
    await panel(page).locator('[data-setting="seed"]').fill('68');
    await panel(page).locator('[data-setting="seed"]').dispatchEvent('change');
    await expect.poll(() => page.evaluate(() => window.__breezeDemo.context.extensionSettings.breeze_voice.seed)).toBe(68);
    expect(await page.evaluate(() => window.__breezeDemo.context.extensionSettings.breeze_voice.autoPlay)).toBe(true);

    await tab(page, 'prompt').click();
    const template = 'Voice rules: {{bound_characters_section}} / {{vocal_events}}';
    await panel(page).locator('[data-prompt-template]').fill(template);
    await panel(page).locator('[data-save-prompt]').click();
    await expect.poll(() => panel(page).locator('[data-prompt-preview]').inputValue()).toContain('周启明');
    expect(await page.evaluate(() => window.__breezeDemo.context.extensionSettings.breeze_voice.promptTemplate)).toBe(template);

    await page.keyboard.press('Escape');
    await expect(panel(page)).not.toBeVisible();
    await expect(page.locator('#extensionsMenuButton')).toBeFocused();
    await openStudio(page);
    await tab(page, 'prompt').click();
    await expect(panel(page).locator('[data-prompt-template]')).toHaveValue(template);
    await expect(page.locator('#breeze-studio-host')).toHaveCount(1);
    await expect(page.locator('#breeze_studio_wand_entry')).toHaveCount(1);
    await panel(page).locator('[data-close]').click();
    await expect(panel(page)).not.toBeVisible();
    expect(errors).toEqual([]);
});

test('character search and binding update only the current demo chat', async ({ page }) => {
    await openStudio(page);
    await card(page, '沈予安').locator('select').selectOption(voiceIds[2]);
    await expect.poll(() => page.evaluate(() => window.__breezeDemo.context.chatMetadata.breeze_voice.mappings['沈予安'])).toBe(voiceIds[2]);
    await expect(panel(page).locator('[data-bound-count]')).toHaveText('3');
    await card(page, '周启明').locator('select').selectOption('');
    await expect.poll(() => page.evaluate(() => window.__breezeDemo.context.chatMetadata.breeze_voice.mappings['周启明'])).toBeNull();
    await expect(panel(page).locator('[data-bound-count]')).toHaveText('2');
    await panel(page).locator('[data-character-search]').fill('沈');
    await expect(card(page, '沈予安')).toBeVisible();
    await expect(card(page, '林知夏')).not.toBeVisible();
    await panel(page).locator('[data-character-search]').fill('不存在');
    await expect(panel(page).locator('[data-characters] select:visible')).toHaveCount(0);
    await panel(page).locator('[data-character-search]').fill('');
    await expect(panel(page).locator('[data-characters] select:visible')).toHaveCount(3);
    const state = await page.evaluate(() => window.__breezeDemo);
    expect(state.metadataSaves).toBeGreaterThanOrEqual(2);
    expect(state.context.chatMetadata.breeze_voice.demo).toBe(true);
});

test('host theme cannot restyle studio controls and desktop capture stays within viewport', async ({ page }) => {
    await openStudio(page);
    const close = panel(page).locator('[data-close]');
    const before = await close.evaluate(node => { const style = getComputedStyle(node); return { color: style.color, background: style.backgroundColor, font: style.fontSize, border: style.borderRadius }; });
    await page.addStyleTag({ content: 'body button, body input, body dialog { color: rgb(255, 0, 0) !important; background: rgb(255, 0, 255) !important; font-size: 72px !important; border-radius: 0 !important; }' });
    const after = await close.evaluate(node => { const style = getComputedStyle(node); return { color: style.color, background: style.backgroundColor, font: style.fontSize, border: style.borderRadius }; });
    expect(after).toEqual(before);
    const box = await panel(page).boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1441);
    expect(box.y + box.height).toBeLessThanOrEqual(1001);
    // Remove the deliberately hostile host CSS for the review screenshot.
    await page.evaluate(() => document.querySelectorAll('style').item(document.querySelectorAll('style').length - 1).remove());
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/studio-desktop.png' });
    await tab(page, 'voices').click();
    await page.screenshot({ path: 'test-results/studio-voices.png' });
});

test('voice uploads support success and visible duplicate-name failure', async ({ page, request }) => {
    await openStudio(page);
    await tab(page, 'voices').click();
    await panel(page).locator('.upload-panel summary').click();
    const form = panel(page).locator('[data-upload]');
    const audio = await request.get(`/breeze/voices/${voiceIds[0]}/audio`);
    const file = { name: 'demo-reference.wav', mimeType: 'audio/wav', buffer: await audio.body() };
    const fill = async () => {
        await form.locator('[name="name"]').fill('新音色 · 浏览器演示');
        await form.locator('[name="ref_text"]').fill('这是浏览器演示的参考文本。');
        await form.locator('[name="audio"]').setInputFiles(file);
        await form.locator('button').first().click();
    };
    await fill();
    await expect(panel(page).locator('[data-voices]')).toContainText('新音色 · 浏览器演示');
    await fill();
    await expect(panel(page).locator('[data-status]')).toContainText('音色名称已存在');
    await expect(form.locator('button').first()).toBeEnabled();
    expect((await (await request.get('/__demo/state')).json()).voices).toHaveLength(4);
});

test('design candidates can be saved; errors and cancellation recover the form', async ({ page, request }) => {
    await openStudio(page);
    await tab(page, 'design').click();
    const form = panel(page).locator('[data-design]');
    await form.locator('[name="instruction"]').fill('年轻男性，声音自然明亮。');
    await form.locator('[name="text"]').fill('我们去食堂边吃边聊吧。');
    await form.locator('[name="count"]').fill('2');
    await form.locator('button').first().click();
    await expect(panel(page).locator('[data-candidates] audio')).toHaveCount(2);
    const candidate = panel(page).locator('[data-candidates] .breeze-voice').first();
    await candidate.locator('input').fill('候选音色 · 浏览器演示');
    await candidate.getByRole('button', { name: '保存此音色' }).click();
    await expect(candidate.getByRole('button', { name: '已保存' })).toBeDisabled();
    await page.screenshot({ path: 'test-results/studio-design.png' });
    await form.locator('[name="instruction"]').fill('[演示失败]');
    await form.locator('button').first().click();
    await expect(panel(page).locator('[data-status]')).toContainText('演示生成失败');
    await expect(form.locator('button').first()).toBeEnabled();
    await form.locator('[name="instruction"]').fill('[演示慢速]');
    await form.locator('button').first().click();
    await expect(panel(page).locator('[data-candidates]')).toContainText('生成中');
    await form.locator('[data-cancel-design]').click();
    await expect(panel(page).locator('[data-status]')).toContainText('已取消');
    await expect(form.locator('button').first()).toBeEnabled();
    const data = await (await request.get('/__demo/state')).json();
    expect(data.cancelled).toHaveLength(2); // Failed and explicitly cancelled jobs are both cleaned up.
    expect(data.voices.some(voice => voice.name === '候选音色 · 浏览器演示' && voice.ref_text === '我们去食堂边吃边聊吧。')).toBe(true);
});

test('375px mobile layout has no horizontal overflow and every tab and form is reachable', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await openStudio(page);
    for (const name of ['characters', 'voices', 'design', 'prompt', 'connection']) {
        await tab(page, name).click();
        await expect(tab(page, name)).toHaveAttribute('aria-current', 'page');
        await expect(panel(page).locator(`[data-page="${name}"]`)).toBeVisible();
        const bounds = await panel(page).evaluate(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, scroll: node.scrollWidth, width: node.clientWidth }));
        expect(bounds.left).toBeGreaterThanOrEqual(0);
        expect(bounds.right).toBeLessThanOrEqual(375.5);
        expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1);
    }
    await tab(page, 'voices').click();
    await panel(page).locator('.upload-panel summary').click();
    await panel(page).locator('[data-upload] [name="name"]').fill('手机输入验证');
    await expect(panel(page).locator('[data-upload] [name="name"]')).toHaveValue('手机输入验证');
    await tab(page, 'characters').click();
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/studio-mobile.png' });
    await panel(page).locator('[data-close]').click();
    await expect(page.locator('#extensionsMenuButton')).toBeFocused();
});

test('reference direction creates candidates from multipart audio and saves the generated transcript', async ({ page, request }) => {
    await openStudio(page);
    await tab(page, 'design').click();
    const form = panel(page).locator('[data-design]');
    await expect(form.locator('[data-direction-fields]')).toBeHidden();
    await form.locator('[name="mode"]').selectOption('direction');
    await expect(form.locator('[data-direction-fields]')).toBeVisible();
    await expect(form.locator('[name="instruction"]')).not.toHaveAttribute('required', '');
    const reference = await request.get(`/breeze/voices/${voiceIds[0]}/audio`);
    const audio = { name: 'direction-reference.wav', mimeType: 'audio/wav', buffer: await reference.body() };
    await form.locator('[name="audio"]').setInputFiles(audio);
    await expect(form.locator('[data-direction-preview]')).toBeVisible();
    await form.locator('[name="ref_text"]').fill('原始音频中的准确文字。');
    await form.locator('[name="text"]').fill('这是新生成的试听内容。[笑]');
    await form.locator('[name="count"]').fill('2');
    await form.locator('button').first().click();
    await expect(panel(page).locator('[data-candidates] audio')).toHaveCount(2);
    const candidate = panel(page).locator('[data-candidates] .breeze-voice').last();
    await candidate.locator('input').fill('参考方向 · 新音色');
    await candidate.getByRole('button', { name: '保存此音色' }).click();
    await expect(candidate.getByRole('button', { name: '已保存' })).toBeDisabled();
    let state = await (await request.get('/__demo/state')).json();
    expect(state.requests).toHaveLength(2);
    for (const job of state.requests) {
        expect(job).toMatchObject({ kind: 'direction', instruction: '', text: '这是新生成的试听内容。[笑]', ref_text: '原始音频中的准确文字。', audio: { name: audio.name, size: audio.buffer.length } });
    }
    expect(state.requests[1].seed).toBe(state.requests[0].seed + 1);
    expect(state.voices.find(voice => voice.name === '参考方向 · 新音色').ref_text).toBe('这是新生成的试听内容。[笑]');
    await panel(page).locator('.page-scroll').evaluate(node => { node.scrollTop = 0; });
    await page.screenshot({ path: 'test-results/studio-direction.png' });
    // Cancelling this mode must use the same cleanup route as text-only candidates.
    await form.locator('[name="instruction"]').fill('[演示慢速]');
    await form.locator('button').first().click();
    await expect(panel(page).locator('[data-candidates]')).toContainText('生成中');
    await form.locator('[data-cancel-design]').click();
    await expect(form.locator('button').first()).toBeEnabled();
    state = await (await request.get('/__demo/state')).json();
    expect(state.cancelled).toEqual([state.requests[2].id]);
    await form.locator('[name="mode"]').selectOption('design');
    await expect(form.locator('[data-direction-fields]')).toBeHidden();
    await expect(form.locator('[name="audio"]')).toBeDisabled();
    await expect(form.locator('[name="instruction"]')).toHaveAttribute('required', '');
    await page.setViewportSize({ width: 375, height: 812 });
    await form.locator('[name="mode"]').selectOption('direction');
    await form.locator('[name="ref_text"]').fill('窄屏也能填写参考音频文字。');
    const bounds = await panel(page).evaluate(node => ({ width: node.clientWidth, scroll: node.scrollWidth }));
    expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1);
});

test('preview playback respects volume and pauses on navigation; failed service change clears stale voices', async ({ page }) => {
    await openStudio(page);
    await tab(page, 'connection').click();
    const volume = panel(page).locator('[data-setting="volume"]');
    await volume.press('Home');
    for (let step = 0; step < 7; step++) await volume.press('ArrowRight');
    await expect(volume).toHaveValue('0.35');
    await tab(page, 'voices').click();
    const audio = panel(page).locator('[data-voices] audio').first();
    // Keep the short demo tone alive long enough to verify navigation teardown.
    await audio.evaluate(async node => { node.loop = true; await node.play(); });
    await expect.poll(() => audio.evaluate(node => ({ paused: node.paused, volume: node.volume }))).toEqual({ paused: false, volume: 0.35 });
    await tab(page, 'characters').click();
    await expect.poll(() => audio.evaluate(node => node.paused)).toBe(true);
    const preview = card(page, '周启明').getByRole('button', { name: '试听周启明的音色', includeHidden: true });
    await preview.click();
    await expect(preview).toHaveAttribute('aria-pressed', 'true');
    await tab(page, 'connection').click();
    await expect(preview).toHaveAttribute('aria-pressed', 'false');
    const badBase = new URL('/missing-demo-service', page.url()).href;
    await panel(page).locator('[data-setting="baseUrl"]').fill(badBase);
    await panel(page).locator('[data-connect]').click();
    await expect(panel(page).locator('[data-status]')).toContainText('连接失败');
    await tab(page, 'voices').click();
    await expect(panel(page).locator('[data-voices] .breeze-voice')).toHaveCount(0);
    await tab(page, 'characters').click();
    await expect(panel(page).locator('[data-bound-count]')).toHaveText('0');
    await expect(panel(page).locator('[data-voice-count]')).toHaveText('0');
    await expect(card(page, '周启明').getByRole('button', { name: '试听周启明的音色' })).toBeDisabled();
});
