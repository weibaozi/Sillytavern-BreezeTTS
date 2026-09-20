import { test, expect } from '@playwright/test';

const panel = page => page.locator('#breeze-floating-controls');
const controls = page => panel(page).locator('.breeze-message-controls');
const target = page => panel(page).getByRole('combobox', { name: '朗读的回复' });
const play = page => panel(page).locator('.breeze-message-play');
const pause = page => panel(page).locator('.breeze-message-pause');
const stop = page => panel(page).locator('.breeze-message-stop');
const refresh = page => panel(page).locator('.breeze-message-refresh');
const timeline = page => panel(page).getByRole('slider', { name: '本条语音播放进度' });
const collapse = page => panel(page).getByRole('button', { name: '收起语音面板', exact: true });
const expand = page => panel(page).getByRole('button', { name: '展开语音面板', exact: true });
const state = async request => (await request.get('/__demo/state')).json();
const savedPosition = page => page.evaluate(() => window.__breezeDemo.context.extensionSettings.breeze_voice.floatingControlsPosition);
const speech = text => `[TTSVoice:周启明:default:${text}]`;
const audioState = page => page.evaluate(() => {
    const audio = window.__floatingAudio.at(-1);
    return audio ? { time: audio.currentTime, paused: audio.paused, src: audio.getAttribute('src'), ended: audio.ended,
        ready: audio.readyState >= 2 && !audio.seeking } : null;
});

async function setMessages(page, messages, { append = false, chatId } = {}) {
    await page.evaluate(({ messages, append, chatId }) => {
        const demo = window.__breezeDemo, chat = document.querySelector('#chat');
        if (!append) { demo.context.chat = []; chat.replaceChildren(); }
        for (const fixture of messages) {
            const id = demo.context.chat.length;
            const message = { mes: fixture.text, swipe_id: 0, is_user: false, name: '周启明', ...fixture };
            demo.context.chat.push(message);
            const row = document.createElement('div'), body = document.createElement('div');
            row.className = 'mes'; row.setAttribute('mesid', String(id));
            body.className = 'mes_text'; body.textContent = message.mes;
            row.append(body); chat.append(row);
        }
        if (chatId) demo.switchChat(chatId);
        else demo.emit('MORE_MESSAGES_LOADED');
    }, { messages, append, chatId });
    for (const fixture of messages) {
        if (fixture.is_user || fixture.is_system) continue;
        const dialogue = fixture.text.match(/\[TTSVoice:[^:]+:[^:]+:([^\]]+)\]/)?.[1];
        if (dialogue) await expect(page.locator('#chat .breeze-dialogue').filter({ hasText: dialogue }).first()).toBeVisible();
    }
}

async function seek(page, percent) {
    await expect(timeline(page)).toBeEnabled();
    await timeline(page).evaluate((node, value) => {
        node.value = String(value);
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
    }, percent);
}

async function drag(page, handle, dx, dy, { x, y } = {}) {
    const box = await handle.boundingBox();
    const from = { x: box.x + (x ?? box.width / 2), y: box.y + (y ?? box.height / 2) };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + dx, from.y + dy, { steps: 12 });
    await page.mouse.up();
}

async function touchDragTo(page, handle, x, y) {
    const box = await handle.boundingBox();
    const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const session = await page.context().newCDPSession(page);
    try {
        await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...from, id: 1 }] });
        for (let step = 1; step <= 12; step++) {
            await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{
                x: from.x + (x - from.x) * step / 12,
                y: from.y + (y - from.y) * step / 12, id: 1,
            }] });
        }
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally { await session.detach(); }
}

async function expectInsideViewport(page) {
    await expect.poll(async () => {
        const box = await panel(page).boundingBox(), viewport = page.viewportSize();
        return box && box.x >= 0 && box.y >= 0
            && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1;
    }).toBe(true);
}

test.beforeEach(async ({ page, request }) => {
    await request.post('/__demo/reset');
    await page.addInitScript(() => {
        window.__floatingAudio = [];
        const OriginalAudio = window.Audio;
        window.Audio = function (...args) {
            const audio = new OriginalAudio(...args);
            audio.playbackRate = .2;
            window.__floatingAudio.push(audio);
            return audio;
        };
        window.Audio.prototype = OriginalAudio.prototype;
    });
    await page.goto('/');
    await expect(panel(page)).toBeVisible();
    await expect(target(page)).toHaveValue('');
    await expect(play(page)).toBeEnabled();
});

test('one floating panel stays visible at the top of a long chat and follows the latest reply', async ({ page }) => {
    await setMessages(page, Array.from({ length: 32 }, (_, index) => ({ text: speech(`第 ${index + 1} 条回复。`) })));
    await page.addStyleTag({ content: '#chat { height: 420px; overflow-y: auto; } #chat .mes { min-height: 140px; }' });
    await page.locator('#chat').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await page.locator('#chat').evaluate(node => { node.scrollTop = 0; });
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(page.locator('#chat .mes').last()).not.toBeInViewport();
    await expect(panel(page)).toHaveCount(1);
    await expect(panel(page)).toBeInViewport();
    await expect(controls(page)).toHaveAttribute('data-message-id', '31');
    await expect(target(page)).toHaveValue('');
    await expect(page.locator('#chat .breeze-message-controls')).toHaveCount(0);
    await expect(page.locator('#chat .breeze-bubble')).toHaveCount(32);
    expect(await panel(page).evaluate(node => node.closest('#chat'))).toBeNull();
    await expect(panel(page)).toHaveCSS('position', 'fixed');
});

test('collapse and expand preserve playback and the chosen presentation survives reload', async ({ page, request }) => {
    await setMessages(page, [{ text: speech('收起面板时这句话继续播放。') }]);
    await play(page).click();
    await expect.poll(async () => (await audioState(page))?.time ?? 0).toBeGreaterThan(.03);
    const beforeCollapse = (await audioState(page)).time;
    await collapse(page).click();
    await expect(expand(page)).toBeVisible();
    await expect(play(page)).toBeHidden();
    await expect.poll(async () => (await audioState(page))?.time ?? 0).toBeGreaterThan(beforeCollapse + .02);
    expect((await audioState(page)).paused).toBe(false);
    await expand(page).click();
    await expect(stop(page)).toBeEnabled();
    expect((await state(request)).requests).toHaveLength(1);
    expect((await audioState(page)).paused).toBe(false);
    await collapse(page).click();
    await expect.poll(() => page.evaluate(() => window.__breezeDemo.context.extensionSettings.breeze_voice.floatingControlsCollapsed)).toBe(true);
    await page.screenshot({ path: 'test-results/floating-controls-collapsed.png' });
    await page.reload();
    await expect(expand(page)).toBeVisible();
    await expect(play(page)).toBeHidden();
    await expand(page).click();
    await expect(play(page)).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__breezeDemo.context.extensionSettings.breeze_voice.floatingControlsCollapsed)).toBe(false);
    await page.reload();
    await expect(collapse(page)).toBeVisible();
    await expect(target(page)).toHaveValue('');
});

test('the compact Breeze button drags without opening, toggling, or starting playback', async ({ page, request }) => {
    await collapse(page).click();
    await expect(expand(page)).toHaveText('Breeze');
    await expect(panel(page).locator('[data-master-toggle]:visible')).toHaveCount(0);
    await expect(expand(page).locator('svg')).toHaveCount(0);
    const before = await expand(page).boundingBox();
    expect(before.width).toBeLessThan(125);
    await drag(page, expand(page), -260, -155);
    const after = await expand(page).boundingBox();
    expect(Math.abs(after.x - (before.x - 260))).toBeLessThan(2);
    expect(Math.abs(after.y - (before.y - 155))).toBeLessThan(2);
    await expect(expand(page)).toBeVisible();
    await expect(collapse(page)).toBeHidden();
    expect(await page.evaluate(() => window.__breezeDemo.context.extensionSettings.breeze_voice.enabled)).toBe(true);
    expect((await state(request)).requests).toEqual([]);
    await expect.poll(() => savedPosition(page)).toEqual(expect.objectContaining({
        right: expect.any(Number), bottom: expect.any(Number),
    }));
    const position = await savedPosition(page);
    expect(Math.abs(position.right - (page.viewportSize().width - after.x - after.width))).toBeLessThan(1);
    expect(Math.abs(position.bottom - (page.viewportSize().height - after.y - after.height))).toBeLessThan(1);
    await page.screenshot({ path: 'test-results/floating-drag-compact-desktop.png' });
    await expand(page).click();
    await expect(collapse(page)).toBeVisible();
    await expect(panel(page).locator('[data-master-toggle]:visible')).toHaveCount(1);
    await expectInsideViewport(page);
});

test('the header moves the expanded panel while buttons and the playback slider keep their own interactions', async ({ page, request }) => {
    const header = panel(page).locator('[data-drag-handle]');
    const before = await panel(page).boundingBox();
    await drag(page, header, -230, -80, { x: 35, y: 22 });
    const after = await panel(page).boundingBox();
    expect(Math.abs(after.x - (before.x - 230))).toBeLessThan(2);
    expect(Math.abs(after.y - (before.y - 80))).toBeLessThan(2);
    const position = await savedPosition(page);
    expect(position).toEqual(expect.objectContaining({ right: expect.any(Number), bottom: expect.any(Number) }));
    for (const button of [panel(page).locator('[data-master-toggle]'), collapse(page)]) {
        await drag(page, button, -65, 65);
        expect(await savedPosition(page)).toEqual(position);
    }
    await expect(collapse(page)).toBeVisible();
    await expect(panel(page).locator('[data-master-toggle]')).toHaveAttribute('aria-checked', 'true');
    expect((await state(request)).requests).toEqual([]);
    await drag(page, timeline(page), -35, 0);
    expect(await savedPosition(page)).toEqual(position);
    await expect(stop(page)).toBeEnabled();
    await stop(page).click();
    await page.screenshot({ path: 'test-results/floating-drag-expanded-desktop.png' });
});

test('a saved dragged position survives reload and clamps after shrinking the viewport', async ({ page }) => {
    await drag(page, panel(page).locator('[data-drag-handle]'), -670, -240, { x: 35, y: 22 });
    const position = await savedPosition(page), before = await panel(page).boundingBox();
    await page.reload();
    await expect(collapse(page)).toBeVisible();
    await expect.poll(() => savedPosition(page)).toEqual(position);
    const after = await panel(page).boundingBox();
    expect(Math.abs(after.x - before.x)).toBeLessThan(2);
    expect(Math.abs(after.y - before.y)).toBeLessThan(2);
    await page.setViewportSize({ width: 375, height: 640 });
    await expectInsideViewport(page);
    await page.reload();
    await expect(collapse(page)).toBeVisible();
    await expectInsideViewport(page);
});

test('mobile touch dragging and expanding at an edge keep the complete panel in view', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 740 });
    await collapse(page).click();
    const compact = await expand(page).boundingBox();
    expect(compact.width).toBeLessThan(125);
    await touchDragTo(page, expand(page), 4, 4);
    await expect(expand(page)).toBeVisible();
    await expectInsideViewport(page);
    await expect(expand(page)).toHaveText('Breeze');
    await page.screenshot({ path: 'test-results/floating-drag-compact-mobile.png' });
    await expand(page).click();
    await expect(collapse(page)).toBeVisible();
    await expectInsideViewport(page);
    await expect(panel(page).locator('[data-master-toggle]')).toBeInViewport();
    await expect(refresh(page)).toBeInViewport();
    await page.screenshot({ path: 'test-results/floating-drag-expanded-mobile.png' });
});

test('selecting an older assistant reply plays its speech and follow-latest skips user messages', async ({ page, request }) => {
    await setMessages(page, [
        { text: speech('这句属于较早的回复。') },
        { text: speech('这句属于最新的回复。') },
        { text: speech('用户消息不能成为朗读目标。'), is_user: true },
    ]);
    await expect(controls(page)).toHaveAttribute('data-message-id', '1');
    await expect(target(page).locator('option[value="2"]')).toHaveCount(0);
    await target(page).selectOption('0');
    await expect(controls(page)).toHaveAttribute('data-message-id', '0');
    await play(page).click();
    await expect.poll(async () => (await state(request)).requests.map(job => job.text)).toEqual(['这句属于较早的回复。']);
    await stop(page).click();
    await expect(target(page)).toBeEnabled();
    await expect(target(page)).toHaveValue('0');
    await target(page).selectOption('');
    await expect(controls(page)).toHaveAttribute('data-message-id', '1');
    await play(page).click();
    await expect.poll(async () => (await state(request)).requests.map(job => job.text)).toEqual(['这句属于较早的回复。', '这句属于最新的回复。']);
    await stop(page).click();
});

test('an active reply remains the locked target when a newer reply arrives', async ({ page, request }) => {
    await setMessages(page, [{ text: speech('播放中的旧回复。') }]);
    await play(page).click();
    await expect.poll(async () => (await audioState(page))?.time ?? 0).toBeGreaterThan(.02);
    await pause(page).click();
    await expect(pause(page)).toHaveAttribute('aria-pressed', 'true');
    await setMessages(page, [{ text: speech('新回复等空闲后才跟随。') }], { append: true });
    await expect(target(page)).toBeDisabled();
    await expect(controls(page)).toHaveAttribute('data-message-id', '0');
    await expect(pause(page)).toHaveAttribute('aria-pressed', 'true');
    expect((await state(request)).requests.map(job => job.text)).toEqual(['播放中的旧回复。']);
    await stop(page).click();
    await expect(target(page)).toBeEnabled();
    await expect(target(page)).toHaveValue('');
    await expect(controls(page)).toHaveAttribute('data-message-id', '1');
});

test('changing chats stops old playback and resets a pinned target without a stale request', async ({ page, request }) => {
    await setMessages(page, [{ text: speech('旧聊天的固定回复。') }, { text: speech('旧聊天的最新回复。') }]);
    await target(page).selectOption('0');
    await play(page).click();
    await expect.poll(async () => (await audioState(page))?.time ?? 0).toBeGreaterThan(.02);
    const singleton = await panel(page).elementHandle();
    await setMessages(page, [{ text: speech('新聊天第一条回复。') }, { text: speech('新聊天当前应播放的回复。') }], { chatId: 'floating-other-chat' });
    await expect(target(page)).toBeEnabled();
    await expect(target(page)).toHaveValue('');
    await expect(controls(page)).toHaveAttribute('data-message-id', '1');
    await expect(stop(page)).toBeDisabled();
    await expect.poll(async () => (await audioState(page))?.src).toBeNull();
    expect(await singleton.evaluate(node => node.isConnected)).toBe(true);
    await expect(panel(page)).toHaveCount(1);
    await play(page).click();
    await expect.poll(async () => (await state(request)).requests.map(job => job.text)).toEqual(['旧聊天的固定回复。', '新聊天当前应播放的回复。']);
    await stop(page).click();
});

test('seeking cached speech starts inside the correct segment and retains later segments', async ({ page, request }) => {
    await setMessages(page, [{ text: [speech('第一段缓存。'), speech('第二段缓存。'), speech('第三段缓存。')].join('\n') }]);
    await refresh(page).click();
    await expect(panel(page).locator('.breeze-message-feedback')).toHaveText('已重新获取 3 段语音。');
    const jobs = (await state(request)).requests;
    await seek(page, 50);
    await expect.poll(async () => (await audioState(page))?.src).toContain(jobs[1].id);
    await expect.poll(async () => (await audioState(page))?.ready).toBe(true);
    const selected = await audioState(page);
    expect(selected.time).toBeGreaterThanOrEqual(.19);
    expect(selected.time).toBeLessThan(.32);
    await expect.poll(async () => (await audioState(page))?.src).toContain(jobs[2].id);
    await expect(stop(page)).toBeDisabled();
    expect((await state(request)).requests).toHaveLength(3);
});

test('seeking uncached speech prepares missing segments once before starting at the requested position', async ({ page, request }) => {
    await setMessages(page, [{ text: [speech('尚未缓存的第一段。'), speech('尚未缓存的第二段。'), speech('尚未缓存的第三段。')].join('\n') }]);
    await seek(page, 80);
    await expect.poll(async () => (await state(request)).requests.length).toBe(3);
    const jobs = (await state(request)).requests;
    await expect.poll(async () => (await audioState(page))?.src).toContain(jobs[2].id);
    await expect.poll(async () => (await audioState(page))?.ready).toBe(true);
    const selected = await audioState(page);
    expect(selected.time).toBeGreaterThanOrEqual(.15);
    expect(selected.time).toBeLessThan(.28);
    expect(jobs.map(job => job.text)).toEqual(['尚未缓存的第一段。', '尚未缓存的第二段。', '尚未缓存的第三段。']);
    expect(jobs.every(job => !job.stream)).toBe(true);
    await stop(page).click();
    await seek(page, 50);
    await expect.poll(async () => (await audioState(page))?.src).toContain(jobs[1].id);
    expect((await state(request)).requests).toHaveLength(3);
    await stop(page).click();
});

test('the seek timeline stays disabled during text generation and unlocks after the reply is complete', async ({ page }) => {
    await page.getByRole('button', { name: '打开扩展菜单' }).click();
    await page.locator('#breeze_studio_wand_entry').click();
    const studio = page.locator('#breeze-studio-host').locator('dialog');
    await studio.locator('[data-tab="connection"]').click();
    const streamingText = studio.locator('[data-setting="readStreamingText"]');
    if (!(await streamingText.isChecked())) await streamingText.locator('..').click();
    await studio.locator('[data-close]').click();
    await page.evaluate(() => window.__breezeDemo.beginStream());
    await page.evaluate(raw => window.__breezeDemo.streamText(raw), speech('已经完成的第一句话。'));
    await expect(controls(page)).toHaveAttribute('data-message-id', '1');
    await expect(timeline(page)).toBeDisabled();
    await page.evaluate(raw => window.__breezeDemo.streamText(raw), speech('已经完成的第一句话。') + '\n尚未结束的旁白');
    await expect(timeline(page)).toBeDisabled();
    await page.evaluate(() => window.__breezeDemo.finishStream());
    await expect(timeline(page)).toBeEnabled();
});

test('seeking while paused preserves the pause and resumes from the selected segment', async ({ page, request }) => {
    await setMessages(page, [{ text: [speech('暂停前的第一段。'), speech('暂停后跳到第二段。'), speech('跳转后的第三段。')].join('\n') }]);
    await play(page).click();
    await expect.poll(async () => (await audioState(page))?.time ?? 0).toBeGreaterThan(.02);
    await pause(page).click();
    await expect(pause(page)).toHaveAttribute('aria-pressed', 'true');
    await seek(page, 50);
    await expect.poll(async () => (await state(request)).requests.length).toBe(3);
    const jobs = (await state(request)).requests;
    await expect.poll(async () => (await audioState(page))?.src).toContain(jobs[1].id);
    await expect.poll(async () => (await audioState(page))?.ready).toBe(true);
    await expect(pause(page)).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await audioState(page))?.paused).toBe(true);
    const frozen = (await audioState(page)).time;
    expect(frozen).toBeGreaterThanOrEqual(.19);
    expect(frozen).toBeLessThan(.24);
    await page.waitForTimeout(180);
    expect(Math.abs((await audioState(page)).time - frozen)).toBeLessThan(.015);
    await pause(page).click();
    await expect.poll(async () => (await audioState(page))?.time ?? 0).toBeGreaterThan(frozen + .02);
    expect((await state(request)).requests).toHaveLength(3);
    await stop(page).click();
});
