import { KEY, DEFAULTS, parseTTS, chatKey, discoverSpeakers, mappedVoice, requestFor, cacheKey, normalizeBase } from './core.js';
import { BreezeClient, checkAbort } from './client.js';
import { SpeechPlayer } from './player.js';
import { PROMPT_DEFAULTS, DEFAULT_TEMPLATE, STABLE_DEFAULT_TEMPLATE, DEFAULT_VOCAL_EVENTS, parseVocalEvents, syncVoicePrompt } from './prompt.js';
import { listExtraPresets, createExtraPreset, updateExtraPreset, deleteExtraPreset, uniqueExtraPresetName, migrateLegacyExtraPrompt } from './extra-prompts.js';
import { displayDialogue, hasLegacyDialogue } from './dialogue-render.js';
import { createStudioPanel } from './panel.js';
import { mountStudioEntry } from './menu.js';

const context = () => window.SillyTavern.getContext();
const el = (tag, text, cls) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (cls) node.className = cls; return node; };
let settings, client, voices = [], studio, dialog, generation = false, epoch = 0, renderTimer;
let items = new Map(), autoPending = new Set(), consumed = new Set(), designController;
let connectionVersion = 0;
let automaticTimer, allowAutomatic = false;
let injectionType = null;
let serviceState = 'offline', supportsStreaming = false, previewAudio, previewButton;
const memory = new Map();

function meta(create = false) {
    const ctx = context();
    if (!chatKey(ctx)) return { mappings: {}, manual: [], cache: {} };
    if (!ctx.chatMetadata[KEY] && create) ctx.chatMetadata[KEY] = { mappings: {}, manual: [], cache: {} };
    const data = ctx.chatMetadata[KEY] || {};
    return { mappings: data.mappings || {}, manual: data.manual || [], cache: data.cache || {}, ...data };
}
function saveMeta() { return Promise.resolve(context().saveMetadata()).catch(error => notice(error.message)); }
function saveSettings() {
    const ctx = context(), saved = ctx.extensionSettings[KEY] || {};
    // Experimental edits use their own field so returning to stable keeps its template.
    ctx.extensionSettings[KEY] = { ...settings,
        promptTemplate: typeof saved.promptTemplate === 'string' ? saved.promptTemplate : STABLE_DEFAULT_TEMPLATE,
        tagRenderPromptTemplate: settings.promptTemplate };
    ctx.saveSettingsDebounced();
}
function notice(message) { const node = dialog?.querySelector('[data-status]'); if (node) node.textContent = message; }
function studioText(selector, value) { dialog?.querySelectorAll(selector).forEach(node => { node.textContent = value; }); }
function refreshStudioSummary() {
    if (!dialog) return;
    const ctx = context(), data = meta();
    const names = chatKey(ctx) ? discoverSpeakers(ctx, [...data.manual, ...Object.keys(data.mappings)]) : [];
    const bound = names.filter(name => mappedVoice(data.mappings, name, voices));
    const group = ctx.groups?.find(g => String(g.id) === String(ctx.groupId));
    const chatName = chatKey(ctx) ? group?.name || ctx.characters?.[ctx.characterId]?.name || ctx.name2 || '当前聊天' : '尚未打开聊天';
    studioText('[data-chat-name]', chatName);
    studioText('[data-character-count]', String(names.length));
    studioText('[data-bound-count]', String(bound.length));
    studioText('[data-voice-count]', String(voices.length));
    studioText('[data-volume-value]', `${Math.round(Number(settings.volume) * 100)}%`);
    studioText('[data-playback-label]', settings.autoPlay ? '自动播放已开启' : settings.autoGenerate ? '自动生成 · 手动播放' : '点击气泡播放');
    studioText('[data-service-label]', { offline: '未连接', connecting: '正在连接', ready: '模型已就绪', unloaded: '模型未加载' }[serviceState]);
    dialog.querySelectorAll('[data-service-dot]').forEach(node => { node.dataset.state = serviceState; });
}
function stopPreview() {
    if (previewAudio) { previewAudio.pause(); previewAudio.removeAttribute('src'); previewAudio.load(); }
    if (previewButton) { previewButton.textContent = '试听'; previewButton.setAttribute('aria-pressed', 'false'); }
    previewAudio = null; previewButton = null;
}
async function previewVoice(voice, button) {
    if (previewButton === button) { stopPreview(); return; }
    stopPlayback(); stopPreview(); dialog.querySelectorAll('audio').forEach(a => a.pause());
    const audio = new Audio(); previewAudio = audio; previewButton = button;
    try {
        audio.src = client.audioUrl(voice.audio_url); audio.volume = Number(settings.volume);
        button.textContent = '停止'; button.setAttribute('aria-pressed', 'true');
        audio.onended = () => { if (previewAudio === audio) stopPreview(); };
        audio.onerror = () => { if (previewAudio === audio) { stopPreview(); notice('试听读取失败，请检查 TTS 连接。'); } };
        await audio.play();
    } catch (error) { if (previewAudio === audio) { stopPreview(); notice(`无法试听：${error.message}`); } }
}
function refreshPrompt() {
    const ctx = context(), key = chatKey(ctx), data = meta();
    if (key) {
        const label = ctx.getCurrentChatId?.() ?? ctx.chatId ?? ctx.name2 ?? '当前聊天';
        if (migrateLegacyExtraPrompt(settings, data, { name: `${label} · 旧语料` })) {
            ctx.chatMetadata[KEY] = data; saveSettings(); void saveMeta();
        }
    }
    const eventsInput = dialog?.querySelector('[data-vocal-events]');
    if (eventsInput && eventsInput.value !== settings.vocalEvents) eventsInput.value = settings.vocalEvents;
    const eventsStatus = dialog?.querySelector('[data-vocal-events-status]');
    if (eventsStatus) {
        const { events, invalid } = parseVocalEvents(settings.vocalEvents);
        eventsStatus.textContent = invalid.length
            ? `有 ${invalid.length} 项格式无效，未加入预览；请使用单层方括号标签，或直接填写名称。`
            : events.length ? `已采用 ${events.length} 项，自动保存并实时更新预览。` : '列表为空：不添加语气词。';
        if (typeof settings.promptTemplate === 'string' && !settings.promptTemplate.includes('{{vocal_events}}')) {
            eventsStatus.textContent += ' 当前自定义模板未包含 {{vocal_events}}，请添加插槽以同步列表。';
        }
        eventsStatus.dataset.state = invalid.length ? 'error' : 'ready';
        eventsInput?.setAttribute('aria-invalid', String(invalid.length > 0));
    }
    const extraInput = dialog?.querySelector('[data-extra-prompt]');
    const extraToggle = dialog?.querySelector('[data-extra-prompt-enabled]');
    const extraSelect = dialog?.querySelector('[data-extra-prompt-select]');
    const extraName = dialog?.querySelector('[data-extra-prompt-name]');
    const presets = listExtraPresets(settings);
    const selectedId = typeof data.extraPromptId === 'string' ? data.extraPromptId : '';
    const selected = presets.find(preset => preset.id === selectedId);
    if (extraSelect) {
        extraSelect.disabled = !key; extraSelect.dataset.chat = key;
        const signature = JSON.stringify([key, selectedId, presets.map(preset => [preset.id, preset.name])]);
        if (extraSelect.dataset.signature !== signature) {
            extraSelect.replaceChildren(new Option('不使用语料', ''));
            for (const preset of presets) extraSelect.append(new Option(preset.name, preset.id));
            if (selectedId && !selected) extraSelect.append(new Option('原语料不可用，请重新选择', selectedId));
            extraSelect.value = selectedId; extraSelect.dataset.signature = signature;
        }
    }
    const editorKey = JSON.stringify([key, selectedId]);
    const editorChanged = extraInput?.dataset.editor !== editorKey;
    if (extraInput) {
        extraInput.disabled = !key || !selected; extraInput.dataset.chat = key; extraInput.dataset.preset = selectedId;
        extraInput.dataset.editor = editorKey;
        if (extraInput.value !== (selected?.text || '')) extraInput.value = selected?.text || '';
    }
    if (extraName) {
        extraName.disabled = !key || !selected;
        if (editorChanged) extraName.setCustomValidity('');
        if (editorChanged || dialog.getRootNode().activeElement !== extraName) extraName.value = selected?.name || '';
    }
    if (extraToggle) { extraToggle.disabled = !key; extraToggle.checked = data.extraPromptEnabled === true; }
    const newExtra = dialog?.querySelector('[data-new-extra-prompt]');
    if (newExtra) newExtra.disabled = !key;
    for (const selector of ['[data-copy-extra-prompt]', '[data-delete-extra-prompt]']) {
        const button = dialog?.querySelector(selector);
        if (button) button.disabled = !key || !selected;
    }
    const extraStatus = dialog?.querySelector('[data-extra-prompt-status]');
    if (extraStatus) extraStatus.textContent = !key ? '请先打开聊天，再设置本聊天的额外语料。'
        : selectedId && !selected ? '原语料已不可用，当前不追加第 6 条；请重新选择。'
            : !selected ? '请选择已有语料，或新建一份并使用。'
                : !data.extraPromptEnabled ? `已绑定「${selected.name}」，当前聊天未启用。`
                    : selected.text.trim() ? `已使用「${selected.name}」追加第 6 条；聊天绑定独立保存。` : '内容为空，不追加第 6 条。';
    const result = syncVoicePrompt(ctx, settings, voices, injectionType);
    const preview = dialog?.querySelector('[data-prompt-preview]');
    if (preview) preview.value = result.text;
    const status = dialog?.querySelector('[data-prompt-status]');
    if (status) status.textContent = result.reason;
}
function valid(item) {
    const ctx = context(), msg = ctx.chat[item.messageId];
    return item.epoch === epoch && chatKey(ctx) === item.chat && msg && !msg.is_user && !msg.is_system &&
        msg.mes === item.rawMessage && (msg.swipe_id ?? 0) === item.swipe;
}
function update(item, state, error = '', duration) {
    if (!valid(item)) return;
    Object.assign(item, { state, error }); if (duration != null) item.duration = duration;
    const labels = { idle: '▶', queued: '排队', running: '生成中', ready: '▶', playing: '暂停', paused: '继续', error: '重试', unmapped: '未映射' };
    for (const button of document.querySelectorAll('.breeze-bubble')) {
        if (button.dataset.item !== item.id) continue;
        button.textContent = `${item.segment.speaker} · ${labels[state] || state}${item.duration ? ` ${item.duration.toFixed(1)}s` : ''}`;
        button.dataset.state = state;
        button.title = error || `${item.segment.emotion}：${item.segment.text}`;
        button.setAttribute('aria-label', `${button.textContent} ${error || item.segment.text}`);
    }
}
async function prepare(item, signal, { stream = false } = {}) {
    checkAbort(signal);
    if (!valid(item)) throw new Error('消息已变化，请重新点击。');
    const voiceId = mappedVoice(meta().mappings, item.segment.speaker, voices);
    if (!voiceId) throw new Error('尚未绑定有效音色，请在 Breeze 语音面板中选择。');
    const api = client;
    const request = requestFor(item.segment, voiceId, settings);
    const key = cacheKey(api.base, request);
    if (memory.has(key)) {
        const audio = memory.get(key); update(item, 'ready', '', audio.duration); return audio;
    }
    const cache = meta().cache;
    const saved = cache[key];
    if (saved) {
        try {
            const record = await api.request(`/breeze/jobs/${saved.id}`, { signal });
            checkAbort(signal);
            if (record.status === 'done') {
                const audio = { url: api.audioUrl(record.audio_url), duration: record.duration };
                memory.set(key, audio); update(item, 'ready', '', record.duration); return audio;
            }
        } catch (error) { checkAbort(signal); }
    }
    const cacheResult = (record, ready = true) => {
        checkAbort(signal);
        if (!valid(item)) throw new Error('消息已变化，已忽略旧音频。');
        const audio = { url: api.audioUrl(record.audio_url), duration: record.duration };
        memory.set(key, audio); if (memory.size > 128) memory.delete(memory.keys().next().value);
        const data = meta(true);
        data.cache[key] = { id: record.id };
        while (Object.keys(data.cache).length > 256) delete data.cache[Object.keys(data.cache)[0]];
        context().chatMetadata[KEY] = data; void saveMeta();
        if (ready) update(item, 'ready', '', record.duration);
        else if (record.duration != null) update(item, item.state, '', record.duration);
        return audio;
    };
    if (stream) {
        if (!supportsStreaming) throw new Error('当前后端未提供流式任务，请更新并重启 Breeze，或关闭流式播放。');
        update(item, 'queued');
        const record = await api.startStreamJob(request, { signal });
        return {
            streamUrl: api.streamUrl(record.stream_url, record.id),
            fetcher: (url, options) => api.fetcher(url, { ...options, credentials: 'omit' }),
            complete: async job => {
                if (job?.id !== record.id || job.status !== 'done') throw new Error('流式任务的完成记录不匹配。');
                return cacheResult(job, false);
            },
            cancel: () => api.request(`/breeze/jobs/${record.id}`, { method: 'DELETE', timeout: 5000 }).catch(() => {}),
        };
    }
    const record = await api.runJob(request, { signal, status: state => update(item, state) });
    return cacheResult(record);
}
const player = new SpeechPlayer({ prepare, update });
function stopPlayback() {
    player.stop();
    for (const item of items.values()) if (['playing', 'paused', 'queued', 'running'].includes(item.state)) update(item, 'idle');
}
function invalidate() {
    stopPlayback(); stopPreview(); dialog?.querySelectorAll('audio').forEach(a => a.pause());
    epoch++; autoPending.clear(); allowAutomatic = false;
    clearTimeout(automaticTimer); designController?.abort(); scheduleRender();
}
async function play(item) {
    if (!settings.enabled) return;
    if (!mappedVoice(meta().mappings, item.segment.speaker, voices)) { openPanel('characters'); return; }
    stopPreview(); dialog?.querySelectorAll('audio').forEach(a => a.pause());
    player.volume = Number(settings.volume);
    try { await player.toggle(item, { stream: settings.streaming }); }
    catch (error) { if (error.name !== 'AbortError') { update(item, 'error', error.message); notice(error.message); } }
}
function bubble(item) {
    const button = el('button', '', 'breeze-bubble'); button.type = 'button'; button.dataset.item = item.id;
    button.addEventListener('click', () => { void play(item); });
    button.addEventListener('contextmenu', event => {
        event.preventDefault(); stopPlayback();
        const id = mappedVoice(meta().mappings, item.segment.speaker, voices);
        if (id) {
            const key = cacheKey(client.base, requestFor(item.segment, id, settings));
            memory.delete(key); const data = meta(true); delete data.cache[key]; context().chatMetadata[KEY] = data; void saveMeta();
        }
        update(item, 'idle'); notice('已清除此句的缓存引用，下次点击会重新生成。');
    });
    return button;
}
function restoreMessage(container) {
    for (const wrapper of container.querySelectorAll('.breeze-inline')) {
        const original = wrapper.querySelector('.breeze-original'); wrapper.replaceWith(document.createTextNode(original?.textContent || ''));
    }
    container.querySelectorAll('.breeze-tray').forEach(n => n.remove());
}
function textMap(root) {
    const nodes = []; let text = '';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.parentElement?.closest('pre,code,script,style,button,textarea,w2g,catsay,details,summary,think,thinking,analysis,status,options,.breeze-tray')) continue;
        nodes.push({ node, start: text.length, end: text.length + node.textContent.length }); text += node.textContent;
    }
    return { text, nodes };
}
function insertBubbles(container, messageItems) {
    const body = container.querySelector('.mes_text'); if (!body) return;
    const map = textMap(body); let cursor = 0;
    const replacements = [], fallback = [];
    for (const item of messageItems) {
        const start = map.text.indexOf(item.segment.raw, cursor);
        if (start < 0) { fallback.push(item); continue; }
        const end = start + item.segment.raw.length;
        const first = map.nodes.find(n => n.start <= start && n.end > start);
        const last = map.nodes.find(n => n.start < end && n.end >= end);
        if (!first || !last) { fallback.push(item); continue; }
        replacements.push({ item, start, end, first, last }); cursor = end;
    }
    // Reverse DOM order keeps earlier text-node offsets valid.
    for (const { item, start, end, first, last } of replacements.reverse()) {
        const range = document.createRange();
        range.setStart(first.node, start - first.start); range.setEnd(last.node, end - last.start);
        const wrapper = el('span', null, 'breeze-inline');
        const original = el('span', item.segment.raw, 'breeze-original'); original.hidden = settings.hideTags;
        wrapper.append(original);
        if (settings.hideTags && !item.legacyDialogue && item.displayText) {
            wrapper.append(el('span', `“${item.displayText}”`, 'breeze-dialogue'));
        }
        wrapper.append(bubble(item)); range.deleteContents(); range.insertNode(wrapper);
    }
    const tray = el('div', null, 'breeze-tray');
    const all = el('button', '▶ 播放本条', 'menu_button'); all.type = 'button';
    all.addEventListener('click', () => {
        const eligible = messageItems.filter(i => mappedVoice(meta().mappings, i.segment.speaker, voices));
        if (!eligible.length) return openPanel('characters');
        player.volume = Number(settings.volume);
        stopPreview(); dialog?.querySelectorAll('audio').forEach(a => a.pause());
        void player.run(eligible, { stream: settings.streaming }).catch(e => { if (e.name !== 'AbortError') notice(e.message); });
    });
    tray.append(all);
    for (const item of fallback) {
        const row = el('div', null, 'breeze-fallback');
        if (!settings.hideTags) row.append(el('span', item.segment.raw, 'breeze-original'));
        else if (item.displayText && !item.legacyDialogue) {
            row.append(el('span', `“${item.displayText}”`, 'breeze-dialogue'));
        }
        row.append(bubble(item)); tray.append(row);
    }
    body.after(tray);
}
function render() {
    const ctx = context(), key = chatKey(ctx), next = new Map();
    for (const container of document.querySelectorAll('#chat .mes[mesid]')) {
        restoreMessage(container);
        if (!settings.enabled || !key) continue;
        const messageId = Number(container.getAttribute('mesid')), msg = ctx.chat[messageId];
        if (!msg || msg.is_user || msg.is_system) continue;
        const { segments, diagnostics } = parseTTS(msg.mes, ctx.name1);
        const entries = segments.map((segment, index) => {
            const id = JSON.stringify([key, messageId, msg.swipe_id ?? 0, msg.mes, segment.ordinal]);
            const previous = items.get(id);
            const item = previous?.epoch === epoch ? previous : { id, chat: key, messageId, rawMessage: msg.mes,
                swipe: msg.swipe_id ?? 0, segment, epoch, state: 'idle' };
            item.displayText = displayDialogue(segment.text, settings.vocalEvents);
            item.legacyDialogue = hasLegacyDialogue(msg.mes, segment, index ? segments[index - 1].end : 0, settings.vocalEvents);
            if (!mappedVoice(meta().mappings, segment.speaker, voices)) item.state = 'unmapped';
            else if (item.state === 'unmapped') item.state = 'idle';
            next.set(id, item); return item;
        });
        if (entries.length) insertBubbles(container, entries);
        if (diagnostics.length) {
            const note = el('div', `Breeze：${diagnostics.length} 个标签格式异常，已跳过。`, 'breeze-tray breeze-warning');
            container.querySelector('.mes_text')?.after(note);
        }
    }
    items = next;
    for (const item of items.values()) update(item, item.state, item.error, item.duration);
    refreshStudioSummary();
    if (dialog?.open) renderCharacters();
}
function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => { if (!generation) render(); }, 100);
}
async function refreshConnection() {
    const version = ++connectionVersion, api = client;
    serviceState = 'connecting'; refreshStudioSummary(); notice('正在连接…');
    try {
        const [health, response] = await Promise.all([api.request('/breeze/health'), api.request('/breeze/voices')]);
        if (version !== connectionVersion || api !== client) return;
        if (health.version !== 1 || !Array.isArray(response.voices)) throw new Error('接口版本不匹配，请更新并重启 Breeze WebUI。');
        voices = response.voices;
        supportsStreaming = health.streaming === true;
        serviceState = health.loaded ? 'ready' : 'unloaded'; refreshStudioSummary();
        refreshPrompt();
        notice(health.loaded ? `已连接 · ${voices.length} 个音色 · ${health.queued} 个等待任务` : '已连接，模型尚未加载。请在 WebUI 加载模型。');
        renderCharacters(); renderVoices(); scheduleRender();
    } catch (error) { if (version === connectionVersion) { serviceState = 'offline'; refreshStudioSummary(); notice(`连接失败：${error.message}。确认 TTS 已重启并提供 /breeze/health。`); } }
}
function selectVoice(value) {
    const select = el('select'); select.append(new Option('未映射／跳过', ''));
    for (const voice of voices) select.append(new Option(voice.name, voice.id));
    if (value && !voices.some(v => v.id === value)) select.append(new Option('原音色不可用', value));
    select.value = value || ''; return select;
}
function renderCharacters() {
    const root = dialog?.querySelector('[data-characters]'); if (!root) return;
    stopPreview();
    root.replaceChildren(); const ctx = context(), key = chatKey(ctx);
    refreshStudioSummary();
    if (!key) { root.append(el('p', '打开一个聊天，角色就会出现在这里。', 'empty-state')); return; }
    const data = meta();
    const names = discoverSpeakers(ctx, [...data.manual, ...Object.keys(data.mappings)]);
    const query = dialog.querySelector('[data-character-search]').value.trim().toLocaleLowerCase();
    const filtered = names.filter(name => name.toLocaleLowerCase().includes(query));
    if (!filtered.length) root.append(el('p', names.length ? '没有找到这个角色，试试其他名字。' : '尚未发现角色。开始对话，或在下方添加角色名。', 'empty-state'));
    for (const [index, name] of filtered.entries()) {
        const voiceId = mappedVoice(data.mappings, name, voices), voice = voices.find(v => v.id === voiceId);
        const row = el('article', null, 'breeze-row'); row.dataset.bound = String(Boolean(voice));
        const head = el('div', null, 'character-head');
        const avatar = el('span', [...name][0], 'avatar'); avatar.dataset.tone = String(index % 4); avatar.setAttribute('aria-hidden', 'true');
        const copy = el('div', null, 'character-copy'); copy.append(el('h3', name, 'character-name'), el('p', voice ? voice.name : '为这个角色选择声音', 'character-meta'));
        head.append(avatar, copy);
        const badge = el('span', voice ? '已绑定' : '待绑定', 'state-badge'); badge.dataset.bound = String(Boolean(voice));
        row.append(head, badge);
        const controls = el('div', null, 'character-controls');
        const select = selectVoice(Object.hasOwn(data.mappings, name) ? data.mappings[name] : '');
        select.setAttribute('aria-label', `${name}的音色`);
        select.addEventListener('change', () => {
            if (chatKey(context()) !== key) return renderCharacters();
            invalidate(); const current = meta(true);
            Object.defineProperty(current.mappings, name, { value: select.value || null, enumerable: true, configurable: true, writable: true });
            context().chatMetadata[KEY] = current; void saveMeta();
            refreshPrompt(); renderCharacters();
        });
        const preview = el('button', '试听', 'preview-button'); preview.type = 'button'; preview.disabled = !voice;
        preview.setAttribute('aria-label', `试听${name}的音色`); preview.setAttribute('aria-pressed', 'false');
        preview.onclick = () => { if (voice) void previewVoice(voice, preview); };
        controls.append(select, preview); row.append(controls); root.append(row);
    }
}
function renderVoices() {
    const root = dialog?.querySelector('[data-voices]'); if (!root) return;
    root.querySelectorAll('audio').forEach(audio => audio.pause());
    root.replaceChildren();
    const query = dialog.querySelector('[data-voice-search]').value.trim().toLocaleLowerCase();
    const filtered = voices.filter(voice => `${voice.name} ${voice.ref_text}`.toLocaleLowerCase().includes(query));
    for (const voice of filtered) {
        const card = el('article', null, 'breeze-voice');
        const head = el('div', null, 'voice-head'), copy = el('div');
        copy.append(el('h3', voice.name, 'voice-name'), el('p', `${Number(voice.duration || 0).toFixed(1)} 秒 · 参考音色`, 'voice-meta'));
        head.append(el('span', '♫', 'voice-icon'), copy);
        card.append(head, el('p', voice.ref_text, 'voice-transcript'));
        const audio = el('audio'); audio.controls = true; audio.preload = 'none';
        try { audio.src = client.audioUrl(voice.audio_url); } catch { continue; }
        card.append(audio); root.append(card);
    }
    if (!filtered.length) root.append(el('p', voices.length ? '没有匹配的音色。' : '你的音色库还是空的。上传一段参考音频，或前往声音设计创建第一个音色。', 'empty-state'));
}
function openPanel(tab) {
    studio.open(tab || studio.activeTab || 'characters');
    renderCharacters(); renderVoices(); refreshPrompt(); refreshStudioSummary();
}
function buildPanel() {
    studio = createStudioPanel(); dialog = studio.dialog;
    dialog.addEventListener('close', () => {
        stopPreview(); dialog.querySelectorAll('audio').forEach(a => a.pause());
        document.querySelector('#extensionsMenuButton')?.focus();
    });
    for (const button of dialog.querySelectorAll('[data-tab]')) button.addEventListener('click', () => {
        stopPreview(); dialog.querySelectorAll('audio').forEach(audio => audio.pause());
    });
    dialog.querySelector('[data-character-search]').addEventListener('input', renderCharacters);
    dialog.querySelector('[data-voice-search]').addEventListener('input', renderVoices);
    dialog.addEventListener('play', event => {
        if (event.target.tagName !== 'AUDIO') return;
        stopPlayback(); stopPreview();
        event.target.volume = Number(settings.volume);
        dialog.querySelectorAll('audio').forEach(audio => { if (audio !== event.target) audio.pause(); });
    }, true);
    for (const input of dialog.querySelectorAll('[data-setting]')) {
        const key = input.dataset.setting;
        if (input.type === 'checkbox') input.checked = settings[key]; else input.value = settings[key];
        if (key === 'baseUrl') continue;
        input.addEventListener('change', () => {
            if (!input.checkValidity()) { input.reportValidity(); input.value = settings[key]; return; }
            settings[key] = input.type === 'checkbox' ? input.checked : Number(input.value);
            if (['enabled', 'cfgScale', 'seed', 'autoPlay', 'autoGenerate', 'streaming'].includes(key)) invalidate();
            player.volume = settings.volume; if (player.audio) player.audio.volume = settings.volume;
            if (key === 'volume') {
                if (previewAudio) previewAudio.volume = Number(settings.volume);
                dialog.querySelectorAll('audio').forEach(audio => { audio.volume = Number(settings.volume); });
            }
            saveSettings();
            // Settings invalidate the old bubble callbacks; replace them before the
            // panel can close and the user immediately clicks a dialogue.
            if (generation) scheduleRender(); else { clearTimeout(renderTimer); render(); }
            refreshPrompt(); refreshStudioSummary();
        });
    }
    const templateInput = dialog.querySelector('[data-prompt-template]');
    templateInput.value = settings.promptTemplate;
    const eventsInput = dialog.querySelector('[data-vocal-events]');
    eventsInput.value = settings.vocalEvents;
    eventsInput.addEventListener('input', () => {
        settings.vocalEvents = eventsInput.value; saveSettings(); refreshPrompt(); scheduleRender();
    });
    dialog.querySelector('[data-reset-vocal-events]').onclick = () => {
        settings.vocalEvents = DEFAULT_VOCAL_EVENTS; saveSettings(); refreshPrompt(); scheduleRender();
    };
    const extraInput = dialog.querySelector('[data-extra-prompt]');
    const extraToggle = dialog.querySelector('[data-extra-prompt-enabled]');
    const extraSelect = dialog.querySelector('[data-extra-prompt-select]');
    const extraName = dialog.querySelector('[data-extra-prompt-name]');
    const extraContext = () => {
        const ctx = context(), key = chatKey(ctx);
        if (!key || extraSelect.dataset.chat !== key) { refreshPrompt(); return null; }
        return { ctx, key };
    };
    const bindExtra = (id, enabled) => {
        const current = extraContext(); if (!current) return;
        const data = meta(true);
        data.extraPromptId = id;
        if (typeof enabled === 'boolean') data.extraPromptEnabled = enabled;
        current.ctx.chatMetadata[KEY] = data; void saveMeta(); refreshPrompt();
    };
    const selectedExtra = () => {
        if (!extraContext()) return null;
        const id = meta().extraPromptId;
        if (extraInput.dataset.preset !== id) { refreshPrompt(); return null; }
        return listExtraPresets(settings).find(preset => preset.id === id) || null;
    };
    extraSelect.addEventListener('change', () => {
        if (!extraContext()) return;
        const id = extraSelect.value;
        if (id && !listExtraPresets(settings).some(preset => preset.id === id)) { refreshPrompt(); return; }
        bindExtra(id || null);
    });
    extraToggle.addEventListener('change', () => {
        if (!extraContext()) return;
        bindExtra(meta().extraPromptId || null, extraToggle.checked);
    });
    dialog.querySelector('[data-new-extra-prompt]').onclick = () => {
        if (!extraContext()) return;
        try {
            const preset = createExtraPreset(settings, { name: uniqueExtraPresetName(settings, '新语料'), text: '' });
            saveSettings(); bindExtra(preset.id, true); extraName.focus(); extraName.select();
        } catch (error) { notice(error.message); }
    };
    dialog.querySelector('[data-copy-extra-prompt]').onclick = () => {
        const source = selectedExtra(); if (!source) return;
        try {
            const preset = createExtraPreset(settings, { name: uniqueExtraPresetName(settings, `${source.name} · 副本`), text: source.text });
            saveSettings(); bindExtra(preset.id, true); extraName.focus(); extraName.select();
        } catch (error) { notice(error.message); }
    };
    dialog.querySelector('[data-delete-extra-prompt]').onclick = () => {
        const preset = selectedExtra(); if (!preset) return;
        if (!window.confirm(`删除语料「${preset.name}」？所有选用它的聊天将停止注入这份语料。`)) return;
        deleteExtraPreset(settings, preset.id); saveSettings(); bindExtra(null);
    };
    extraName.addEventListener('input', () => extraName.setCustomValidity(''));
    extraName.addEventListener('change', () => {
        const preset = selectedExtra(); if (!preset) return;
        try {
            const saved = updateExtraPreset(settings, preset.id, { name: extraName.value, text: preset.text });
            extraName.setCustomValidity(''); extraName.value = saved.name; saveSettings(); refreshPrompt();
        } catch (error) { extraName.setCustomValidity(error.message); extraName.reportValidity(); notice(error.message); }
    });
    extraInput.addEventListener('input', () => {
        const preset = selectedExtra(); if (!preset) return;
        updateExtraPreset(settings, preset.id, { name: preset.name, text: extraInput.value }); saveSettings();
        refreshPrompt();
    });
    dialog.querySelector('[data-save-prompt]').onclick = () => {
        if (!templateInput.value.trim()) {
            dialog.querySelector('[data-prompt-status]').textContent = '模板不能为空；若不需要注入，请关闭上方开关。'; return;
        }
        settings.promptTemplate = templateInput.value.trim(); saveSettings(); refreshPrompt();
    };
    dialog.querySelector('[data-reset-prompt]').onclick = () => {
        settings.promptTemplate = DEFAULT_TEMPLATE; templateInput.value = DEFAULT_TEMPLATE;
        saveSettings(); refreshPrompt();
    };
    dialog.querySelector('[data-setting="volume"]').addEventListener('input', event => {
        studioText('[data-volume-value]', `${Math.round(Number(event.target.value) * 100)}%`);
    });
    dialog.querySelector('[data-connect]').onclick = () => {
        try {
            const base = normalizeBase(dialog.querySelector('[data-setting="baseUrl"]').value);
            invalidate(); client = new BreezeClient(base); settings.baseUrl = base; voices = []; supportsStreaming = false; memory.clear(); saveSettings();
            refreshPrompt(); renderCharacters(); renderVoices();
            void refreshConnection();
        } catch (error) { notice(error.message); }
    };
    dialog.querySelector('[data-stop]').onclick = () => { invalidate(); notice('已停止播放，未完成的任务已请求取消。'); };
    dialog.querySelector('[data-add-character]').onsubmit = event => {
        event.preventDefault();
        if (!chatKey(context())) return notice('请先打开聊天。');
        const input = event.target.elements.speaker, name = input.value.trim();
        if (!name || /[:：\[\]\r\n]/.test(name) || name === context().name1) return notice('请输入有效的非用户角色名。');
        const data = meta(true); data.manual = [...new Set([...data.manual, name])];
        context().chatMetadata[KEY] = data; void saveMeta(); input.value = ''; renderCharacters(); refreshPrompt();
    };
    dialog.querySelector('[data-upload]').onsubmit = async event => {
        event.preventDefault(); const form = event.target, button = form.querySelector('button'), api = client;
        const data = new FormData(form), file = data.get('audio');
        if (file.size > 20 * 1024 * 1024) return notice('参考音频不得超过 20 MB。');
        button.disabled = true; notice('正在保存音色…');
        try { await api.request('/breeze/voices', { method: 'POST', body: data }); form.reset(); await refreshConnection(); }
        catch (error) { notice(error.message); } finally { button.disabled = false; }
    };
    const designForm = dialog.querySelector('[data-design]');
    const directionFields = designForm.querySelector('[data-direction-fields]');
    const referencePreview = designForm.querySelector('[data-direction-preview]');
    let referencePreviewUrl;
    designForm.elements.mode.onchange = () => {
        const direction = designForm.elements.mode.value === 'direction';
        directionFields.hidden = !direction;
        for (const input of directionFields.querySelectorAll('input, textarea')) {
            input.disabled = !direction;
            input.required = direction;
        }
        designForm.elements.instruction.required = !direction;
        designForm.querySelector('[data-description-help]').textContent = direction
            ? '可留空以保留参考声音；也可补充语气、语速或情绪方向。'
            : '描述年龄感、音色和说话方式。';
        referencePreview.pause();
    };
    designForm.elements.audio.onchange = () => {
        referencePreview.pause();
        referencePreview.removeAttribute('src');
        if (referencePreviewUrl) URL.revokeObjectURL(referencePreviewUrl);
        const file = designForm.elements.audio.files[0];
        referencePreview.hidden = !file;
        referencePreviewUrl = file ? URL.createObjectURL(file) : null;
        if (referencePreviewUrl) referencePreview.src = referencePreviewUrl;
    };
    dialog.querySelector('[data-cancel-design]').onclick = () => designController?.abort();
    dialog.querySelector('[data-design]').onsubmit = async event => {
        event.preventDefault(); const form = event.target;
        if (designController) return notice('请等待当前候选任务结束，或先取消。');
        const direction = form.elements.mode.value === 'direction';
        const instruction = form.elements.instruction.value.trim(), text = form.elements.text.value.trim();
        const referenceText = form.elements.ref_text.value.trim(), referenceAudio = form.elements.audio.files[0];
        if (!text || (!direction && !instruction)) return notice('请填写试听文本和声音描述。');
        if (direction && (!referenceText || !referenceAudio?.size)) return notice('请选择参考音频并填写音频对应的准确文字。');
        if (direction && referenceAudio.size > 20 * 1024 * 1024) return notice('参考音频不得超过 20 MB。');
        const api = client, controller = new AbortController(); designController = controller;
        const button = form.querySelector('button'); button.disabled = true;
        const count = Number(form.elements.count.value), cfg = Number(settings.cfgScale), seed = Number(settings.seed);
        const root = dialog.querySelector('[data-candidates]');
        root.querySelectorAll('audio').forEach(audio => audio.pause()); root.replaceChildren();
        let currentStatus;
        try {
            for (let i = 0; i < count; i++) {
                const card = el('div', null, 'breeze-voice'), label = el('strong', `候选 ${i + 1} · seed ${(seed + i) % 4294967296}`), status = el('p', '排队');
                currentStatus = status;
                card.append(label, status); root.append(card);
                const parameters = { text, instruction, cfg_scale: cfg, seed: (seed + i) % 4294967296 };
                let body = { kind: 'design', ...parameters };
                if (direction) {
                    body = new FormData();
                    for (const [key, value] of Object.entries(parameters)) body.set(key, String(value));
                    body.set('audio', referenceAudio);
                    body.set('ref_text', referenceText);
                }
                const job = await api.runJob(body,
                    { direction, signal: controller.signal, status: value => { status.textContent = value === 'running' ? '生成中' : value; } });
                checkAbort(controller.signal);
                status.textContent = '生成完成，请试听确认文字。';
                const audio = el('audio'); audio.controls = true; audio.preload = 'none'; audio.src = api.audioUrl(job.audio_url);
                const name = el('input'); name.placeholder = '保存的音色名称'; name.maxLength = 100; name.setAttribute('aria-label', `候选 ${i + 1} 的音色名称`);
                const save = el('button', '保存此音色'); save.type = 'button';
                save.onclick = async () => {
                    if (!name.value.trim()) return notice('请先填写音色名称。');
                    save.disabled = true;
                    try { await api.request('/breeze/voices/from-job', { method: 'POST', body: { job_id: job.id, name: name.value.trim() } }); save.textContent = '已保存'; await refreshConnection(); }
                    catch (error) { notice(error.message); save.disabled = false; }
                };
                card.append(audio, name, save);
                currentStatus = null;
            }
        } catch (error) {
            const message = error.name === 'AbortError' ? '候选生成已取消，已完成候选仍可试听保存。' : error.message;
            if (currentStatus) currentStatus.textContent = message;
            notice(message);
        }
        finally { designController = null; button.disabled = false; }
    };
}

async function automatic(ids) {
    if (!settings.enabled || (!settings.autoGenerate && !settings.autoPlay)) return;
    render(); const selected = [];
    for (const item of items.values()) {
        if (!ids.has(item.messageId) || consumed.has(item.id)) continue;
        consumed.add(item.id);
        if (mappedVoice(meta().mappings, item.segment.speaker, voices)) selected.push(item);
    }
    if (consumed.size > 2000) consumed = new Set([...consumed].slice(-1000));
    if (!selected.length) return;
    player.volume = Number(settings.volume);
    try { await player.run(selected, { play: settings.autoPlay, stream: settings.streaming }); }
    catch (error) { if (error.name !== 'AbortError') notice(error.message); }
}
function scheduleAutomatic() {
    clearTimeout(automaticTimer);
    const expectedEpoch = epoch;
    automaticTimer = setTimeout(() => {
        if (epoch !== expectedEpoch || generation || !allowAutomatic) return;
        // ST streaming can emit GENERATION_ENDED before MESSAGE_RECEIVED.
        const pending = new Set(autoPending); autoPending.clear();
        scheduleRender(); void automatic(pending);
    }, 120);
}
function init() {
    const ctx = context();
    settings = { ...DEFAULTS, ...PROMPT_DEFAULTS, ...ctx.extensionSettings[KEY] };
    settings.promptTemplate = typeof settings.tagRenderPromptTemplate === 'string' ? settings.tagRenderPromptTemplate : DEFAULT_TEMPLATE;
    // The stable template is retained verbatim; only this branch's field is initialized.
    if (typeof settings.tagRenderPromptTemplate !== 'string') saveSettings();
    if (typeof settings.vocalEvents !== 'string') settings.vocalEvents = DEFAULT_VOCAL_EVENTS;
    try { client = new BreezeClient(settings.baseUrl); } catch { settings.baseUrl = DEFAULTS.baseUrl; client = new BreezeClient(settings.baseUrl); }
    buildPanel();
    mountStudioEntry(openPanel);
    const on = (name, fn) => { if (ctx.eventTypes[name]) ctx.eventSource.on(ctx.eventTypes[name], fn); };
    on('GENERATION_STARTED', (_type, _options, dryRun) => {
        injectionType = _type; refreshPrompt();
        if (!dryRun) { invalidate(); generation = true; allowAutomatic = true; }
    });
    // After slash commands, before ST collects extension prompts; includes dry-run previews.
    on('GENERATION_AFTER_COMMANDS', type => { injectionType = type; refreshPrompt(); });
    on('MESSAGE_RECEIVED', (id, type) => {
        if (type === 'first_message' || !allowAutomatic) return;
        autoPending.add(Number(id));
        if (!generation) scheduleAutomatic();
    });
    on('GENERATION_ENDED', () => {
        injectionType = null; refreshPrompt();
        generation = false; scheduleRender(); scheduleAutomatic();
    });
    on('GENERATION_STOPPED', () => { generation = false; invalidate(); injectionType = null; refreshPrompt(); });
    for (const name of ['CHAT_CHANGED', 'CHAT_LOADED', 'MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED', 'MESSAGE_SWIPE_DELETED', 'PERSONA_CHANGED']) {
        on(name, () => { generation = false; invalidate(); renderCharacters(); injectionType = null; refreshPrompt(); });
    }
    for (const name of ['CHARACTER_MESSAGE_RENDERED', 'MORE_MESSAGES_LOADED', 'GROUP_UPDATED']) {
        on(name, () => { scheduleRender(); refreshPrompt(); });
    }
    for (const name of ['PRESET_CHANGED', 'OAI_PRESET_CHANGED_AFTER']) on(name, refreshPrompt);
    // Only observe host message nodes, never our own bubbles. ST rerenders may occur after events.
    const chat = document.querySelector('#chat');
    if (chat) new MutationObserver(changes => {
        if (changes.some(c => [...c.addedNodes].some(n => n.nodeType === 1 && (n.matches?.('.mes,.mes_text') || n.querySelector?.('.mes_text'))))) scheduleRender();
    }).observe(chat, { childList: true, subtree: true });
    scheduleRender(); refreshPrompt(); void refreshConnection();
}
let attempts = 0;
function boot() {
    if (window.SillyTavern?.getContext && document.querySelector('#send_form')) init();
    else if (++attempts < 60) setTimeout(boot, 500);
    else console.error('[Breeze] SillyTavern context unavailable; reload after startup.');
}
boot();
