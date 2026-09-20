import test from 'node:test';
import assert from 'node:assert/strict';
import { BreezeClient } from '../client.js';

const id = 'd'.repeat(32);
const queued = { id, status: 'queued', stream_url: `/breeze/jobs/${id}/stream` };
const response = record => ({ ok: true, json: async () => record });

test('stream creation returns before completion and keeps synthesis input unchanged for cache reuse', async () => {
    const calls = [];
    const client = new BreezeClient('http://localhost:7860', async (url, options) => {
        calls.push({ url, options }); return response(queued);
    });
    const input = { kind: 'speech', voice_id: 'a'.repeat(32), text: '你好[笑]', seed: 42 };
    const result = await client.startStreamJob(input);
    assert.equal(result.status, 'queued');
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(calls[0].options.body).stream, true);
    assert.equal(input.stream, undefined);
    assert.equal(client.streamUrl(result.stream_url, result.id), `http://localhost:7860/breeze/jobs/${id}/stream`);
});

test('stopping while a stream job is being created cancels the eventual server job', async () => {
    let release;
    const created = new Promise(resolve => { release = resolve; });
    const calls = [], controller = new AbortController();
    const client = new BreezeClient('http://localhost:7860', async (url, options) => {
        calls.push([url, options.method]);
        return response(options.method === 'POST' ? await created : {});
    });
    const work = client.startStreamJob({ text: '你好' }, { signal: controller.signal });
    controller.abort(); release(queued);
    await assert.rejects(work, { name: 'AbortError' });
    assert.deepEqual(calls.map(([, method]) => method), ['POST', 'DELETE']);
    assert.equal(calls[1][0], `http://localhost:7860/breeze/jobs/${id}`);
});

test('stream URL must match this exact job and unsafe creation replies are cancelled', async () => {
    const calls = [];
    const client = new BreezeClient('http://localhost:7860', async (url, options) => {
        calls.push(options.method);
        return response({ ...queued, stream_url: 'https://other.invalid/stream' });
    });
    await assert.rejects(client.startStreamJob({ text: '你好' }), /流式地址/);
    assert.deepEqual(calls, ['POST', 'DELETE']);
    assert.throws(() => client.streamUrl(`/breeze/jobs/${'e'.repeat(32)}/stream`, id), /流式地址/);
});
