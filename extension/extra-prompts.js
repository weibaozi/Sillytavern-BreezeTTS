// The library is shared across chats; chat metadata stores only a stable ID.
const MAX_NAME_LENGTH = 80;
const normalizedName = value => typeof value === 'string' ? value.trim() : '';
const nameKey = value => value.toLowerCase();
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const validName = value => typeof value === 'string' && normalizedName(value)
    && normalizedName(value).length <= MAX_NAME_LENGTH && !/[\r\n\u0000-\u001f\u007f]/.test(value);
const randomId = () => {
    const crypto = globalThis.crypto;
    if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
    // randomUUID requires a secure context; LAN HTTP still exposes getRandomValues.
    if (typeof crypto?.getRandomValues !== 'function') throw new Error('浏览器无法生成语料标识，请更新浏览器。');
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
};

export function listExtraPresets(settings) {
    const source = Array.isArray(settings?.extraPromptPresets) ? settings.extraPromptPresets : [];
    const ids = new Set(), names = new Set(), records = [];
    for (const entry of source) {
        if (!entry || typeof entry !== 'object' || !validId(entry.id)
            || !validName(entry.name) || typeof entry.text !== 'string') continue;
        const name = normalizedName(entry.name), key = nameKey(name);
        if (ids.has(entry.id) || names.has(key)) continue;
        ids.add(entry.id);
        names.add(key);
        records.push(Object.freeze({ id: entry.id, name, text: entry.text }));
    }
    return Object.freeze(records);
}

export function resolveExtraPrompt(settings, data) {
    if (data && Object.hasOwn(data, 'extraPromptId')) {
        return listExtraPresets(settings).find(entry => entry.id === data.extraPromptId)?.text || '';
    }
    return typeof data?.extraPrompt === 'string' ? data.extraPrompt : '';
}

function validatePreset(settings, { name, text }, excludingId = null) {
    if (!validName(name)) throw new Error('语料名称不能为空，最多 80 个字符，且不能包含换行或控制字符。');
    name = normalizedName(name);
    if (typeof text !== 'string') throw new Error('语料内容必须是文本。');
    if (listExtraPresets(settings).some(entry => entry.id !== excludingId && nameKey(entry.name) === nameKey(name))) {
        throw new Error('已有同名语料，请使用不同的名称。');
    }
    return { name, text };
}

export function createExtraPreset(settings, fields, idFactory = randomId) {
    const values = validatePreset(settings, fields);
    const id = idFactory();
    if (!validId(id) || listExtraPresets(settings).some(entry => entry.id === id)) {
        throw new Error('无法创建唯一的语料标识，请重试。');
    }
    const record = Object.freeze({ id, ...values });
    settings.extraPromptPresets = [...listExtraPresets(settings), record];
    return record;
}

export function updateExtraPreset(settings, id, fields) {
    const records = listExtraPresets(settings);
    if (!records.some(entry => entry.id === id)) throw new Error('该语料已不存在，请重新选择。');
    const record = Object.freeze({ id, ...validatePreset(settings, fields, id) });
    settings.extraPromptPresets = records.map(entry => entry.id === id ? record : entry);
    return record;
}

export function deleteExtraPreset(settings, id) {
    const records = listExtraPresets(settings);
    if (!records.some(entry => entry.id === id)) return false;
    settings.extraPromptPresets = records.filter(entry => entry.id !== id);
    return true;
}

export function uniqueExtraPresetName(settings, base = '聊天额外语料') {
    const clean = (typeof base === 'string' ? base : '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim() || '聊天额外语料';
    const stem = clean.slice(0, MAX_NAME_LENGTH);
    const names = new Set(listExtraPresets(settings).map(entry => nameKey(entry.name)));
    if (!names.has(nameKey(stem))) return stem;
    for (let suffix = 2; ; suffix++) {
        const ending = ` (${suffix})`;
        const candidate = `${stem.slice(0, MAX_NAME_LENGTH - ending.length)}${ending}`;
        if (!names.has(nameKey(candidate))) return candidate;
    }
}

export function migrateLegacyExtraPrompt(settings, data, { name, idFactory = randomId } = {}) {
    if (!data || Object.hasOwn(data, 'extraPromptId')
        || typeof data.extraPrompt !== 'string' || !data.extraPrompt.trim()) return false;
    const preset = createExtraPreset(settings, {
        name: uniqueExtraPresetName(settings, name), text: data.extraPrompt,
    }, idFactory);
    data.extraPromptId = preset.id;
    // Keep the legacy text as a backup, but an explicit ID always takes precedence.
    return true;
}
