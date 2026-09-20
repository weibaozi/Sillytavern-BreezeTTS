import { test, expect } from '@playwright/test';

const studio = page => page.locator('#breeze-studio-host').locator('dialog');
const bubble = page => page.locator('.breeze-bubble').first();
const demoState = async request => (await request.get('/__demo/state')).json();

async function openConnection(page) {
    await page.getByRole('button', { name: '打开扩展菜单' }).click();
    await page.locator('#breeze_studio_wand_entry').click();
    await studio(page).locator('[data-tab="connection"]').click();
}

async function enableStreaming(page) {
    await openConnection(page);
    const toggle = studio(page).locator('[data-setting="streaming"]');
    await expect(toggle).not.toBeChecked();
    await toggle.locator('..').click();
    await expect(toggle).toBeChecked();
    await expect.poll(() => page.evaluate(() => window.__breezeDemo.context.extensionSettings.breeze_voice.streaming)).toBe(true);
    await studio(page).locator('[data-close]').click();
}

test.beforeEach(async ({ page, request }) => {
    await request.post('/__demo/reset');
    // Observe actual browser audio output without replacing the player or media APIs.
    await page.addInitScript(() => {
        const probe = window.__streamProbe = { starts: [], media: [], contexts: [] };
        const start = AudioBufferSourceNode.prototype.start;
        AudioBufferSourceNode.prototype.start = function (...args) {
            probe.starts.push({ at: Date.now(), state: this.context.state, samples: this.buffer?.length });
            if (!probe.contexts.includes(this.context)) probe.contexts.push(this.context);
            return start.apply(this, args);
        };
        const play = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function (...args) {
            probe.media.push({ at: Date.now(), src: this.src });
            return play.apply(this, args);
        };
    });
    await page.goto('/');
    await expect(bubble(page)).toHaveAttribute('data-state', 'idle');
});

test('stream setting persists; real PCM playback starts before completion and replay uses cached WAV', async ({ page, request }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await enableStreaming(page);
    await openConnection(page);
    await expect(studio(page).locator('[data-setting="streaming"]')).toBeChecked();
    await page.screenshot({ path: 'test-results/studio-streaming.png' });
    await studio(page).locator('[data-close]').click();
    await bubble(page).click();
    await expect.poll(() => page.evaluate(() => window.__streamProbe.starts.length)).toBeGreaterThan(0);
    const started = await page.evaluate(() => window.__streamProbe.starts[0]);
    expect(started.state).toBe('running');
    expect(started.samples).toBeGreaterThan(0);
    let state = await demoState(request);
    expect(state.requests).toHaveLength(1);
    expect(state.requests[0].stream).toBe(true);
    const id = state.requests[0].id;
    expect(state.jobs[id].status).toBe('running');
    expect(state.streamEvents.filter(event => event.type === 'done')).toHaveLength(0);
    await expect(bubble(page)).toHaveAttribute('data-state', 'ready');
    state = await demoState(request);
    expect(state.jobs[id].status).toBe('done');
    expect(started.at).toBeLessThan(state.streamEvents.find(event => event.type === 'done').at);
    await expect.poll(() => page.evaluate(() => Object.keys(window.__breezeDemo.context.chatMetadata.breeze_voice.cache).length)).toBe(1);
    const sourceCount = await page.evaluate(() => window.__streamProbe.starts.length);
    await bubble(page).click();
    await expect.poll(() => page.evaluate(() => window.__streamProbe.media.some(event => /\/breeze\/jobs\/[^/]+\/audio$/.test(event.src)))).toBe(true);
    await expect(bubble(page)).toHaveAttribute('data-state', 'ready');
    state = await demoState(request);
    expect(state.requests).toHaveLength(1);
    expect(state.audioRequests.some(event => event.path === `/breeze/jobs/${id}/audio`)).toBe(true);
    expect(await page.evaluate(() => window.__streamProbe.starts.length)).toBe(sourceCount);
    expect(errors).toEqual([]);
});

test('stop queue aborts the network stream and disposes active PCM playback without caching a partial result', async ({ page, request }) => {
    await enableStreaming(page);
    await bubble(page).click();
    await expect.poll(() => page.evaluate(() => window.__streamProbe.starts.length)).toBeGreaterThan(0);
    await openConnection(page);
    await studio(page).locator('[data-stop]').click();
    await expect(studio(page).locator('[data-status]')).toContainText('已停止');
    await expect.poll(async () => (await demoState(request)).cancelled.length).toBe(1);
    await expect.poll(() => page.evaluate(() => window.__streamProbe.contexts.every(context => context.state !== 'running'))).toBe(true);
    const state = await demoState(request), id = state.requests[0].id;
    expect(state.jobs[id].status).toBe('cancelled');
    expect(state.streamEvents.some(event => event.id === id && event.type === 'done')).toBe(false);
    expect(await page.evaluate(() => Object.keys(window.__breezeDemo.context.chatMetadata.breeze_voice.cache))).toEqual([]);
    await studio(page).locator('[data-close]').click();
    await expect(bubble(page)).toHaveAttribute('data-state', 'idle');
});

test('a streaming bubble pauses and resumes the browser audio context', async ({ page }) => {
    await enableStreaming(page);
    await bubble(page).click();
    await expect(bubble(page)).toHaveAttribute('data-state', 'playing');
    await bubble(page).click();
    await expect(bubble(page)).toHaveAttribute('data-state', 'paused');
    await expect.poll(() => page.evaluate(() => window.__streamProbe.contexts.some(context => context.state === 'suspended'))).toBe(true);
    await bubble(page).click();
    await expect(bubble(page)).toHaveAttribute('data-state', 'playing');
    await expect.poll(() => page.evaluate(() => window.__streamProbe.contexts.some(context => context.state === 'running'))).toBe(true);
    await expect(bubble(page)).toHaveAttribute('data-state', 'ready');
    expect(await page.evaluate(() => window.__streamProbe.starts.length)).toBe(2);
});

test('chat change aborts in-flight speech and prevents the old result entering the new chat cache', async ({ page, request }) => {
    await enableStreaming(page);
    await bubble(page).click();
    await expect.poll(() => page.evaluate(() => window.__streamProbe.starts.length)).toBeGreaterThan(0);
    await page.evaluate(() => {
        const demo = window.__breezeDemo;
        demo.context.chatId = 'another-demo-chat';
        demo.context.chatMetadata = { breeze_voice: { mappings: { '周启明': '1'.repeat(32) }, manual: [], cache: {}, demo: true } };
        demo.emit('CHAT_CHANGED');
    });
    await expect.poll(async () => (await demoState(request)).cancelled.length).toBe(1);
    await expect.poll(() => page.evaluate(() => window.__streamProbe.contexts.every(context => context.state !== 'running'))).toBe(true);
    await expect(bubble(page)).toHaveAttribute('data-state', 'idle');
    const state = await demoState(request), id = state.requests[0].id;
    expect(state.streamEvents.some(event => event.id === id && event.type === 'closed')).toBe(true);
    expect(state.streamEvents.some(event => event.id === id && event.type === 'done')).toBe(false);
    expect(await page.evaluate(() => Object.keys(window.__breezeDemo.context.chatMetadata.breeze_voice.cache))).toEqual([]);
});
