import { aborted, checkAbort } from './client.js';

const BLOCKED = '浏览器阻止自动播放，请点击气泡播放。';
const MAX_LINE = 8 * 1024 * 1024;

function audioContext() {
    const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Context) throw new Error('当前浏览器不支持流式音频播放，请关闭流式传输。');
    return new Context();
}

function wait(ms, signal) {
    return new Promise((resolve, reject) => {
        checkAbort(signal);
        const cancel = () => { clearTimeout(timer); reject(aborted()); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
        signal.addEventListener('abort', cancel, { once: true });
    });
}

// Each NDJSON audio record is signed, little-endian 16-bit mono PCM.
export function decodePCM(pcm) {
    if (typeof pcm !== 'string' || !pcm.length) throw new Error('流式音频数据为空。');
    let raw;
    try { raw = atob(pcm); } catch { throw new Error('流式音频编码无效。'); }
    if (!raw.length || raw.length % 2) throw new Error('流式音频采样不完整。');
    const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    const samples = new Float32Array(bytes.length / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    return samples;
}

export class PCMStreamPlayer {
    constructor({ contextFactory = audioContext, maxWait = 600000, maxLookAhead = 30, activationWait = 1500 } = {}) {
        this.context = contextFactory();
        this.gain = this.context.createGain(); this.gain.connect(this.context.destination);
        this.maxWait = maxWait; this.maxLookAhead = maxLookAhead; this.activationWait = activationWait;
        this.sources = new Set(); this.paused = false; this.disposed = false;
        this.active = null; this.pendingPause = Promise.resolve(); this.volume = 0.8;
    }
    get volume() { return this.gain.gain.value; }
    set volume(value) { this.gain.gain.value = Math.max(0, Math.min(1, Number(value) || 0)); }
    // Called directly by the click handler, before any network await loses activation.
    wake(signal) {
        checkAbort(signal);
        const resumed = this.context.resume();
        return new Promise((resolve, reject) => {
            const finish = error => {
                clearTimeout(timer); signal.removeEventListener('abort', cancel);
                error ? reject(error) : resolve();
            };
            const cancel = () => finish(aborted());
            const timer = setTimeout(() => finish(new Error(BLOCKED)), this.activationWait);
            signal.addEventListener('abort', cancel, { once: true });
            Promise.resolve(resumed).then(() => {
                if (signal.aborted) finish(aborted());
                else finish(this.context.state === 'running' ? null : new Error(BLOCKED));
            }, () => finish(new Error(BLOCKED)));
        });
    }
    pause() {
        if (this.disposed) return;
        this.paused = true;
        this.pendingPause = Promise.resolve(this.context.suspend()).catch(() => {});
    }
    async play() {
        if (this.disposed) throw aborted();
        await this.pendingPause;
        try { await this.context.resume(); } catch { throw new Error(BLOCKED); }
        if (this.disposed) throw aborted();
        if (this.context.state !== 'running') throw new Error(BLOCKED);
        this.paused = false;
    }
    stopSources() {
        for (const source of this.sources) {
            source.onended = null;
            try { source.stop(); } catch { /* A source may already have ended. */ }
            source.disconnect();
        }
        this.sources.clear();
    }
    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.active?.abort(); this.stopSources();
        this.gain.disconnect();
        void Promise.resolve(this.context.close()).catch(() => {});
    }
    async run(record, signal, onStart = () => {}) {
        checkAbort(signal);
        if (this.disposed || this.active) throw new Error('流式播放器不可用。');
        const controller = new AbortController(); this.active = controller;
        let reader, timeoutError, serverDone = false, started = false, nextStart = 0, duration = 0;
        let finishTail;
        const tail = new Promise(resolve => { finishTail = resolve; });
        const cancel = () => controller.abort();
        const halt = () => {
            this.stopSources(); finishTail();
            if (reader) void reader.cancel().catch(() => {});
        };
        signal.addEventListener('abort', cancel, { once: true });
        controller.signal.addEventListener('abort', halt, { once: true });
        const timeout = setTimeout(() => {
            timeoutError = new Error('流式语音生成超时，请重试。'); controller.abort();
        }, this.maxWait);
        const ensureActive = () => { if (timeoutError) throw timeoutError; checkAbort(controller.signal); };
        const consume = async line => {
            if (!line.trim()) return;
            let event;
            try { event = JSON.parse(line); } catch { throw new Error('流式响应格式无效。'); }
            if (!event || typeof event !== 'object') throw new Error('流式响应格式无效。');
            if (event.type === 'ping' || event.type === 'keepalive') return;
            if (event.type === 'error') throw new Error(event.error || '流式语音生成失败。');
            if (event.type === 'done') {
                if (!event.job || event.job.status !== 'done') throw new Error('流式语音未成功完成。');
                serverDone = true; clearTimeout(timeout);
                ensureActive();
                await record.complete?.(event.job);
                ensureActive();
                duration = Number(event.job.duration) || duration;
                if (!this.sources.size) finishTail();
                return;
            }
            if (event.type !== 'audio') throw new Error('未知的流式音频事件。');
            const rate = Number(event.sample_rate);
            if (!Number.isInteger(rate) || rate < 8000 || rate > 192000) throw new Error('流式音频采样率无效。');
            while (nextStart - this.context.currentTime > this.maxLookAhead) {
                await wait(100, controller.signal); ensureActive();
            }
            const samples = decodePCM(event.pcm);
            const buffer = this.context.createBuffer(1, samples.length, rate);
            buffer.getChannelData(0).set(samples);
            const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.gain);
            this.sources.add(source);
            source.onended = () => {
                source.disconnect(); this.sources.delete(source);
                if (serverDone && !this.sources.size) finishTail();
            };
            const start = Math.max(this.context.currentTime + (started ? 0.02 : 0.08), nextStart);
            nextStart = start + samples.length / rate; duration += samples.length / rate;
            source.start(start);
            if (!started) { started = true; onStart(); }
        };
        try {
            const response = await record.fetcher(record.streamUrl, { signal: controller.signal, headers: { Accept: 'application/x-ndjson' } });
            ensureActive();
            if (!response.ok) throw new Error(`流式音频请求失败（${response.status}）。`);
            if (!response.body?.getReader) throw new Error('当前浏览器无法读取流式音频。');
            reader = response.body.getReader();
            const decoder = new TextDecoder(); let pending = '';
            while (!serverDone) {
                const chunk = await reader.read(); ensureActive();
                pending += decoder.decode(chunk.value, { stream: !chunk.done });
                let newline;
                while (!serverDone && (newline = pending.indexOf('\n')) !== -1) {
                    const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
                    if (line.length > MAX_LINE) throw new Error('流式音频记录过大。');
                    await consume(line); ensureActive();
                }
                if (pending.length > MAX_LINE) throw new Error('流式音频记录过大。');
                if (chunk.done) {
                    if (!serverDone && pending.trim()) await consume(pending);
                    if (!serverDone) throw new Error('流式连接提前断开，请重新生成。');
                    break;
                }
            }
            // Cache the completed WAV immediately, but never overlap the next dialogue
            // with this segment's still-playing audio buffers.
            if (reader) void reader.cancel().catch(() => {});
            await tail; ensureActive();
            return { duration };
        } catch (error) {
            this.stopSources();
            if (!serverDone) void Promise.resolve().then(() => record.cancel?.()).catch(() => {});
            if (timeoutError) throw timeoutError;
            if (signal.aborted || controller.signal.aborted) throw aborted();
            throw error;
        } finally {
            clearTimeout(timeout); signal.removeEventListener('abort', cancel);
            controller.signal.removeEventListener('abort', halt);
            if (reader) { void reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch { /* Pending read was aborted. */ } }
            controller.abort();
            if (this.active === controller) this.active = null;
        }
    }
}

export const createPCMStream = options => new PCMStreamPlayer(options);
