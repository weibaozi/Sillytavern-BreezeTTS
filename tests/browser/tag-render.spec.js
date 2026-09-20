import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const studio = page => page.locator('#breeze-studio-host').locator('dialog');
const body = page => page.locator('#chat .mes_text');
const bubbles = page => page.locator('#chat .breeze-bubble');
const rawMessage = page => page.evaluate(() => window.__breezeDemo.context.chat[0].mes);
const occurrences = (text, needle) => text.split(needle).length - 1;

async function replaceMessage(page, raw, displayed = raw) {
    await page.evaluate(({ raw, displayed }) => {
        const demo = window.__breezeDemo;
        demo.context.chat[0].mes = raw;
        document.querySelector('#chat .mes_text').textContent = displayed;
        demo.emit('MESSAGE_UPDATED', 0);
    }, { raw, displayed });
}

async function openStudio(page, tab = 'connection') {
    await page.getByRole('button', { name: '打开扩展菜单' }).click();
    await page.locator('#breeze_studio_wand_entry').click();
    await studio(page).locator(`[data-tab="${tab}"]`).click();
}

async function setToggle(page, key, enabled) {
    await openStudio(page);
    const control = studio(page).locator(`[data-setting="${key}"]`);
    if (await control.isChecked() !== enabled) await control.locator('..').click();
    if (enabled) await expect(control).toBeChecked();
    else await expect(control).not.toBeChecked();
    await studio(page).locator('[data-close]').click();
}

test.beforeEach(async ({ page, request }) => {
    await request.post('/__demo/reset');
    await page.goto('/');
    await expect(bubbles(page).first()).toHaveAttribute('data-state', 'idle');
});

test('single-copy tags render complete quoted dialogue while raw and TTS request preserve vocal events', async ({ page, request }) => {
    const raw = '周启明拍了拍肚子，一脸理直气壮。\n[TTSVoice:周启明:happy:[笑]你们听见没？它已经在抗议了，我建议尊重民意。]';
    const speech = '你们听见没？它已经在抗议了，我建议尊重民意。';
    await replaceMessage(page, raw);
    await expect(body(page)).toContainText(`“${speech}”`);
    expect(await body(page).innerText()).not.toContain('[TTSVoice:');
    expect(await body(page).innerText()).not.toContain('[笑]');
    expect(await rawMessage(page)).toBe(raw);
    await expect(bubbles(page)).toHaveCount(1);
    await bubbles(page).click();
    await expect(bubbles(page)).toHaveAttribute('data-state', 'ready');
    const state = await (await request.get('/__demo/state')).json();
    expect(state.requests).toHaveLength(1);
    expect(state.requests[0].text).toBe(`[笑]${speech}`);
    expect(await rawMessage(page)).toBe(raw);
});

test('configured vocal events are hidden only in presentation; other bracketed text is preserved', async ({ page }) => {
    await openStudio(page, 'prompt');
    await studio(page).locator('[data-vocal-events]').fill('[笑]\n[吸气]');
    await studio(page).locator('[data-close]').click();
    const raw = '[TTSVoice:周启明:default:[吸气]请看[第二章]，这段很重要。]';
    await replaceMessage(page, raw);
    await expect(body(page)).toContainText('“请看[第二章]，这段很重要。”');
    expect(await body(page).innerText()).not.toContain('[吸气]');
    expect(await rawMessage(page)).toBe(raw);
});

test('round and square vocal events stay in speech requests while unknown parentheses and nested groups remain visible', async ({ page, request }) => {
    await openStudio(page, 'prompt');
    await studio(page).locator('[data-vocal-events]').fill('(quiet laugh)\n[small sigh]');
    await studio(page).locator('[data-close]').click();
    const text = '(laugh)(soft gasps)你好。(quiet laugh)[small sigh]等一下(约5分钟)，再看[附注(laugh)]。';
    const raw = `[TTSVoice:周启明:default:${text}]`;
    await replaceMessage(page, raw);
    await expect(body(page)).toContainText('“你好。等一下(约5分钟)，再看[附注(laugh)]。”');
    expect(await body(page).innerText()).not.toContain('(soft gasps)');
    expect(await body(page).innerText()).not.toContain('(quiet laugh)');
    await expect(bubbles(page)).toHaveCount(1);
    await bubbles(page).click();
    await expect(bubbles(page)).toHaveAttribute('data-state', 'ready');
    const state = await (await request.get('/__demo/state')).json();
    expect(state.requests).toHaveLength(1);
    expect(state.requests[0].text).toBe(text);
    expect(await rawMessage(page)).toBe(raw);
});

test('streamed permitted round-event prefixes stay hidden without hiding unfinished ordinary parentheses', async ({ page, request }) => {
    await setToggle(page, 'readStreamingText', true);
    await setToggle(page, 'autoGenerate', true);
    await page.evaluate(() => window.__breezeDemo.beginStream());
    const lastBody = page.locator('#chat .mes').last().locator('.mes_text');
    const lastBubbles = page.locator('#chat .mes').last().locator('.breeze-bubble');
    let raw = '[TTSVoice:周启明:default:你好(gas';
    await page.evaluate(text => window.__breezeDemo.streamText(text), raw);
    await expect(lastBody).toHaveText('“你好', { useInnerText: true });
    await expect(lastBubbles).toHaveCount(0);
    expect((await (await request.get('/__demo/state')).json()).requests).toHaveLength(0);
    raw += 'p)一起走(约5';
    await page.evaluate(text => window.__breezeDemo.streamText(text), raw);
    await expect(lastBody).toHaveText('“你好一起走(约5', { useInnerText: true });
    await expect(lastBubbles).toHaveCount(0);
    expect((await (await request.get('/__demo/state')).json()).requests).toHaveLength(0);
    raw += '分钟)[soft gasps]。]';
    await page.evaluate(text => window.__breezeDemo.streamText(text), raw);
    await expect(lastBody).toContainText('“你好一起走(约5分钟)。”');
    await expect(lastBubbles).toHaveCount(1);
    await page.evaluate(() => window.__breezeDemo.finishStream());
    await expect(lastBubbles).toHaveAttribute('data-state', 'ready');
    const state = await (await request.get('/__demo/state')).json();
    expect(state.requests).toHaveLength(1);
    expect(state.requests[0].text).toBe('你好(gasp)一起走(约5分钟)[soft gasps]。');
    expect(await page.evaluate(() => window.__breezeDemo.context.chat.at(-1).mes)).toBe(raw);
});

test('unmapped characters retain all readable dialogue and clicking their bubble opens binding without generation', async ({ page, request }) => {
    const raw = '沈予安看了看时间。\n[TTSVoice:沈予安:New:记得今晚把选题定下来。]';
    await replaceMessage(page, raw);
    await expect(body(page)).toContainText('“记得今晚把选题定下来。”');
    await expect(bubbles(page)).toHaveAttribute('data-state', 'unmapped');
    await bubbles(page).click();
    await expect(studio(page).locator('[data-page="characters"]')).toBeVisible();
    expect((await (await request.get('/__demo/state')).json()).requests).toEqual([]);
    expect(await rawMessage(page)).toBe(raw);
});

test('consecutive identical utterances retain both tag occurrences instead of treating the first as legacy prose', async ({ page }) => {
    const raw = '[TTSVoice:周启明:default:等等。]\n[TTSVoice:周启明:default:等等。]';
    await replaceMessage(page, raw);
    await expect(bubbles(page)).toHaveCount(2);
    await expect.poll(async () => occurrences(await body(page).innerText(), '“等等。”')).toBe(2);
    expect(await rawMessage(page)).toBe(raw);
});

test('legacy quoted prose plus its TTS copy renders one readable utterance and retains surrounding prose', async ({ page }) => {
    const raw = '周启明挥了挥手。“走吧，去食堂。”\n[TTSVoice:周启明:happy:[笑]走吧，去食堂。]\n他转身走向楼梯。';
    await replaceMessage(page, raw);
    await expect(bubbles(page)).toHaveCount(1);
    await expect.poll(async () => occurrences(await body(page).innerText(), '走吧，去食堂。')).toBe(1);
    await expect(body(page)).toContainText('周启明挥了挥手。');
    await expect(body(page)).toContainText('他转身走向楼梯。');
    expect(await rawMessage(page)).toBe(raw);
});

test('missing inline tags use a full-length fallback without truncating dialogue beyond 90 characters', async ({ page }) => {
    const speech = '这是完整的长对白，需要一直显示到最后，不能只保留预览。'.repeat(7) + '最后一句也必须完整。';
    const raw = `旁白照常显示。\n[TTSVoice:周启明:default:[笑]${speech}]`;
    await replaceMessage(page, raw, '旁白照常显示。');
    const fallback = page.locator('#chat .breeze-fallback');
    await expect(fallback).toHaveCount(1);
    await expect(fallback).toContainText(`“${speech}”`);
    expect(await fallback.innerText()).not.toContain('[笑]');
    expect(await rawMessage(page)).toBe(raw);
});

test('legacy fallback with narration between multiple quoted runs does not append a merged duplicate', async ({ page }) => {
    const prose = '周启明抬手。“等一下。”他合上本子。“现在可以了。”';
    const raw = `${prose}\n[TTSVoice:周启明:happy:[笑]等一下。现在可以了。]`;
    await replaceMessage(page, raw, prose);
    const fallback = page.locator('#chat .breeze-fallback');
    await expect(fallback).toHaveCount(1);
    await expect(fallback.locator('.breeze-bubble')).toHaveCount(1);
    await expect(fallback.locator('.breeze-dialogue')).toHaveCount(0);
    await expect(body(page)).toHaveText(prose);
    expect(await page.locator('#chat').innerText()).not.toContain('“等一下。现在可以了。”');
    expect(await rawMessage(page)).toBe(raw);
});

test('rerenders are idempotent and disabling restores the original tag without mutating chat data', async ({ page }) => {
    const raw = '他回过头。\n[TTSVoice:周启明:happy:[笑]还有别的安排吗？]';
    await replaceMessage(page, raw);
    await expect(body(page)).toContainText('“还有别的安排吗？”');
    for (const event of ['CHARACTER_MESSAGE_RENDERED', 'MORE_MESSAGES_LOADED', 'MESSAGE_UPDATED', 'CHAT_LOADED']) {
        const before = await bubbles(page).elementHandle();
        await page.evaluate(event => window.__breezeDemo.emit(event, 0), event);
        await expect.poll(() => before.evaluate(node => node.isConnected)).toBe(false);
        await expect(bubbles(page)).toHaveCount(1);
        await expect.poll(async () => occurrences(await body(page).innerText(), '“还有别的安排吗？”')).toBe(1);
    }
    await setToggle(page, 'enabled', false);
    await expect(bubbles(page)).toHaveCount(0);
    await expect(body(page)).toHaveText(raw);
    expect(await rawMessage(page)).toBe(raw);
    await setToggle(page, 'enabled', true);
    await expect(bubbles(page)).toHaveCount(1);
    await expect(body(page)).toContainText('“还有别的安排吗？”');
});

test('raw tag display shows original syntax and hides synthesized quotes until enabled again', async ({ page }) => {
    const raw = '[TTSVoice:周启明:happy:[笑]准备好了吗？]';
    await replaceMessage(page, raw);
    await expect(body(page)).toContainText('“准备好了吗？”');
    await setToggle(page, 'hideTags', false);
    await expect.poll(() => body(page).innerText()).toContain(raw);
    expect(await body(page).innerText()).not.toContain('“准备好了吗？”');
    await expect(bubbles(page)).toHaveCount(1);
    await setToggle(page, 'hideTags', true);
    await expect(body(page)).toContainText('“准备好了吗？”');
    expect(await body(page).innerText()).not.toContain('[TTSVoice:');
    expect(await rawMessage(page)).toBe(raw);
});

test('desktop and mobile surfaces clearly identify this experimental branch and stay within viewport', async ({ page }) => {
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/single-copy-chat-desktop.png' });
    await openStudio(page, 'prompt');
    await expect(studio(page)).toContainText('TTSVoice 单份对白实验版');
    await page.screenshot({ path: 'test-results/single-copy-prompt-desktop.png' });
    await page.setViewportSize({ width: 375, height: 812 });
    const bounds = await studio(page).evaluate(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, scroll: node.scrollWidth, width: node.clientWidth }));
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(375.5);
    expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1);
    await page.screenshot({ path: 'test-results/single-copy-prompt-mobile.png' });
    await studio(page).locator('[data-close]').click();
    await page.screenshot({ path: 'test-results/single-copy-chat-mobile.png' });
});
