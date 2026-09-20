import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountStudioEntry } from '../menu.js';

test('wand entry waits for host menu, supports keyboard and does not duplicate', async () => {
    const dom = new JSDOM('<body><form id="send_form"></form></body>');
    globalThis.document = dom.window.document; globalThis.MutationObserver = dom.window.MutationObserver;
    let opened = 0;
    const cleanup = mountStudioEntry(() => { opened++; });
    assert.equal(document.querySelector('#send_form').children.length, 0);
    const menu = document.createElement('div'); menu.id = 'extensionsMenu'; document.body.append(menu);
    await new Promise(resolve => setImmediate(resolve));
    const entry = menu.querySelector('#breeze_studio_wand_entry');
    assert.equal(entry.textContent, 'Breeze 语音工作室');
    mountStudioEntry(() => { opened += 100; });
    assert.equal(menu.querySelectorAll('#breeze_studio_wand_entry').length, 1);
    entry.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    entry.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    assert.equal(opened, 2);
    cleanup(); assert.equal(menu.children.length, 0);
    dom.window.close();
});
