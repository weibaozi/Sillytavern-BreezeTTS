import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechPlayer } from '../extension/player.js';
import { BreezeClient } from '../extension/client.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const item = id => ({ id });
class FakeAudio {
    paused = true;
    removeAttribute() {}
    load() {}
    pause() { this.paused = true; }
    play() { this.paused = false; return Promise.resolve(); }
}
test('outdated asynchronous results cannot start playback after stop', async () => {
    const pending = deferred(); let audioCreated = 0;
    const player = new SpeechPlayer({ prepare: () => pending.promise, audioFactory: () => { audioCreated++; return new FakeAudio(); } });
    const running = player.run([item('old')]); const failure = assert.rejects(running, { name: 'AbortError' });
    player.stop(); pending.resolve({ url: 'old.wav' }); await failure;
    assert.equal(audioCreated, 0);
});
test('prefetch does not change playback order, stop cancels active audio', async () => {
    const sounds = [], prepared = [];
    const player = new SpeechPlayer({ prepare: async value => { prepared.push(value.id); return { url: value.id }; },
        audioFactory: () => { const audio = new FakeAudio(); sounds.push(audio); return audio; } });
    const running = player.run([item('a'), item('b')]);
    await new Promise(r => setImmediate(r));
    assert.deepEqual(prepared, ['a', 'b']); assert.equal(sounds.length, 1); assert.equal(sounds[0].src, 'a');
    sounds[0].onended(); await new Promise(r => setImmediate(r));
    assert.equal(sounds[1].src, 'b');
    const failure = assert.rejects(running, { name: 'AbortError' }); player.stop(); await failure;
    assert.equal(sounds[1].paused, true);
});
test('failed segment stops sequence and reports error', async () => {
    const prepared = [];
    const player = new SpeechPlayer({ prepare: async i => { prepared.push(i.id); throw new Error('offline'); } });
    await assert.rejects(player.run([item('a'), item('b')]), /offline/);
    assert.deepEqual(prepared, ['a']);
});
test('switching playback clears active and prefetched indicators', async () => {
    const first = { id: 'first' }, next = { id: 'next' }, pending = deferred();
    const player = new SpeechPlayer({
        update: (item, state) => { item.state = state; },
        prepare: async item => {
            item.state = 'running';
            if (item === next) await pending.promise;
            return { url: item.id };
        }, audioFactory: () => new FakeAudio(),
    });
    const running = player.run([first, next]);
    await new Promise(r => setImmediate(r));
    assert.equal(first.state, 'playing'); assert.equal(next.state, 'running');
    const failure = assert.rejects(running, { name: 'AbortError' });
    player.stop(); pending.resolve(); await failure;
    assert.equal(first.state, 'idle'); assert.equal(next.state, 'idle');
});
test('stop during job creation cancels it once its ID arrives', async () => {
    const pending = deferred(), requests = [], controller = new AbortController();
    const id = 'a'.repeat(32);
    const api = new BreezeClient('http://localhost:7860', async (url, options) => {
        requests.push(options.method);
        if (options.method === 'POST') { await pending.promise; return { ok: true, json: async () => ({ id, status: 'queued' }) }; }
        return { ok: true, json: async () => ({ id, status: 'cancelled' }) };
    });
    const run = api.runJob({ text: 'hello' }, { signal: controller.signal });
    const failure = assert.rejects(run, { name: 'AbortError' }); controller.abort(); pending.resolve(); await failure;
    assert.deepEqual(requests, ['POST', 'DELETE']);
});
test('backend cannot redirect audio to another origin', () => {
    const api = new BreezeClient('http://localhost:7860');
    assert.throws(() => api.audioUrl('https://other/audio'));
    assert.throws(() => api.audioUrl('/breeze/jobs/../audio'));
    assert.equal(api.audioUrl(`/breeze/jobs/${'a'.repeat(32)}/audio`), `http://localhost:7860/breeze/jobs/${'a'.repeat(32)}/audio`);
});

test('stream activation precedes preparation and segments wait for the previous playback tail', async () => {
    const events = [], firstTail = deferred();
    let activeSignal;
    const transport = { paused: false, wake: async () => { events.push('wake'); }, dispose() { events.push('dispose'); },
        async run(record, signal, started) { activeSignal = signal; events.push(`play:${record.streamUrl}`); started();
            if (record.streamUrl === 'a') await firstTail.promise;
            return { duration: 1 };
        }, pause() { this.paused = true; }, async play() { this.paused = false; },
    };
    const a = item('a'), b = item('b');
    const player = new SpeechPlayer({ streamFactory: () => transport,
        prepare: async (item, signal, options) => { assert.equal(options.stream, true); events.push(`prepare:${item.id}`); return { streamUrl: item.id }; },
        update: (item, state) => { item.state = state; },
    });
    const running = player.run([a, b], { stream: true });
    assert.deepEqual(events, ['wake']);
    await new Promise(r => setImmediate(r));
    assert.deepEqual(events, ['wake', 'prepare:a', 'play:a']);
    assert.equal(player.audio, transport); await player.toggle(a); assert.equal(a.state, 'paused');
    await player.toggle(a); assert.equal(a.state, 'playing');
    firstTail.resolve(); await running;
    assert.deepEqual(events, ['wake', 'prepare:a', 'play:a', 'prepare:b', 'play:b', 'dispose']);
    assert.equal(activeSignal.aborted, true); assert.equal(a.state, 'ready'); assert.equal(b.state, 'ready');
});

test('streaming is never opened for generate-only runs and blocked activation creates no job', async () => {
    let prepared = 0, disposed = 0;
    const player = new SpeechPlayer({ prepare: async (item, signal, options) => { prepared++; assert.equal(options.stream, false); return { url: 'a.wav' }; },
        streamFactory: () => ({ wake: async () => { throw new Error('autoplay blocked'); }, dispose() { disposed++; } }),
    });
    await player.run([item('a')], { stream: true, play: false }); assert.equal(prepared, 1);
    await assert.rejects(player.run([item('b')], { stream: true }), /autoplay blocked/);
    assert.equal(prepared, 1); assert.equal(disposed, 1);
});

test('stopping during descriptor preparation cancels its job even when it resolves later', async () => {
    const pending = deferred(); let prepared = false, cancelled = 0, played = 0;
    const player = new SpeechPlayer({
        prepare: () => { prepared = true; return pending.promise; },
        streamFactory: () => ({ wake: async () => {}, dispose() {}, async run() { played++; } }),
    });
    const running = player.run([item('late')], { stream: true });
    const failure = assert.rejects(running, { name: 'AbortError' });
    await new Promise(r => setImmediate(r)); assert.equal(prepared, true);
    player.stop(); pending.resolve({ streamUrl: '/late', cancel: async () => { cancelled++; } });
    await failure; await new Promise(r => setImmediate(r));
    assert.equal(cancelled, 1); assert.equal(played, 0);
});

test('abort between prepared-descriptor registration and playback cancels exactly once', async () => {
    let cancelled = 0, played = 0, registered = false, player;
    const record = { cancel: async () => { cancelled++; }, get streamUrl() {
        // This microtask runs after prepare registers the descriptor, before
        // run() resumes to hand it to the transport.
        if (!registered) { registered = true; queueMicrotask(() => player.stop()); }
        return '/race';
    } };
    player = new SpeechPlayer({ prepare: async () => record,
        streamFactory: () => ({ wake: async () => {}, dispose() {}, async run() { played++; } }),
    });
    await assert.rejects(player.run([item('race')], { stream: true }), { name: 'AbortError' });
    await new Promise(r => setImmediate(r));
    assert.equal(cancelled, 1); assert.equal(played, 0);
});
