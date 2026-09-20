import { normalizeBase } from './core.js';

export function aborted() { return new DOMException('已停止', 'AbortError'); }
export function checkAbort(signal) { if (signal?.aborted) throw aborted(); }
export function delay(ms, signal) {
    return new Promise((resolve, reject) => {
        checkAbort(signal);
        const stop = () => { clearTimeout(timer); reject(aborted()); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
        signal?.addEventListener('abort', stop, { once: true });
    });
}

export class BreezeClient {
    constructor(base, fetcher = globalThis.fetch.bind(globalThis)) { this.base = normalizeBase(base); this.fetcher = fetcher; }
    async request(path, { method = 'GET', body, signal, timeout = 30000 } = {}) {
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) controller.abort();
        const timer = setTimeout(abort, timeout);
        try {
            const form = typeof FormData !== 'undefined' && body instanceof FormData;
            const response = await this.fetcher(this.base + path, { method, body: body == null ? undefined : form ? body : JSON.stringify(body),
                headers: body != null && !form ? { 'Content-Type': 'application/json' } : {}, signal: controller.signal, credentials: 'omit' });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `Breeze 请求失败 (${response.status})`);
            return data;
        } catch (error) {
            if (signal?.aborted) throw aborted();
            if (controller.signal.aborted) throw new Error('Breeze 请求超时，请检查服务。');
            throw error;
        } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    }
    audioUrl(path) {
        if (!/^\/breeze\/(jobs|voices)\/[a-f0-9]{32}\/audio$/.test(path)) throw new Error('服务返回了无效的音频地址。');
        return this.base + path;
    }
    streamUrl(path, jobId) {
        if (!/^[a-f0-9]{32}$/.test(jobId) || path !== `/breeze/jobs/${jobId}/stream`) throw new Error('服务返回了无效的流式地址。');
        return this.base + path;
    }
    async startStreamJob(body, { signal } = {}) {
        checkAbort(signal);
        // Keep the creation request alive long enough to learn its ID and cancel it.
        const record = await this.request('/breeze/jobs', { method: 'POST', body: { ...body, stream: true } });
        try {
            checkAbort(signal);
            this.streamUrl(record.stream_url, record.id);
            return record;
        } catch (error) {
            if (/^[a-f0-9]{32}$/.test(record.id)) await this.request(`/breeze/jobs/${record.id}`, { method: 'DELETE', timeout: 5000 }).catch(() => {});
            throw error;
        }
    }
    async runJob(body, { signal, status = () => {}, maxWait = 600000, direction = false } = {}) {
        checkAbort(signal);
        let record;
        try {
            // Get the ID even when stopped during POST so the submitted job can be cancelled.
            record = await this.request(direction ? '/breeze/jobs/direction' : '/breeze/jobs', { method: 'POST', body });
            if (!/^[a-f0-9]{32}$/.test(record.id)) throw new Error('服务返回了无效任务 ID。');
            const deadline = Date.now() + maxWait;
            for (;;) {
                checkAbort(signal); status(record.status);
                if (record.status === 'done') { this.audioUrl(record.audio_url); return record; }
                if (record.status === 'error' || record.status === 'cancelled') throw new Error(record.error || '任务已取消');
                if (Date.now() > deadline) throw new Error('合成等待超时，可稍后重试。');
                await delay(650, signal);
                record = await this.request(`/breeze/jobs/${record.id}`, { signal });
            }
        } finally {
            if (record?.id && record.status !== 'done' && /^[a-f0-9]{32}$/.test(record.id)) {
                await this.request(`/breeze/jobs/${record.id}`, { method: 'DELETE', timeout: 5000 }).catch(() => {});
            }
        }
    }
}
