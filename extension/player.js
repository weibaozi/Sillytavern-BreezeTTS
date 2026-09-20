import { aborted, checkAbort } from './client.js';
import { createPCMStream } from './stream-player.js';

// A cancelled generation can finish on the GPU; its result must never start playback.
export class SpeechPlayer {
    constructor({ prepare, update = () => {}, audioFactory = () => new Audio(), streamFactory = () => createPCMStream() }) {
        this.prepare = prepare; this.update = update; this.audioFactory = audioFactory;
        this.streamFactory = streamFactory; this.streamSession = null;
        this.controller = null; this.audio = null; this.current = null; this.volume = 0.8;
    }
    stop() {
        this.controller?.abort(); this.controller = null;
        this.streamSession?.dispose(); this.streamSession = null;
        if (this.audio && !this.audio.dispose) { this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load(); }
        this.audio = null; this.current = null;
    }
    async run(items, { play = true, stream = false } = {}) {
        this.stop();
        const controller = new AbortController(); this.controller = controller;
        const signal = controller.signal;
        const pendingStreams = new Set();
        const cancelPrepared = record => {
            if (!pendingStreams.delete(record)) return;
            void Promise.resolve().then(() => record.cancel?.()).catch(() => {});
        };
        signal.addEventListener('abort', () => {
            for (const record of pendingStreams) cancelPrepared(record);
            for (const item of items) {
                if (['queued', 'running', 'playing', 'paused'].includes(item.state)) this.update(item, 'idle');
            }
        }, { once: true });
        // Each preparation handles errors immediately, including prefetched items.
        const streaming = stream && play;
        const prepare = item => Promise.resolve().then(() => this.prepare(item, signal, { stream: streaming })).then(value => {
            if (value?.streamUrl) {
                pendingStreams.add(value);
                // The POST may resolve after stop(), or stop may happen between
                // this continuation and the playback continuation below.
                if (signal.aborted) cancelPrepared(value);
            }
            return { value };
        }, error => ({ error }));
        let transport;
        try {
            if (streaming && items.length) {
                // resume() must run before preparing the first network request.
                transport = this.streamFactory(); this.streamSession = transport;
                transport.volume = this.volume;
                try { await transport.wake(signal); }
                catch (error) { if (!signal.aborted) this.update(items[0], 'error', error.message); throw error; }
            }
            let next = items.length ? prepare(items[0]) : null;
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                const result = await next; checkAbort(signal);
                if (result.error) { this.update(item, 'error', result.error.message); throw result.error; }
                if (!streaming) next = i + 1 < items.length ? prepare(items[i + 1]) : null;
                if (play) {
                    if (result.value.streamUrl) {
                        if (!transport) throw new Error('流式播放未启用。');
                        // The transport now owns cancellation and retains completed caches.
                        pendingStreams.delete(result.value);
                        await this.playStream(item, result.value, signal, transport);
                    }
                    else await this.playOne(item, result.value, signal);
                }
                if (streaming) next = i + 1 < items.length ? prepare(items[i + 1]) : null;
            }
        } finally {
            controller.abort();
            transport?.dispose();
            if (this.streamSession === transport) this.streamSession = null;
            if (this.controller === controller) { this.controller = null; this.audio = null; this.current = null; }
        }
    }
    async playStream(item, record, signal, transport) {
        checkAbort(signal);
        if (!transport) throw new Error('流式播放未启用。');
        this.audio = transport; this.current = item; transport.volume = this.volume;
        try {
            const result = await transport.run(record, signal, () => {
                checkAbort(signal); this.update(item, transport.paused ? 'paused' : 'playing');
            });
            checkAbort(signal); this.update(item, 'ready', '', result.duration);
        } catch (error) {
            if (!signal.aborted) this.update(item, 'error', error.message);
            throw error;
        } finally {
            if (this.audio === transport) { this.audio = null; this.current = null; }
        }
    }
    async playOne(item, record, signal) {
        checkAbort(signal);
        const audio = this.audioFactory(); this.audio = audio; this.current = item;
        audio.volume = this.volume; audio.src = record.url;
        return new Promise((resolve, reject) => {
            let finished = false;
            const finish = error => {
                if (finished) return;
                finished = true;
                signal.removeEventListener('abort', stop);
                audio.onended = null; audio.onerror = null;
                audio.pause(); audio.removeAttribute('src'); audio.load();
                if (!signal.aborted) this.update(item, error ? 'error' : 'ready', error?.message, record.duration);
                error ? reject(error) : resolve();
            };
            const stop = () => finish(aborted());
            signal.addEventListener('abort', stop, { once: true });
            audio.onended = () => finish();
            audio.onerror = () => finish(new Error('音频读取失败，请检查服务或重新生成。'));
            this.update(item, 'playing', '', record.duration);
            audio.play().catch(error => {
                finish(new Error(error.name === 'NotAllowedError' ? '浏览器阻止自动播放，请点击气泡播放。' : error.message));
            });
        });
    }
    async toggle(item, { stream = false } = {}) {
        if (this.current?.id !== item.id || !this.audio) return this.run([item], { stream });
        if (this.audio.paused) { await this.audio.play(); this.update(item, 'playing'); }
        else { this.audio.pause(); this.update(item, 'paused'); }
    }
}
