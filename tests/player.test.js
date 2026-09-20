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

test('global pause holds preparing speech, resumes its audio offset and keeps the remaining order', async () => {
    const first = deferred(), sounds = [], states = [];
    const a = item('narration'), b = item('dialogue');
    const player = new SpeechPlayer({
        prepare: async item => item === a ? first.promise : { url: item.id },
        audioFactory: () => { const audio = new FakeAudio(); audio.currentTime = 0; sounds.push(audio); return audio; },
        update: (item, state) => { item.state = state; },
        onStateChange: state => states.push(state),
    });
    assert.equal(states.length, 0);
    const running = player.run([a, b]);
    assert.equal(player.active, true);
    assert.deepEqual(player.activeItems, [a, b]);
    assert.equal(player.pause(), true);
    assert.equal(player.paused, true);
    first.resolve({ url: a.id });
    await new Promise(r => setImmediate(r));
    assert.equal(sounds.length, 0);
    await player.resume(); await new Promise(r => setImmediate(r));
    assert.equal(sounds.length, 1); assert.equal(sounds[0].src, 'narration');
    sounds[0].currentTime = 1.25;
    await player.toggle(a);
    assert.equal(player.paused, true); assert.equal(a.state, 'paused');
    assert.equal(sounds[0].paused, true);
    await player.togglePause();
    assert.equal(sounds[0].currentTime, 1.25); assert.equal(sounds.length, 1);
    assert.equal(sounds[0].paused, false); assert.equal(a.state, 'playing');
    sounds[0].onended(); await new Promise(r => setImmediate(r));
    assert.equal(sounds[1].src, 'dialogue');
    sounds[1].onended(); await running;
    assert.equal(player.active, false); assert.equal(player.paused, false);
    assert.deepEqual(player.activeItems, []);
    assert.deepEqual(states.at(-1), { active: false, paused: false, current: null, items: [] });
});

test('generate-only work is never an active playback or a pause target', async () => {
    const prepared = deferred(); let sounds = 0;
    const player = new SpeechPlayer({ prepare: () => prepared.promise,
        audioFactory: () => { sounds++; return new FakeAudio(); } });
    const running = player.run([item('cache')], { play: false });
    assert.equal(player.active, false); assert.deepEqual(player.activeItems, []);
    assert.equal(await player.togglePause(), false); assert.equal(player.paused, false);
    prepared.resolve({ url: 'cache.wav' }); await running;
    assert.equal(sounds, 0);
});

test('stop aborts a paused prepared stream exactly once without starting it', async () => {
    let cancelled = 0, started = 0;
    const player = new SpeechPlayer({
        prepare: async () => ({ streamUrl: 'prepared', cancel: async () => { cancelled++; } }),
        streamFactory: () => ({ wake: async () => {}, dispose() {}, run: async () => { started++; } }),
    });
    const running = player.run([item('held')], { stream: true });
    const failure = assert.rejects(running, { name: 'AbortError' });
    player.pause(); await new Promise(r => setImmediate(r));
    player.stop(); await failure; await new Promise(r => setImmediate(r));
    assert.equal(started, 0); assert.equal(cancelled, 1);
    assert.equal(player.paused, false); assert.equal(player.active, false);
    assert.deepEqual(player.activeItems, []);
});

test('a pause immediately after transport selection retains prepared-job cancellation ownership', async () => {
    let cancelled = 0, started = 0, player;
    const transport = { wake: async () => {}, dispose() {}, pause() {}, run: async () => { started++; } };
    player = new SpeechPlayer({
        prepare: async () => ({ streamUrl: 'handoff', cancel: async () => { cancelled++; } }),
        streamFactory: () => transport,
        onStateChange: state => { if (state.current && !state.paused) player.pause(); },
    });
    const running = player.run([item('handoff')], { stream: true });
    const failure = assert.rejects(running, { name: 'AbortError' });
    await new Promise(r => setImmediate(r));
    assert.equal(player.current.id, 'handoff'); assert.equal(started, 0);
    player.stop(); await failure; await new Promise(r => setImmediate(r));
    assert.equal(cancelled, 1);
});

test('pausing during streaming preparation holds the first source and resumes the same transport', async () => {
    const prepared = deferred(), tail = deferred(); let started = 0, created = 0;
    const transport = {
        paused: false, wake: async () => {}, dispose() {},
        pause() { this.paused = true; }, async play() { this.paused = false; },
        async run(record, signal, start) { started++; start(); await tail.promise; return { duration: 1 }; },
    };
    const a = item('stream');
    const player = new SpeechPlayer({ prepare: () => prepared.promise,
        streamFactory: () => { created++; return transport; }, update: (item, state) => { item.state = state; } });
    const running = player.run([a], { stream: true });
    player.pause(); prepared.resolve({ streamUrl: 'stream' }); await new Promise(r => setImmediate(r));
    assert.equal(started, 0);
    await player.resume(); await new Promise(r => setImmediate(r));
    assert.equal(started, 1); assert.equal(a.state, 'playing');
    player.pause(); assert.equal(transport.paused, true); assert.equal(a.state, 'paused');
    await player.resume(); assert.equal(transport.paused, false); assert.equal(created, 1);
    tail.resolve(); await running;
});

test('rapid resume then pause cannot release a waiting segment', async () => {
    let sounds = 0;
    const player = new SpeechPlayer({ prepare: async () => ({ url: 'held.wav' }),
        audioFactory: () => { sounds++; return new FakeAudio(); } });
    const running = player.run([item('held')]);
    const failure = assert.rejects(running, { name: 'AbortError' });
    player.pause(); await new Promise(r => setImmediate(r));
    const resumed = player.resume(); player.pause(); await resumed;
    await new Promise(r => setImmediate(r));
    assert.equal(player.paused, true); assert.equal(sounds, 0);
    player.stop(); await failure;
});

test('a late resume completion cannot clear or pause replacement playback', async () => {
    const resumed = deferred(), sounds = [];
    const player = new SpeechPlayer({ prepare: async item => ({ url: item.id }),
        audioFactory: () => { const audio = new FakeAudio(); sounds.push(audio); return audio; } });
    const old = player.run([item('old')]);
    const oldFailure = assert.rejects(old, { name: 'AbortError' });
    await new Promise(r => setImmediate(r)); player.pause();
    sounds[0].play = () => resumed.promise.then(() => { sounds[0].paused = false; });
    const resuming = player.resume();
    const resumeFailure = assert.rejects(resuming, { name: 'AbortError' });
    const replacement = item('new');
    const fresh = player.run([replacement]);
    await new Promise(r => setImmediate(r));
    resumed.resolve(); await oldFailure; await resumeFailure;
    assert.equal(player.active, true); assert.equal(player.paused, false);
    assert.deepEqual(player.activeItems, [replacement]);
    assert.equal(sounds[0].paused, true); assert.equal(sounds[1].paused, false);
    sounds[1].onended(); await fresh;
});

test('pause interrupting the initial audio play promise does not fail the sequence', async () => {
    let rejectInitial;
    const initial = new Promise((_, reject) => { rejectInitial = reject; });
    const audio = new FakeAudio(); let starts = 0;
    audio.play = () => { audio.paused = false; return ++starts === 1 ? initial : Promise.resolve(); };
    const a = item('a');
    const player = new SpeechPlayer({ prepare: async () => ({ url: 'a' }), audioFactory: () => audio,
        update: (item, state) => { item.state = state; } });
    const running = player.run([a]);
    await new Promise(r => setImmediate(r)); player.pause();
    rejectInitial(Object.assign(new Error('play interrupted'), { name: 'AbortError' }));
    await new Promise(r => setImmediate(r));
    assert.equal(player.active, true); assert.equal(a.state, 'paused');
    await player.resume(); assert.equal(audio.paused, false);
    audio.onended(); await running;
});

test('an interrupted initial play can reject after resume without stopping the resumed audio', async () => {
    let rejectInitial;
    const initial = new Promise((_, reject) => { rejectInitial = reject; });
    const audio = new FakeAudio(); let starts = 0;
    audio.play = () => { audio.paused = false; return ++starts === 1 ? initial : Promise.resolve(); };
    const player = new SpeechPlayer({ prepare: async () => ({ url: 'a' }), audioFactory: () => audio });
    const running = player.run([item('a')]);
    await new Promise(r => setImmediate(r)); player.pause(); await player.resume();
    rejectInitial(Object.assign(new Error('old play interrupted'), { name: 'AbortError' }));
    await new Promise(r => setImmediate(r));
    assert.equal(player.active, true); assert.equal(player.paused, false); assert.equal(audio.paused, false);
    audio.onended(); await running;
});

test('a resume settling after its utterance ends cannot pause the next utterance in the same run', async () => {
    const resumed = deferred(), sounds = [], a = item('a'), b = item('b');
    const player = new SpeechPlayer({ prepare: async item => ({ url: item.id }),
        audioFactory: () => { const audio = new FakeAudio(); sounds.push(audio); return audio; },
        update: (item, state) => { item.state = state; } });
    const running = player.run([a, b]);
    await new Promise(r => setImmediate(r)); player.pause();
    sounds[0].play = () => resumed.promise.then(() => { sounds[0].paused = false; });
    const resuming = player.resume();
    const stale = assert.rejects(resuming, { name: 'AbortError' });
    sounds[0].onended(); await new Promise(r => setImmediate(r));
    assert.equal(player.current, b);
    resumed.resolve(); await stale;
    assert.equal(player.paused, false); assert.equal(sounds[1].paused, false);
    assert.equal(a.state, 'ready'); assert.equal(b.state, 'playing');
    sounds[1].onended(); await running;
});
