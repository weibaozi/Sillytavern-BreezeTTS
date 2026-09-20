import test from 'node:test';
import assert from 'node:assert/strict';
import { PCMStreamPlayer, decodePCM } from '../extension/stream-player.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
export class FakeContext {
    state = 'suspended'; currentTime = 1; sources = []; buffers = []; resumes = 0;
    destination = {};
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    resume() { this.resumes++; this.state = 'running'; return Promise.resolve(); }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createBuffer(channels, size, rate) {
        const data = new Float32Array(size);
        const buffer = { sampleRate: rate, duration: size / rate, getChannelData: () => data };
        this.buffers.push(buffer); return buffer;
    }
    createBufferSource() {
        const source = { stopped: false, disconnected: false,
            connect() {}, disconnect() { this.disconnected = true; },
            start(when) { this.when = when; }, stop() { this.stopped = true; },
        };
        this.sources.push(source); return source;
    }
    finish() {
        for (const source of this.sources) {
            this.currentTime = Math.max(this.currentTime, source.when + source.buffer.duration);
            source.onended?.();
        }
    }
}

const pcm = values => {
    const bytes = Buffer.alloc(values.length * 2);
    values.forEach((value, i) => bytes.writeInt16LE(value, i * 2));
    return bytes.toString('base64');
};
const audio = (values = [0, 32767, -32768], rate = 16000) => ({ type: 'audio', pcm: pcm(values), sample_rate: rate });
const done = { type: 'done', job: { id: 'test', status: 'done', duration: 0.25, audio_url: '/audio' } };
const descriptor = (events, extra = {}) => {
    const encoded = new TextEncoder().encode(events.map(event => JSON.stringify(event)).join('\n') + '\n');
    return { streamUrl: 'http://localhost/stream', fetcher: async () => ({ ok: true,
        body: new ReadableStream({ start(controller) { controller.enqueue(encoded); controller.close(); } }) }), ...extra };
};

test('PCM decoding is signed little-endian and rejects malformed samples', () => {
    assert.deepEqual([...decodePCM(pcm([-32768, -1, 0, 32767]))], [-1, -1 / 32768, 0, 32767 / 32768]);
    assert.throws(() => decodePCM('AA=='), /不完整/);
    assert.throws(() => decodePCM('???'), /编码/);
});

test('split NDJSON schedules contiguous buffers, caches before tail, and waits for audible completion', async () => {
    const context = new FakeContext(), controller = new AbortController();
    const player = new PCMStreamPlayer({ contextFactory: () => context });
    await player.wake(controller.signal);
    const data = new TextEncoder().encode([audio(new Array(1600).fill(100)), { type: 'ping' }, audio(), done].map(JSON.stringify).join('\n'));
    let cached = false, finished = false, started = 0;
    const record = { streamUrl: '/stream', complete: async () => { cached = true; }, fetcher: async () => ({ ok: true,
        body: new ReadableStream({ start(stream) {
            for (let index = 0; index < data.length; index += 7) stream.enqueue(data.slice(index, index + 7));
            stream.close();
        } }) }) };
    const running = player.run(record, controller.signal, () => { started++; }).then(value => { finished = true; return value; });
    await tick();
    assert.equal(context.sources.length, 2); assert.equal(started, 1); assert.equal(cached, true); assert.equal(finished, false);
    assert.equal(context.sources[0].when, 1.08); assert.equal(context.sources[1].when, 1.1800000000000002);
    assert.equal(context.buffers[0].getChannelData(0)[0], 100 / 32768);
    context.finish(); assert.equal((await running).duration, 0.25); assert.equal(player.sources.size, 0);
    player.dispose(); assert.equal(context.state, 'closed');
});

test('pause/resume and live volume affect streaming playback, abort stops all queued audio', async () => {
    const context = new FakeContext(), controller = new AbortController();
    const player = new PCMStreamPlayer({ contextFactory: () => context });
    let cancelled = 0, readerCancelled = false;
    await player.wake(controller.signal);
    const running = player.run({ streamUrl: '/stream', cancel: async () => { cancelled++; }, fetcher: async () => ({ ok: true,
        body: new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode(JSON.stringify(audio()) + '\n')); },
            cancel() { readerCancelled = true; } }) }) }, controller.signal);
    const failure = assert.rejects(running, { name: 'AbortError' });
    await tick();
    player.volume = 0.35; assert.equal(player.gain.gain.value, 0.35);
    player.pause(); assert.equal(player.paused, true); assert.equal(context.state, 'suspended');
    await player.play(); assert.equal(player.paused, false); assert.equal(context.state, 'running');
    controller.abort(); await failure; await tick();
    assert.equal(readerCancelled, true); assert.equal(cancelled, 1);
    assert.ok(context.sources.every(source => source.stopped && source.disconnected));
    player.dispose();
});

test('a stream error after partial audio never falls back or leaves scheduled audio alive', async () => {
    const context = new FakeContext(), controller = new AbortController(); let cancelled = 0;
    const player = new PCMStreamPlayer({ contextFactory: () => context });
    await player.wake(controller.signal);
    await assert.rejects(player.run(descriptor([audio(), { type: 'error', error: 'GPU failed' }],
        { cancel: () => { cancelled++; } }), controller.signal), /GPU failed/);
    await tick(); assert.equal(cancelled, 1); assert.equal(context.sources[0].stopped, true);
    player.dispose();
});

test('an early EOF is an error, while abort during the completed playback tail preserves its cache', async () => {
    const context = new FakeContext(), controller = new AbortController();
    const player = new PCMStreamPlayer({ contextFactory: () => context });
    await player.wake(controller.signal);
    await assert.rejects(player.run(descriptor([audio()]), controller.signal), /提前断开/);
    let cached = false, cancelled = false;
    const running = player.run(descriptor([audio(), done], { complete: async () => { cached = true; }, cancel: () => { cancelled = true; } }), controller.signal);
    const failure = assert.rejects(running, { name: 'AbortError' });
    await tick(); assert.equal(cached, true); controller.abort(); await failure;
    assert.equal(cancelled, false); player.dispose();
});

test('lookahead applies backpressure, and cancelling while paused releases it', async () => {
    const context = new FakeContext(), controller = new AbortController(); let cancelled = false;
    const player = new PCMStreamPlayer({ contextFactory: () => context, maxLookAhead: 0.2 });
    await player.wake(controller.signal);
    const running = player.run(descriptor([audio(new Array(8000).fill(0)), audio(), done],
        { cancel: () => { cancelled = true; } }), controller.signal);
    const failure = assert.rejects(running, { name: 'AbortError' });
    await tick(); assert.equal(context.sources.length, 1); player.pause(); controller.abort(); await failure;
    await tick(); assert.equal(cancelled, true); assert.equal(context.sources.length, 1); player.dispose();
});

test('stalled generation times out and blocked autoplay fails without silently waiting forever', async () => {
    const context = new FakeContext(), controller = new AbortController();
    const player = new PCMStreamPlayer({ contextFactory: () => context, maxWait: 10 });
    await player.wake(controller.signal);
    await assert.rejects(player.run({ streamUrl: '/stream', fetcher: async () => ({ ok: true, body: new ReadableStream() }) }, controller.signal), /超时/);
    player.dispose();
    const blocked = new FakeContext(); blocked.resume = () => new Promise(() => {});
    const blockedPlayer = new PCMStreamPlayer({ contextFactory: () => blocked, activationWait: 10 });
    await assert.rejects(blockedPlayer.wake(controller.signal), /点击气泡/); blockedPlayer.dispose();
});
