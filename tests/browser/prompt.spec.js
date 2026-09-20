import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const defaults = '[笑]\n[叹气]\n[咳嗽]\n[清嗓子]';
const studio = page => page.locator('#breeze-studio-host').locator('dialog');
const field = (page, name) => studio(page).locator(`[data-${name}]`);
const injected = page => page.evaluate(() => window.__breezeDemo.context.extensionPrompts.breeze_voice_protocol?.value);
const presets = page => page.evaluate(() => window.__breezeDemo.context.extensionSettings.breeze_voice.extraPromptPresets);
const selectedId = page => page.evaluate(() => window.__breezeDemo.context.chatMetadata.breeze_voice.extraPromptId);

async function renamePreset(page, name) {
    await field(page, 'extra-prompt-name').fill(name);
    await field(page, 'extra-prompt-name').dispatchEvent('change');
}

async function createPreset(page, name, text = '') {
    await field(page, 'new-extra-prompt').click();
    await expect(field(page, 'extra-prompt-name')).toBeEnabled();
    await renamePreset(page, name);
    await field(page, 'extra-prompt').fill(text);
    await expect(field(page, 'extra-prompt-select')).toHaveValue(await selectedId(page));
    return selectedId(page);
}

async function switchChat(page, id) {
    await page.evaluate(id => window.__breezeDemo.switchChat(id), id);
}

async function openPrompt(page) {
    await page.getByRole('button', { name: '打开扩展菜单' }).click();
    await page.locator('#breeze_studio_wand_entry').click();
    await studio(page).locator('[data-tab="prompt"]').click();
    await expect(field(page, 'prompt-preview')).toBeVisible();
    await expect.poll(() => field(page, 'prompt-preview').inputValue()).toContain('周启明');
}

async function extraEnabled(page, enabled) {
    const toggle = field(page, 'extra-prompt-enabled');
    if (await toggle.isChecked() !== enabled) await toggle.locator('..').click();
    if (enabled) await expect(toggle).toBeChecked();
    else await expect(toggle).not.toBeChecked();
}

test.beforeEach(async ({ page, request }) => {
    await request.post('/__demo/reset');
    await page.goto('/');
    await expect(page.locator('#breeze_studio_wand_entry')).toBeAttached();
    await openPrompt(page);
});

test('vocal-event list starts with four defaults and updates both preview and injection live, including empty and reset', async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await expect(field(page, 'vocal-events')).toHaveValue(defaults);
    await expect.poll(() => field(page, 'prompt-preview').inputValue()).toContain('[笑], [叹气], [咳嗽], [清嗓子]');
    const template = await field(page, 'prompt-template').inputValue();
    await field(page, 'vocal-events').fill('[喘气]\n[轻笑]');
    await expect.poll(() => field(page, 'prompt-preview').inputValue()).toContain('[喘气], [轻笑]');
    let preview = await field(page, 'prompt-preview').inputValue();
    expect(preview).not.toContain('[笑]');
    expect(preview).not.toContain('[叹气]');
    expect(preview).toContain('[TTSVoice:周启明:softly reassuring:[喘气]');
    expect(await injected(page)).toBe(preview);
    expect(await page.evaluate(() => window.__breezeDemo.context.extensionSettings.breeze_voice.vocalEvents)).toBe('[喘气]\n[轻笑]');
    await expect(field(page, 'prompt-template')).toHaveValue(template);

    await field(page, 'vocal-events').fill('');
    await expect.poll(() => field(page, 'prompt-preview').inputValue()).toContain('None');
    preview = await field(page, 'prompt-preview').inputValue();
    expect(preview).not.toContain('[喘气]');
    expect(preview).not.toContain('[笑]');
    expect(await injected(page)).toBe(preview);
    await field(page, 'reset-vocal-events').click();
    await expect(field(page, 'vocal-events')).toHaveValue(defaults);
    expect(await injected(page)).toBe(await field(page, 'prompt-preview').inputValue());
    expect(errors).toEqual([]);
});

test('saved custom template and unrelated formatting remain intact while vocal events persist through reload', async ({ page }) => {
    const template = 'Keep TGbreak modules unchanged: <w2g>, <catsay>, summary.\nAllowed sounds: {{vocal_events}}\n{{bound_characters_section}}';
    await field(page, 'prompt-template').fill(template);
    await field(page, 'save-prompt').click();
    await field(page, 'vocal-events').fill('吸气， [轻笑]\n吸气');
    await expect.poll(() => field(page, 'prompt-preview').inputValue()).toContain('Allowed sounds: [吸气], [轻笑]');
    await expect(field(page, 'prompt-template')).toHaveValue(template);
    expect(await injected(page)).toContain('Keep TGbreak modules unchanged: <w2g>, <catsay>, summary.');
    await page.reload();
    await expect(page.locator('#breeze_studio_wand_entry')).toBeAttached();
    await openPrompt(page);
    await expect(field(page, 'prompt-template')).toHaveValue(template);
    await expect(field(page, 'vocal-events')).toHaveValue('吸气， [轻笑]\n吸气');
    expect(await injected(page)).toBe(await field(page, 'prompt-preview').inputValue());
    expect(await injected(page)).toContain('Allowed sounds: [吸气], [轻笑]');
});

test('named guidance becomes a final sixth rule only when selected, enabled and nonblank; disabling keeps its binding', async ({ page }) => {
    await expect(field(page, 'extra-prompt-enabled')).not.toBeChecked();
    await expect(field(page, 'extra-prompt')).toHaveValue('');
    await expect(field(page, 'extra-prompt')).toBeDisabled();
    expect(await injected(page)).not.toContain('6. Additional scene guidance');
    const id = await createPreset(page, '校园晚自习');
    await expect(field(page, 'extra-prompt-enabled')).toBeChecked();
    expect(await injected(page)).not.toContain('6. Additional scene guidance');
    const guidance = '校园晚自习后，情绪放松但说话轻一些。\n只有真正笑出声时才使用 [笑]。';
    await field(page, 'extra-prompt').fill(guidance);
    await expect.poll(() => injected(page)).toContain(`6. Additional scene guidance (current chat):\n${guidance}`);
    expect((await injected(page)).endsWith(`6. Additional scene guidance (current chat):\n${guidance}`)).toBe(true);
    expect(await injected(page)).toBe(await field(page, 'prompt-preview').inputValue());
    await extraEnabled(page, false);
    expect(await injected(page)).not.toContain(guidance);
    expect(await selectedId(page)).toBe(id);
    await expect(field(page, 'extra-prompt')).toHaveValue(guidance);
    await extraEnabled(page, true);
    expect(await injected(page)).toContain(guidance);
    await field(page, 'extra-prompt').fill('  \n ');
    expect(await injected(page)).not.toContain('6. Additional scene guidance');
});

test('named presets can be reused across chats while each chat keeps its own binding through reload', async ({ page }) => {
    await field(page, 'vocal-events').fill('[轻笑]\n[吸气]');
    const first = '聊天 A：迎新日，三位同学轻松地互相认识。';
    const second = '聊天 B：考试前的图书馆，保持安静克制。';
    const firstId = await createPreset(page, '迎新日', first);
    await switchChat(page, 'demo-second-chat');
    await expect(field(page, 'extra-prompt')).toHaveValue('');
    await expect(field(page, 'extra-prompt-enabled')).not.toBeChecked();
    await expect(field(page, 'vocal-events')).toHaveValue('[轻笑]\n[吸气]');
    expect(await injected(page)).not.toContain(first);
    await field(page, 'extra-prompt-select').selectOption({ label: '迎新日' });
    await extraEnabled(page, true);
    await expect(field(page, 'extra-prompt')).toHaveValue(first);
    expect(await selectedId(page)).toBe(firstId);
    expect(await injected(page)).toContain(first);
    const secondId = await createPreset(page, '安静图书馆', second);
    expect(secondId).not.toBe(firstId);
    expect(await injected(page)).toContain(second);
    await switchChat(page, 'demo-campus-chat');
    expect(await selectedId(page)).toBe(firstId);
    await expect(field(page, 'extra-prompt')).toHaveValue(first);
    await expect(field(page, 'extra-prompt-enabled')).toBeChecked();
    expect(await injected(page)).toContain(first);
    expect(await injected(page)).not.toContain(second);
    await page.reload();
    await expect(page.locator('#breeze_studio_wand_entry')).toBeAttached();
    await openPrompt(page);
    await expect(field(page, 'extra-prompt')).toHaveValue(first);
    await expect(field(page, 'extra-prompt-enabled')).toBeChecked();
    expect(await injected(page)).toContain(first);
    await switchChat(page, 'demo-second-chat');
    expect(await selectedId(page)).toBe(secondId);
    await expect(field(page, 'extra-prompt')).toHaveValue(second);
    expect(await injected(page)).not.toContain(first);
    expect((await presets(page)).map(preset => preset.name)).toEqual(['迎新日', '安静图书馆']);
});

test('shared text edits and renaming update every bound chat without changing preset identity', async ({ page }) => {
    const id = await createPreset(page, '考试前', '考试前，小声讨论重点。');
    await switchChat(page, 'demo-second-chat');
    await field(page, 'extra-prompt-select').selectOption({ label: '考试前' });
    await extraEnabled(page, true);
    await renamePreset(page, '考前图书馆');
    const revision = '考前图书馆，所有人语气克制；只有真实叹气时使用 [叹气]。';
    await field(page, 'extra-prompt').fill(revision);
    expect(await selectedId(page)).toBe(id);
    expect(await injected(page)).toContain(revision);
    await switchChat(page, 'demo-campus-chat');
    await expect(field(page, 'extra-prompt-name')).toHaveValue('考前图书馆');
    await expect(field(page, 'extra-prompt')).toHaveValue(revision);
    expect(await selectedId(page)).toBe(id);
    expect(await injected(page)).toContain(revision);
    await page.reload();
    await openPrompt(page);
    expect(await selectedId(page)).toBe(id);
    expect(await presets(page)).toEqual([{ id, name: '考前图书馆', text: revision }]);
});

test('copying creates an independent preset and rejects blank or duplicate names', async ({ page }) => {
    const id = await createPreset(page, '平静校园', '语气放松。');
    await field(page, 'copy-extra-prompt').click();
    const copyId = await selectedId(page), copyName = await field(page, 'extra-prompt-name').inputValue();
    expect(copyId).not.toBe(id);
    expect(copyName).toBeTruthy();
    expect(copyName).not.toBe('平静校园');
    await expect(field(page, 'extra-prompt')).toHaveValue('语气放松。');
    await expect(field(page, 'extra-prompt-enabled')).toBeChecked();
    await field(page, 'extra-prompt').fill('语气紧张，偶尔 [叹气]。');
    await renamePreset(page, '平静校园');
    expect((await presets(page)).find(preset => preset.id === copyId).name).toBe(copyName);
    await renamePreset(page, '   ');
    expect((await presets(page)).find(preset => preset.id === copyId).name).toBe(copyName);
    await renamePreset(page, '紧张校园');
    await field(page, 'extra-prompt-select').selectOption({ label: '平静校园' });
    await expect(field(page, 'extra-prompt')).toHaveValue('语气放松。');
    expect(await selectedId(page)).toBe(id);
    expect((await presets(page)).find(preset => preset.id === copyId).text).toBe('语气紧张，偶尔 [叹气]。');
});

test('deleting shared guidance requires confirmation and stale bindings never revive legacy content', async ({ page }) => {
    const text = '傍晚校园，声音轻松。';
    const id = await createPreset(page, '傍晚', text);
    await switchChat(page, 'demo-second-chat');
    await field(page, 'extra-prompt-select').selectOption({ label: '傍晚' });
    await extraEnabled(page, true);
    // A migrated chat may still carry its old field. Deleting its selected library entry must not resurrect it.
    await page.evaluate(() => {
        window.__breezeDemo.context.chatMetadata.breeze_voice.extraPrompt = '已删除的旧语料不能重新注入。';
        window.__breezeDemo.context.saveMetadata();
    });
    await switchChat(page, 'demo-campus-chat');
    page.once('dialog', dialog => dialog.dismiss());
    await field(page, 'delete-extra-prompt').click();
    expect(await selectedId(page)).toBe(id);
    expect(await injected(page)).toContain(text);
    page.once('dialog', dialog => dialog.accept());
    await field(page, 'delete-extra-prompt').click();
    expect(await selectedId(page)).toBeFalsy();
    expect(await presets(page)).toHaveLength(0);
    expect(await injected(page)).not.toContain(text);
    await switchChat(page, 'demo-second-chat');
    await expect(field(page, 'extra-prompt')).toHaveValue('');
    expect(await injected(page)).not.toContain(text);
    expect(await injected(page)).not.toContain('已删除的旧语料');
    expect(await injected(page)).not.toContain('6. Additional scene guidance');
    expect(await presets(page)).toHaveLength(0);
});

test('legacy chat guidance migrates on opening each chat without duplicates or losing disabled drafts', async ({ page }) => {
    const first = '旧聊天 A 的校园语料。', second = '旧聊天 B 尚未开启的情绪指导。';
    await page.evaluate(({ first, second }) => {
        const settings = { ...window.__breezeDemo.context.extensionSettings.breeze_voice };
        delete settings.extraPromptPresets;
        sessionStorage.setItem('breeze-studio-demo-v1', JSON.stringify({
            settings: { breeze_voice: settings },
            chats: {
                'demo-campus-chat': { breeze_voice: { mappings: { '周启明': '1'.repeat(32) }, manual: [], cache: {}, extraPrompt: first, extraPromptEnabled: true } },
                'demo-second-chat': { breeze_voice: { mappings: { '周启明': '1'.repeat(32) }, manual: [], cache: {}, extraPrompt: second, extraPromptEnabled: false } },
            },
        }));
    }, { first, second });
    await page.reload();
    await openPrompt(page);
    const firstId = await selectedId(page);
    expect(firstId).toBeTruthy();
    expect(await presets(page)).toHaveLength(1);
    await expect(field(page, 'extra-prompt')).toHaveValue(first);
    expect(await injected(page)).toContain(first);
    await page.reload();
    await openPrompt(page);
    expect(await selectedId(page)).toBe(firstId);
    expect(await presets(page)).toHaveLength(1);
    await switchChat(page, 'demo-second-chat');
    const secondId = await selectedId(page);
    expect(secondId).toBeTruthy();
    expect(secondId).not.toBe(firstId);
    expect(await presets(page)).toHaveLength(2);
    await expect(field(page, 'extra-prompt-enabled')).not.toBeChecked();
    await expect(field(page, 'extra-prompt')).toHaveValue(second);
    expect(await injected(page)).not.toContain(second);
    await switchChat(page, 'demo-campus-chat');
    await switchChat(page, 'demo-second-chat');
    expect(await selectedId(page)).toBe(secondId);
    expect(await presets(page)).toHaveLength(2);
    await extraEnabled(page, true);
    expect(await injected(page)).toContain(second);
});

test('guidance binding and editing controls are disabled when no chat is open', async ({ page }) => {
    await createPreset(page, '现有语料', '当前聊天的情绪指导。');
    await page.evaluate(() => {
        window.__breezeDemo.context.chatId = '';
        window.__breezeDemo.emit('CHAT_CHANGED');
    });
    for (const control of ['extra-prompt-select', 'extra-prompt-enabled', 'extra-prompt-name', 'extra-prompt', 'new-extra-prompt', 'copy-extra-prompt', 'delete-extra-prompt']) {
        await expect(field(page, control)).toBeDisabled();
    }
    expect(await injected(page)).not.toContain('当前聊天的情绪指导。');
    expect(await presets(page)).toHaveLength(1);
});

test('prompt modules are usable at 375px with no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await field(page, 'vocal-events').fill('[笑]\n[叹气]\n[咳嗽]\n[清嗓子]\n[吸气]');
    await createPreset(page, '校园傍晚', '校园傍晚，语气轻松自然；不要每句话都添加语气词。');
    await expect.poll(() => field(page, 'prompt-preview').inputValue()).toContain('6. Additional scene guidance');
    for (const selector of ['dialog', '.page-scroll', '[data-page="prompt"]']) {
        const node = selector === 'dialog' ? studio(page) : studio(page).locator(selector);
        const bounds = await node.evaluate(element => ({ left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, scroll: element.scrollWidth, width: element.clientWidth }));
        expect(bounds.left).toBeGreaterThanOrEqual(0);
        expect(bounds.right).toBeLessThanOrEqual(375.5);
        expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1);
    }
    await studio(page).locator('.page-scroll').evaluate(node => { node.scrollTop = 0; });
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/studio-prompt-mobile.png' });
    await field(page, 'extra-prompt-select').scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'test-results/studio-prompt-guidance-mobile.png' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await field(page, 'extra-prompt-select').scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'test-results/studio-prompt-desktop.png' });
});
