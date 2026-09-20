import test from 'node:test';
import assert from 'node:assert/strict';
import { AutomaticSpeechQueue } from '../automatic-queue.js';
import { SpeechPlayer } from '../player.js';

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const item = id => ({ id });
function fixture(options = {}) {
    const calls = [], errors = [];
    const player = {
        stops: 0,
        stop() { this.stops++; },
        run(items, options) {
            const completion = deferred();
            calls.push({ items, options, ...completion });
            return completion.promise;
        },
    };
    const queue = new AutomaticSpeechQueue({ player, onError: error => errors.push(error), ...options });
    return { queue, player, calls, errors };
}

test('appended utterances wait for active run and keep enqueue order/options', async () => {
    const { queue, player, calls } = fixture();
    const a = item('a'), b = item('b'), c = item('c'), d = item('d');
    const options = { play: false, stream: true };
    assert.equal(queue.enqueue([a, b], options), undefined);
    options.play = true;
    queue.enqueue([c], { play: true, stream: false });
    queue.enqueue([d], { play: true, stream: true });
    assert.equal(player.stops, 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].items, [a, b]);
    assert.deepEqual(calls[0].options, { play: false, stream: true, preservePause: true });
    assert.equal(queue.busy, true);
    assert.deepEqual(queue.activeItems, [a, b, c, d]);
    calls[0].resolve(); await flush();
    assert.deepEqual(calls[1].items, [c]);
    assert.deepEqual(calls[1].options, { play: true, stream: false, preservePause: true });
    assert.deepEqual(queue.activeItems, [c, d]);
    calls[1].resolve(); await flush();
    assert.deepEqual(calls[2].items, [d]);
    assert.deepEqual(calls[2].options, { play: true, stream: true, preservePause: true });
    calls[2].resolve(); await flush();
    assert.equal(queue.busy, false);
    assert.deepEqual(queue.activeItems, []);
});

test('stop clears waiting work; late cancelled rejection cannot clear a new run', async () => {
    const { queue, player, calls, errors } = fixture();
    queue.enqueue([item('old')]);
    queue.enqueue([item('discard')]);
    queue.stop();
    assert.equal(player.stops, 1);
    assert.equal(queue.busy, false);
    assert.deepEqual(queue.activeItems, []);
    const replacement = item('new'), next = item('next');
    queue.enqueue([replacement]);
    queue.enqueue([next]);
    calls[0].reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })); await flush();
    assert.equal(queue.busy, true);
    assert.deepEqual(queue.activeItems, [replacement, next]);
    assert.deepEqual(errors, []);
    calls[1].resolve(); await flush();
    assert.deepEqual(calls[2].items, [next]);
    calls[2].resolve(); await flush();
    assert.equal(queue.busy, false);
});

test('late successful completion after stop cannot drain or clear a new queue', async () => {
    const { queue, calls } = fixture();
    queue.enqueue([item('old')]);
    queue.stop();
    const fresh = item('fresh');
    queue.enqueue([fresh]);
    calls[0].resolve(); await flush();
    assert.deepEqual(queue.activeItems, [fresh]);
    assert.equal(queue.busy, true);
    calls[1].resolve(); await flush();
    assert.equal(queue.busy, false);
});

test('invalid items are skipped initially and rechecked before waiting batches start', async () => {
    const invalid = new Set(['initial']);
    const { queue, calls } = fixture({ isValid: item => !invalid.has(item.id) });
    const a = item('a'), valid = item('valid');
    queue.enqueue([item('initial'), a]);
    queue.enqueue([item('stale')]);
    queue.enqueue([item('stale-two'), valid]);
    invalid.add('stale'); invalid.add('stale-two');
    calls[0].resolve(); await flush();
    assert.deepEqual(calls.map(call => call.items), [[a], [valid]]);
    calls[1].resolve(); await flush();
    assert.equal(queue.busy, false);
});

test('failure reports once and clears waiting work without continuing out of order', async () => {
    const { queue, calls, errors } = fixture();
    queue.enqueue([item('bad')]);
    queue.enqueue([item('waiting')]);
    const failure = new Error('offline');
    calls[0].reject(failure); await flush();
    assert.deepEqual(errors, [failure]);
    assert.equal(calls.length, 1);
    assert.equal(queue.busy, false);
    assert.deepEqual(queue.activeItems, []);
    queue.enqueue([item('later')]);
    assert.equal(calls.length, 2);
    calls[1].resolve(); await flush();
});

test('external player cancellation silently clears waiting work', async () => {
    const { queue, calls, errors } = fixture();
    queue.enqueue([item('current')]);
    queue.enqueue([item('waiting')]);
    calls[0].reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })); await flush();
    assert.equal(calls.length, 1);
    assert.deepEqual(errors, []);
    assert.deepEqual(queue.activeItems, []);
    assert.equal(queue.busy, false);
});

test('duplicate IDs are ignored across completed batches until stop resets them', async () => {
    const { queue, calls } = fixture();
    const a = item('a');
    queue.enqueue([a, item('a')]);
    queue.enqueue([item('a')]);
    assert.deepEqual(calls[0].items, [a]);
    calls[0].resolve(); await flush();
    queue.enqueue([item('a')]);
    assert.equal(calls.length, 1);
    queue.stop();
    queue.enqueue([a]);
    assert.equal(calls.length, 2);
    calls[1].resolve(); await flush();
});

test('synchronous player errors and failing error handlers do not reject enqueue', () => {
    const queue = new AutomaticSpeechQueue({
        player: { run() { throw new Error('synchronous'); }, stop() {} },
        onError() { throw new Error('reporting'); },
    });
    assert.doesNotThrow(() => queue.enqueue([item('a')]));
    assert.equal(queue.busy, false);
    assert.deepEqual(queue.activeItems, []);
});

test('automatic playback preserves a pause across batches and keeps later streamed utterances queued', async () => {
    const sounds = [], prepared = [], errors = [];
    const player = new SpeechPlayer({ prepare: async item => { prepared.push(item.id); return { url: item.id }; },
        audioFactory: () => {
            const audio = { paused: true, pause() { this.paused = true; },
                async play() { this.paused = false; }, removeAttribute() {}, load() {} };
            sounds.push(audio); return audio;
        } });
    const queue = new AutomaticSpeechQueue({ player, onError: error => errors.push(error) });
    queue.enqueue([item('first')], { play: true });
    await flush();
    // Pause can coincide with the last audio-ended event of one streamed batch.
    player.pause(); sounds[0].onended(); await flush();
    assert.equal(queue.busy, false); assert.equal(player.paused, true);
    queue.enqueue([item('narration')], { play: true });
    queue.enqueue([item('dialogue')], { play: true });
    await flush();
    assert.equal(queue.busy, true); assert.equal(player.active, true);
    assert.equal(player.paused, true); assert.equal(sounds.length, 1);
    assert.deepEqual(prepared, ['first', 'narration']);
    assert.deepEqual(queue.activeItems.map(item => item.id), ['narration', 'dialogue']);
    await player.resume(); await flush();
    assert.equal(sounds[1].src, 'narration');
    sounds[1].onended(); await flush();
    assert.equal(sounds[2].src, 'dialogue');
    sounds[2].onended(); await flush();
    assert.equal(queue.busy, false); assert.equal(player.paused, false); assert.deepEqual(errors, []);
    queue.stop(); assert.equal(player.paused, false);
});

test('stopping a paused automatic queue discards waiting speech and resets pause for its replacement', async () => {
    const sounds = [], errors = [];
    const player = new SpeechPlayer({ prepare: async item => ({ url: item.id }),
        audioFactory: () => {
            const audio = { paused: true, pause() { this.paused = true; },
                async play() { this.paused = false; }, removeAttribute() {}, load() {} };
            sounds.push(audio); return audio;
        } });
    const queue = new AutomaticSpeechQueue({ player, onError: error => errors.push(error) });
    queue.enqueue([item('old')]); player.pause();
    queue.enqueue([item('discard')]); await flush();
    assert.equal(sounds.length, 0);
    queue.stop(); queue.enqueue([item('replacement')]); await flush();
    assert.equal(player.paused, false); assert.equal(sounds.length, 1);
    assert.equal(sounds[0].src, 'replacement'); assert.deepEqual(errors, []);
    sounds[0].onended(); await flush();
    assert.equal(queue.busy, false);
});
