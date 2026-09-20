import test from 'node:test';
import assert from 'node:assert/strict';
import { PROMPT_DEFAULTS } from '../prompt.js';
import { listExtraPresets, resolveExtraPrompt, createExtraPreset, updateExtraPreset,
    deleteExtraPreset, uniqueExtraPresetName, migrateLegacyExtraPrompt } from '../extra-prompts.js';

const settings = () => ({ ...PROMPT_DEFAULTS });

test('default library is safely shared while create replaces arrays without editing defaults', () => {
    const first = settings(), second = settings();
    assert.equal(first.extraPromptPresets, second.extraPromptPresets);
    assert.ok(Object.isFrozen(PROMPT_DEFAULTS.extraPromptPresets));
    const before = first.extraPromptPresets;
    const record = createExtraPreset(first, { name: '  校园夜晚  ', text: '' }, () => 'night-id');
    assert.deepEqual(record, { id: 'night-id', name: '校园夜晚', text: '' });
    assert.notEqual(first.extraPromptPresets, before);
    assert.deepEqual(second.extraPromptPresets, []);
    assert.deepEqual(PROMPT_DEFAULTS.extraPromptPresets, []);
});

test('library reads sanitize malformed or duplicate entries without modifying saved settings', () => {
    const cfg = { extraPromptPresets: [
        null, false, { id: 'missing-text', name: '缺少内容' },
        { id: 'good-id', name: '  Campus  ', text: 'Body', extra: 'not returned' },
        { id: 'good-id', name: 'Other', text: 'Duplicate ID' },
        { id: 'different-id', name: 'CAMPUS', text: 'Duplicate name' },
        { id: 'new-line', name: 'Bad\nName', text: 'Invalid' },
        { id: 'bad id', name: 'Invalid ID', text: 'Invalid' },
        { id: 'too-long', name: 'n'.repeat(81), text: 'Invalid' },
        { id: 'second-id', name: 'Other', text: '' },
    ] };
    const original = structuredClone(cfg);
    const records = listExtraPresets(cfg);
    assert.deepEqual(records, [{ id: 'good-id', name: 'Campus', text: 'Body' }, { id: 'second-id', name: 'Other', text: '' }]);
    assert.deepEqual(cfg, original);
    assert.ok(Object.isFrozen(records));
    assert.ok(records.every(Object.isFrozen));
    assert.throws(() => { records[0].text = 'Changed'; }, TypeError);
    assert.deepEqual(listExtraPresets({ extraPromptPresets: {} }), []);
    assert.deepEqual(listExtraPresets(null), []);
});

test('shared edits and rename use the stable ID across independently bound chats', () => {
    const cfg = settings();
    const original = createExtraPreset(cfg, { name: 'Campus', text: 'Original text' }, () => 'stable-id');
    const firstChat = { extraPromptId: original.id }, secondChat = { extraPromptId: original.id };
    const before = cfg.extraPromptPresets;
    const renamed = updateExtraPreset(cfg, original.id, { name: 'Campus at night', text: 'Quieter voices' });
    assert.notEqual(cfg.extraPromptPresets, before);
    assert.deepEqual(before, [original]);
    assert.equal(original.name, 'Campus');
    assert.equal(renamed.id, original.id);
    assert.equal(resolveExtraPrompt(cfg, firstChat), 'Quieter voices');
    assert.equal(resolveExtraPrompt(cfg, secondChat), 'Quieter voices');
    assert.deepEqual(firstChat, { extraPromptId: 'stable-id' });
    assert.deepEqual(secondChat, firstChat);
});

test('explicit selection takes precedence and deleted or empty selections never revive legacy text', () => {
    const cfg = settings();
    createExtraPreset(cfg, { name: 'New', text: 'Current text' }, () => 'new-id');
    const chat = { extraPromptId: 'new-id', extraPrompt: 'Legacy backup' };
    assert.equal(resolveExtraPrompt(cfg, chat), 'Current text');
    const before = cfg.extraPromptPresets;
    assert.equal(deleteExtraPreset(cfg, 'new-id'), true);
    assert.notEqual(cfg.extraPromptPresets, before);
    assert.equal(before.length, 1);
    assert.equal(resolveExtraPrompt(cfg, chat), '');
    assert.equal(deleteExtraPreset(cfg, 'new-id'), false);
    for (const id of [null, '', undefined, 'missing-id']) {
        assert.equal(resolveExtraPrompt(cfg, { ...chat, extraPromptId: id }), '');
    }
    assert.equal(resolveExtraPrompt(cfg, { extraPrompt: 'Legacy backup' }), 'Legacy backup');
    assert.equal(resolveExtraPrompt(cfg, null), '');
    assert.equal(resolveExtraPrompt(cfg, { extraPrompt: 12 }), '');
});

test('legacy migration is idempotent, preserves drafts and enabled state, and keeps chats independent', () => {
    const cfg = settings();
    const originalText = '  Same body text\n';
    const firstChat = { extraPrompt: originalText, extraPromptEnabled: false };
    const secondChat = { extraPrompt: originalText, extraPromptEnabled: true };
    assert.equal(migrateLegacyExtraPrompt(cfg, firstChat, { name: 'Existing chat', idFactory: () => 'first-id' }), true);
    assert.equal(migrateLegacyExtraPrompt(cfg, firstChat, { name: 'Changed', idFactory: () => 'unexpected-id' }), false);
    assert.equal(migrateLegacyExtraPrompt(cfg, secondChat, { name: 'Existing chat', idFactory: () => 'second-id' }), true);
    assert.deepEqual(listExtraPresets(cfg), [
        { id: 'first-id', name: 'Existing chat', text: originalText },
        { id: 'second-id', name: 'Existing chat (2)', text: originalText },
    ]);
    assert.deepEqual(firstChat, { extraPrompt: originalText, extraPromptEnabled: false, extraPromptId: 'first-id' });
    assert.deepEqual(secondChat, { extraPrompt: originalText, extraPromptEnabled: true, extraPromptId: 'second-id' });
    updateExtraPreset(cfg, 'first-id', { name: 'First only', text: 'Separate edit' });
    assert.equal(resolveExtraPrompt(cfg, firstChat), 'Separate edit');
    assert.equal(resolveExtraPrompt(cfg, secondChat), originalText);
});

test('migration leaves blank drafts and explicit selections untouched', () => {
    const cfg = settings();
    for (const data of [null, {}, { extraPrompt: '' }, { extraPrompt: ' \n ' }, { extraPrompt: 1 },
        { extraPrompt: 'Legacy', extraPromptId: null }, { extraPrompt: 'Legacy', extraPromptId: 'deleted-id' }]) {
        const before = structuredClone(data);
        assert.equal(migrateLegacyExtraPrompt(cfg, data), false);
        assert.deepEqual(data, before);
    }
    assert.deepEqual(listExtraPresets(cfg), []);
});

test('names and content are validated before any mutation; failed migration is atomic', () => {
    const cfg = settings();
    createExtraPreset(cfg, { name: 'Campus', text: 'Kept' }, () => 'kept-id');
    const before = cfg.extraPromptPresets;
    for (const name of ['', ' \t ', 'n'.repeat(81), 'Bad\nName', 'Bad\rName', 'Bad\u0000Name', 'campus', ' CAMPUS ']) {
        assert.throws(() => createExtraPreset(cfg, { name, text: 'Bad' }, () => 'new-id'));
        assert.equal(cfg.extraPromptPresets, before);
    }
    for (const text of [null, undefined, 12, {}, []]) {
        assert.throws(() => createExtraPreset(cfg, { name: 'Other', text }, () => 'new-id'));
        assert.equal(cfg.extraPromptPresets, before);
    }
    for (const id of ['', 'kept-id', 'bad id', 'bad\nid', null]) {
        assert.throws(() => createExtraPreset(cfg, { name: 'Other', text: 'Bad' }, () => id));
        assert.equal(cfg.extraPromptPresets, before);
    }
    assert.throws(() => updateExtraPreset(cfg, 'missing-id', { name: 'Other', text: 'Bad' }));
    assert.throws(() => updateExtraPreset(cfg, 'kept-id', { name: '', text: 'Bad' }));
    assert.equal(cfg.extraPromptPresets, before);
    const chat = { extraPrompt: 'Legacy', extraPromptEnabled: true };
    assert.throws(() => migrateLegacyExtraPrompt(cfg, chat, { idFactory: () => 'kept-id' }));
    assert.equal(Object.hasOwn(chat, 'extraPromptId'), false);
    assert.equal(cfg.extraPromptPresets, before);
});

test('automatic names stay unique case-insensitively and within the name limit', () => {
    const cfg = settings();
    createExtraPreset(cfg, { name: 'Campus', text: '' }, () => 'one');
    createExtraPreset(cfg, { name: 'CAMPUS (2)', text: '' }, () => 'two');
    assert.equal(uniqueExtraPresetName(cfg, ' campus '), 'campus (3)');
    const longName = 'x'.repeat(80);
    createExtraPreset(cfg, { name: longName, text: '' }, () => 'long');
    const suffixed = uniqueExtraPresetName(cfg, longName);
    assert.equal(suffixed.length, 80);
    assert.ok(suffixed.endsWith(' (2)'));
    assert.equal(uniqueExtraPresetName(cfg, 'Night\nCampus'), 'Night Campus');
    assert.equal(uniqueExtraPresetName(cfg, '  '), '聊天额外语料');
});

test('literal punctuation, macros and markup in text are preserved exactly', () => {
    const cfg = settings();
    const body = '<scene>\n[笑] {{user}} {{vocal_events}} $& $\' $$\n</scene>  ';
    const record = createExtraPreset(cfg, { name: '<Scene> {{name}}', text: body }, () => 'literal');
    assert.equal(record.text, body);
    assert.equal(resolveExtraPrompt(cfg, { extraPromptId: record.id }), body);
});

test('LAN HTTP can generate a secure stable ID when randomUUID is unavailable', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    let calls = 0;
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {
        getRandomValues(bytes) {
            calls++;
            for (let index = 0; index < bytes.length; index++) bytes[index] = index;
            return bytes;
        },
    } });
    try {
        const cfg = settings();
        const record = createExtraPreset(cfg, { name: 'LAN scene', text: 'Soft voice' });
        assert.equal(record.id, '000102030405060708090a0b0c0d0e0f');
        assert.equal(calls, 1);
        assert.equal(resolveExtraPrompt(cfg, { extraPromptId: record.id }), 'Soft voice');
    } finally {
        if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
        else delete globalThis.crypto;
    }
});
