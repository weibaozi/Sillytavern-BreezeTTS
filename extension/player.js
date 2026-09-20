import { aborted, checkAbort } from './client.js';
import { createPCMStream } from './stream-player.js';

// A cancelled generation can finish on the GPU; its result must never start playback.
export class SpeechPlayer {
    constructor({ prepare, update = () => {}, onStateChange = () => {}, audioFactory = () => new Audio(), streamFactory = () => createPCMStream() }) {
        this.prepare = prepare; this.update = update; this.audioFactory = audioFactory;
        this.streamFactory = streamFactory; this.streamSession = null;
        this.controller = null; this.audio = null; this.current = null; this.volume = 0.8;
        this.onStateChange = onStateChange; this._paused = false;
        this._activeItems = []; this._resumeWaiters = new Set(); this._playRevision = 0;
    }
    get active() { return !!this.controller && !this.controller.signal.aborted && this._activeItems.length > 0; }
    get paused() { return this._paused; }
    get activeItems() { return [...this._activeItems]; }
    notifyState() {
        try { this.onStateChange({ active: this.active, paused: this.paused, current: this.current, items: this.activeItems }); }
        catch { /* A UI refresh must not interrupt playback or cancellation. */ }
    }
    pause() {
        if (!this.active) return false;
        ++this._playRevision;
        this._paused = true;
        this.audio?.pause();
        if (this.current && this.audio) this.update(this.current, 'paused');
        this.notifyState();
        return true;
    }
    async resume() {
        if (!this._paused) return false;
        const controller = this.controller, audio = this.audio, current = this.current;
        const revision = ++this._playRevision;
        this._paused = false;
        for (const resume of this._resumeWaiters) resume();
        this.notifyState();
        if (audio && controller) {
            try {
                await this.playAudio(audio, controller.signal);
                if (this.controller === controller && this.audio === audio && current) {
                    this.update(current, this._paused ? 'paused' : 'playing');
                }
            } catch (error) {
                if (this.controller === controller && this.audio === audio &&
                    this._playRevision === revision && !controller.signal.aborted) {
                    this._paused = true; audio.pause();
                    if (current) this.update(current, 'paused');
                    this.notifyState();
                }
                throw error;
            }
        }
        return true;
    }
    async togglePause() { return this._paused ? this.resume() : this.pause(); }
    async waitForResume(signal) {
        checkAbort(signal);
        while (this._paused) {
            await new Promise((resolve, reject) => {
                const clean = () => { this._resumeWaiters.delete(resume); signal.removeEventListener('abort', cancel); };
                const resume = () => { clean(); resolve(); };
                const cancel = () => { clean(); reject(aborted()); };
                this._resumeWaiters.add(resume);
                signal.addEventListener('abort', cancel, { once: true });
            });
            checkAbort(signal);
        }
    }
    async playAudio(audio, signal) {
        checkAbort(signal);
        if (this._paused) return;
        const revision = this._playRevision;
        try { await audio.play(); }
        catch (error) {
            if (signal.aborted) throw aborted();
            // HTMLAudio rejects an outstanding play() when pause() interrupts it.
            if ((this._paused || revision !== this._playRevision) && error.name === 'AbortError') return;
            throw new Error(error.name === 'NotAllowedError' ? '浏览器阻止自动播放，请点击气泡播放。' : error.message);
        }
        if (signal.aborted || this.audio !== audio) { audio.pause(); throw aborted(); }
        // An asynchronous AudioContext.resume may finish after a newer pause.
        if (this._paused) audio.pause();
    }
    stop({ preservePause = false } = {}) {
        this.controller?.abort(); this.controller = null;
        this.streamSession?.dispose(); this.streamSession = null;
        if (this.audio && !this.audio.dispose) { this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load(); }
        this.audio = null; this.current = null;
        this._activeItems = [];
        if (!preservePause) this._paused = false;
        this.notifyState();
    }
    async run(items, { play = true, stream = false, preservePause = false } = {}) {
        this.stop({ preservePause });
        const controller = new AbortController(); this.controller = controller;
        this._activeItems = play ? [...items] : [];
        this.notifyState();
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
        let transport, completed = false;
        try {
            if (streaming && items.length) {
                // resume() must run before preparing the first network request.
                transport = this.streamFactory(); this.streamSession = transport;
                transport.volume = this.volume;
                try { await transport.wake(signal); }
                catch (error) { if (!signal.aborted) this.update(items[0], 'error', error.message); throw error; }
            }
            checkAbort(signal);
            let next = items.length ? prepare(items[0]) : null;
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                const result = await next; checkAbort(signal);
                if (result.error) { this.update(item, 'error', result.error.message); throw result.error; }
                if (!streaming) next = i + 1 < items.length ? prepare(items[i + 1]) : null;
                if (play) {
                    await this.waitForResume(signal); checkAbort(signal);
                    if (result.value.streamUrl) {
                        if (!transport) throw new Error('流式播放未启用。');
                        await this.playStream(item, result.value, signal, transport,
                            () => pendingStreams.delete(result.value));
                    }
                    else await this.playOne(item, result.value, signal);
                }
                if (streaming) next = i + 1 < items.length ? prepare(items[i + 1]) : null;
            }
            completed = true;
        } finally {
            controller.abort();
            transport?.dispose();
            if (this.streamSession === transport) this.streamSession = null;
            if (this.controller === controller) {
                this.controller = null; this.audio = null; this.current = null; this._activeItems = [];
                if (!preservePause || !completed) this._paused = false;
                this.notifyState();
            }
        }
    }
    async playStream(item, record, signal, transport, takeOwnership = () => {}) {
        checkAbort(signal);
        if (!transport) throw new Error('流式播放未启用。');
        this.audio = transport; this.current = item; transport.volume = this.volume;
        this.notifyState();
        try {
            if (transport.paused && !this._paused) await this.playAudio(transport, signal);
            await this.waitForResume(signal); checkAbort(signal);
            // Ownership changes only when run starts, not while a paused
            // prepared descriptor is still waiting for playback permission.
            takeOwnership();
            const result = await transport.run(record, signal, () => {
                checkAbort(signal);
                if (this._paused) transport.pause();
                this.update(item, this._paused ? 'paused' : 'playing');
            });
            checkAbort(signal); this.update(item, 'ready', '', result.duration);
        } catch (error) {
            if (!signal.aborted) this.update(item, 'error', error.message);
            throw error;
        } finally {
            if (this.audio === transport) { this.audio = null; this.current = null; this.notifyState(); }
        }
    }
    async playOne(item, record, signal) {
        checkAbort(signal);
        const audio = this.audioFactory(); this.audio = audio; this.current = item;
        audio.volume = this.volume; audio.src = record.url;
        this.notifyState();
        return new Promise((resolve, reject) => {
            let finished = false;
            const finish = error => {
                if (finished) return;
                finished = true;
                signal.removeEventListener('abort', stop);
                audio.onended = null; audio.onerror = null;
                audio.pause(); audio.removeAttribute('src'); audio.load();
                if (this.audio === audio) { this.audio = null; this.current = null; this.notifyState(); }
                if (!signal.aborted) this.update(item, error ? 'error' : 'ready', error?.message, record.duration);
                error ? reject(error) : resolve();
            };
            const stop = () => finish(aborted());
            signal.addEventListener('abort', stop, { once: true });
            audio.onended = () => finish();
            audio.onerror = () => finish(new Error('音频读取失败，请检查服务或重新生成。'));
            this.update(item, this._paused ? 'paused' : 'playing', '', record.duration);
            this.playAudio(audio, signal).catch(error => finish(error));
        });
    }
    async toggle(item, { stream = false } = {}) {
        if (this.current?.id !== item.id || !this.audio) return this.run([item], { stream });
        return this.togglePause();
    }
}
