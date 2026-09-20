import { test, expect } from '@playwright/test';
import { DEFAULTS } from '../../extension/core.js';
import { DEFAULT_TEMPLATE, PREVIOUS_DEFAULT_TEMPLATE, PROMPT_DEFAULTS } from '../../extension/prompt.js';

const storageKey = 'breeze-studio-demo-v1';
const studio = page => page.locator('#breeze-studio-host').locator('dialog');
const field = (page, name) => studio(page).locator(`[data-${name}]`);
const injected = page => page.evaluate(() => window.__breezeDemo.context.extensionPrompts.breeze_voice_protocol?.value);

async function openPrompt(page) {
    await expect(page.locator('#breeze_studio_wand_entry')).toBeAttached();
    await page.getByRole('button', { name: '打开扩展菜单' }).click();
    await page.locator('#breeze_studio_wand_entry').click();
    await studio(page).locator('[data-tab="prompt"]').click();
    await expect(field(page, 'prompt-preview')).toBeVisible();
    await expect.poll(() => field(page, 'prompt-preview').inputValue()).toContain('周启明');
}

async function seedSavedTemplate(page, template) {
    return page.evaluate(({ template, storageKey, defaults }) => {
        const context = window.__breezeDemo.context;
        const settings = {
            ...defaults,
            ...context.extensionSettings.breeze_voice,
            promptTemplate: template,
            promptDepth: 3,
            vocalEvents: '[轻笑]\n[吸气]',
            extraPromptPresets: [
                { id: 'campus-afternoon', name: '周五下午', text: '周五下课后，朋友们语气轻松；只有笑出声时才加入 [轻笑]。' },
                { id: 'quiet-library', name: '图书馆', text: '压低声音，情绪平稳。' },
            ],
        };
        const chats = {
            'demo-campus-chat': {
                breeze_voice: {
                    mappings: { '周启明': '1'.repeat(32), '林知夏': '2'.repeat(32), '沈予安': '3'.repeat(32) },
                    manual: ['沈予安'], cache: {}, extraPromptId: 'campus-afternoon', extraPromptEnabled: true,
                },
            },
            'demo-second-chat': {
                breeze_voice: {
                    mappings: { '周启明': '3'.repeat(32) }, manual: [], cache: {},
                    extraPromptId: 'quiet-library', extraPromptEnabled: false,
                },
            },
        };
        sessionStorage.setItem(storageKey, JSON.stringify({ settings: { breeze_voice: settings }, chats }));
        return { settings, chats };
    }, { template, storageKey, defaults: { ...DEFAULTS, ...PROMPT_DEFAULTS } });
}

async function expectPreservedConfiguration(page, saved, template) {
    const actual = await page.evaluate(storageKey => ({
        settings: window.__breezeDemo.context.extensionSettings.breeze_voice,
        metadata: window.__breezeDemo.context.chatMetadata,
        persisted: JSON.parse(sessionStorage.getItem(storageKey)),
    }), storageKey);
    expect(actual.settings).toEqual({ ...saved.settings, promptTemplate: template });
    expect(actual.metadata).toEqual(saved.chats['demo-campus-chat']);
    expect(actual.persisted.settings.breeze_voice).toEqual({ ...saved.settings, promptTemplate: template });
    expect(actual.persisted.chats).toEqual(saved.chats);
    await expect(field(page, 'prompt-template')).toHaveValue(template);
    await expect(field(page, 'vocal-events')).toHaveValue('[轻笑]\n[吸气]');
    await expect(field(page, 'extra-prompt-select')).toHaveValue('campus-afternoon');
    await expect(field(page, 'extra-prompt-enabled')).toBeChecked();
    await expect(field(page, 'extra-prompt-name')).toHaveValue('周五下午');
    const preview = await field(page, 'prompt-preview').inputValue();
    expect(await injected(page)).toBe(preview);
    expect(preview).toContain('[轻笑], [吸气]');
    expect(preview).not.toContain('{{vocal_events}}');
    expect(preview).toContain('"周启明"');
    expect(preview).toContain('"林知夏"');
    expect(preview).toContain('"沈予安"');
    expect(preview.endsWith(`6. Additional scene guidance (current chat):\n${saved.settings.extraPromptPresets[0].text}`)).toBe(true);
    expect(await page.evaluate(() => window.__breezeDemo.context.extensionPrompts.breeze_voice_protocol.depth)).toBe(3);
    return preview;
}

test.beforeEach(async ({ page, request }) => {
    await request.post('/__demo/reset');
    await page.goto('/');
    await expect(page.locator('#breeze_studio_wand_entry')).toBeAttached();
});

test('unchanged 0.5/0.6 default upgrades on boot, retaining chat bindings and updating live injection without restore', async ({ page, request }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const saved = await seedSavedTemplate(page, PREVIOUS_DEFAULT_TEMPLATE);
    expect(DEFAULT_TEMPLATE).not.toBe(PREVIOUS_DEFAULT_TEMPLATE);
    let firstPreview;
    for (let attempt = 0; attempt < 2; attempt++) {
        await page.reload();
        await openPrompt(page);
        const preview = await expectPreservedConfiguration(page, saved, DEFAULT_TEMPLATE);
        if (attempt === 0) firstPreview = preview;
        else expect(preview).toBe(firstPreview);
    }
    const state = await (await request.get('/__demo/state')).json();
    expect(state.voices.map(voice => voice.id)).toEqual(['1'.repeat(32), '2'.repeat(32), '3'.repeat(32)]);
    expect(state.requests).toEqual([]);
    expect(errors).toEqual([]);
});

test('a user-edited old default retains its formatting constraints through boot and reload', async ({ page, request }) => {
    const constraints = '\n\nMy existing preset constraints: keep <w2g>, <catsay>, and the summary in their original order. Keep every quoted line in ordinary prose.\nDo not change my scene pacing or paragraph style.';
    const template = PREVIOUS_DEFAULT_TEMPLATE + constraints;
    const saved = await seedSavedTemplate(page, template);
    for (let attempt = 0; attempt < 2; attempt++) {
        await page.reload();
        await openPrompt(page);
        const preview = await expectPreservedConfiguration(page, saved, template);
        expect(preview).toContain(constraints);
    }
    expect((await (await request.get('/__demo/state')).json()).requests).toEqual([]);
});
