const instances = new WeakMap();
const isMessageId = value => Number.isInteger(value) && value >= 0;
const clampPercent = value => Math.min(100, Math.max(0, Number(value) || 0));
const parseTime = label => /^\d+(?::\d{2}){1,2}$/.test(label || '')
    ? label.split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0) : null;
const formatTime = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const setText = (node, value) => {
    const text = String(value ?? '');
    if (node.textContent !== text) node.textContent = text;
};

/** An isolated view; the caller owns message selection, playback and saved preferences. */
export function createFloatingControls({ onPlay, onPause, onStop, onRefresh, onSelect, onCollapse, onSeek, collapsed = false } = {}) {
    const existing = instances.get(document);
    if (existing) {
        if (!existing.host.isConnected) document.body.append(existing.host);
        return existing;
    }
    const ownerDocument = document;
    const host = document.createElement('div');
    host.id = 'breeze-floating-controls';
    host.hidden = true;
    const root = host.attachShadow({ mode: 'open' });
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = new URL('./floating-controls.css', import.meta.url).href;
    const shell = document.createElement('div');
    shell.className = 'breeze-floating-shell';
    // This shell is static. Message labels and feedback are always assigned as text.
    shell.innerHTML = `
      <section id="breeze-floating-panel" class="breeze-floating-panel" aria-label="Breeze 浮动语音控制">
        <header class="breeze-floating-header">
          <div class="breeze-floating-brand"><span class="breeze-floating-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><div><strong>Breeze</strong><span class="breeze-floating-caption">语音播放</span></div></div>
          <button class="breeze-floating-toggle" type="button" data-collapse aria-label="收起语音面板" aria-expanded="true" aria-controls="breeze-floating-panel" title="收起语音面板"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 8 5 5 5-5"/></svg></button>
        </header>
        <div class="breeze-floating-content">
          <label class="breeze-floating-select-label" for="breeze-floating-message">朗读的回复</label>
          <select id="breeze-floating-message" aria-label="朗读的回复"><option value="">跟随最新回复</option></select>
          <div class="breeze-floating-detail"><span class="breeze-floating-target" data-target-label></span><span class="breeze-floating-status" data-status role="status" aria-live="polite"></span></div>
          <div class="breeze-floating-timeline">
            <div class="breeze-floating-times"><span data-seek-current>0:00</span><span data-seek-total>待准备</span></div>
            <input type="range" min="0" max="100" step="0.1" value="0" data-seek aria-label="本条语音播放进度" aria-describedby="breeze-floating-seek-hint" disabled>
            <span id="breeze-floating-seek-hint" data-seek-hint></span>
          </div>
          <div class="breeze-message-controls" role="group" aria-label="本条语音播放控制" data-message-id="" data-state="idle">
            <button type="button" class="breeze-control breeze-message-play" title="按正文顺序从头播放对白与已启用的旁白" disabled>▶ 播放本条</button>
            <button type="button" class="breeze-control breeze-message-pause" aria-pressed="false" title="暂停本条语音队列" disabled>⏸ 暂停</button>
            <button type="button" class="breeze-control breeze-message-stop" title="结束播放并清空当前语音队列" disabled>■ 停止</button>
            <button type="button" class="breeze-control breeze-message-refresh" title="清除本条语音缓存并重新合成对白与旁白，完成后点击播放" disabled>↻ 重新获取</button>
            <span class="breeze-message-feedback" role="status" aria-live="polite"></span>
          </div>
        </div>
      </section>
      <button class="breeze-floating-compact" type="button" data-expand aria-label="展开语音面板" aria-expanded="false" aria-controls="breeze-floating-panel" title="展开语音面板" hidden><span class="breeze-floating-dot" aria-hidden="true"></span><strong>Breeze</strong><span data-compact-status>待播放</span><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 12 5-5 5 5"/></svg></button>`;
    root.append(stylesheet, shell);
    const panel = root.querySelector('.breeze-floating-panel');
    const collapseButton = root.querySelector('[data-collapse]');
    const expandButton = root.querySelector('[data-expand]');
    const select = root.querySelector('select');
    const controls = root.querySelector('.breeze-message-controls');
    const play = root.querySelector('.breeze-message-play');
    const pause = root.querySelector('.breeze-message-pause');
    const stop = root.querySelector('.breeze-message-stop');
    const refresh = root.querySelector('.breeze-message-refresh');
    const status = root.querySelector('[data-status]');
    const compactStatus = root.querySelector('[data-compact-status]');
    const label = root.querySelector('[data-target-label]');
    const feedback = root.querySelector('.breeze-message-feedback');
    const seek = root.querySelector('[data-seek]');
    const seekCurrent = root.querySelector('[data-seek-current]');
    const seekTotal = root.querySelector('[data-seek-total]');
    const seekHint = root.querySelector('[data-seek-hint]');
    const listeners = [];
    let destroyed = false;
    let optionKey = '';
    let isCollapsed = Boolean(collapsed);
    let seeking = false;
    let seekGesture = null;
    let current = {
        visible: false, messages: [], selectedMessageId: null, messageId: null,
        label: '', status: '', paused: false, active: false, refreshing: false,
        refreshLabel: '', feedback: '', canPlay: false, canRefresh: false,
        canPause: false, canStop: false, selectionLocked: false,
        timeline: { enabled: false, percent: 0, currentLabel: '0:00', totalLabel: '待准备', hint: '' },
    };
    const listen = (node, event, listener) => {
        node.addEventListener(event, listener);
        listeners.push([node, event, listener]);
    };
    const renderCollapsed = () => {
        panel.hidden = isCollapsed;
        expandButton.hidden = !isCollapsed;
        host.dataset.collapsed = String(isCollapsed);
    };
    const changeCollapsed = value => {
        isCollapsed = value;
        renderCollapsed();
        (isCollapsed ? expandButton : collapseButton).focus({ preventScroll: true });
        onCollapse?.(isCollapsed);
    };
    listen(collapseButton, 'click', () => changeCollapsed(true));
    listen(expandButton, 'click', () => changeCollapsed(false));
    listen(select, 'change', () => {
        if (select.disabled) return;
        current.selectedMessageId = select.value === '' ? null : Number(select.value);
        onSelect?.(current.selectedMessageId);
    });
    const renderSeek = () => {
        const timeline = current.timeline || {};
        seek.value = String(clampPercent(timeline.percent));
        setText(seekCurrent, timeline.currentLabel || '0:00');
        seek.setAttribute('aria-valuetext', `${seekCurrent.textContent} / ${timeline.totalLabel || '待准备'}`);
        seek.style.setProperty('--seek-percent', `${seek.value}%`);
    };
    const beginSeek = () => {
        if (seek.disabled || !isMessageId(current.messageId)) return false;
        seekGesture ??= { messageId: current.messageId, cancelled: false };
        if (seekGesture.cancelled || seekGesture.messageId !== current.messageId) {
            renderSeek();
            return false;
        }
        seeking = true;
        return true;
    };
    listen(seek, 'pointerdown', beginSeek);
    listen(seek, 'input', () => {
        if (!beginSeek()) return;
        const totalSeconds = parseTime(current.timeline?.totalLabel);
        const percent = clampPercent(seek.value);
        setText(seekCurrent, totalSeconds == null ? `${Math.round(percent)}%` : formatTime(totalSeconds * percent / 100));
        seek.setAttribute('aria-valuetext', `${seekCurrent.textContent} / ${current.timeline?.totalLabel || '待准备'}`);
        seek.style.setProperty('--seek-percent', `${percent}%`);
    });
    listen(seek, 'change', () => {
        const gesture = seekGesture;
        seeking = false;
        seekGesture = null;
        if (!seek.disabled && gesture && !gesture.cancelled && gesture.messageId === current.messageId) {
            onSeek?.(clampPercent(seek.value), gesture.messageId);
        } else renderSeek();
    });
    const cancelSeek = () => { seeking = false; seekGesture = null; renderSeek(); };
    listen(seek, 'blur', cancelSeek);
    listen(seek, 'pointercancel', cancelSeek);
    for (const [button, callback] of [[play, onPlay], [pause, onPause], [stop, onStop], [refresh, onRefresh]]) {
        listen(button, 'click', () => {
            if (!button.disabled && isMessageId(current.messageId)) callback?.(current.messageId);
        });
    }
    const api = {
        host,
        update(state) {
            if (destroyed) return;
            const previousMessageId = current.messageId;
            current = { ...current, ...state };
            host.hidden = !current.visible;
            const choices = current.messages.filter(message => isMessageId(message.id));
            const nextOptionKey = JSON.stringify(choices.map(message => [message.id, String(message.label ?? '')]));
            if (optionKey !== nextOptionKey) {
                const latest = document.createElement('option');
                latest.value = ''; latest.textContent = '跟随最新回复';
                const options = choices.map(message => {
                    const option = document.createElement('option');
                    option.value = String(message.id); option.textContent = String(message.label ?? '');
                    return option;
                });
                select.replaceChildren(latest, ...options);
                optionKey = nextOptionKey;
            }
            const selectedValue = isMessageId(current.selectedMessageId) ? String(current.selectedMessageId) : '';
            if (select.value !== selectedValue) select.value = selectedValue;
            select.disabled = Boolean(current.selectionLocked);
            const hasTarget = isMessageId(current.messageId);
            const timeline = current.timeline || {};
            seek.disabled = !hasTarget || !timeline.enabled;
            if (seek.disabled || previousMessageId !== current.messageId || !current.visible) {
                seeking = false;
                // Preserve a cancelled gesture until its commit; later input belongs to that same drag.
                if (seekGesture) seekGesture.cancelled = true;
            }
            setText(seekTotal, timeline.totalLabel || '待准备');
            setText(seekHint, timeline.hint);
            if (!seeking) renderSeek();
            controls.dataset.messageId = hasTarget ? String(current.messageId) : '';
            const playbackState = current.refreshing ? 'refreshing' : current.paused ? 'paused' : current.active ? 'playing' : 'idle';
            controls.dataset.state = playbackState;
            host.dataset.state = playbackState;
            play.disabled = !hasTarget || !current.canPlay;
            pause.disabled = !hasTarget || !current.canPause;
            stop.disabled = !hasTarget || !current.canStop;
            refresh.disabled = !hasTarget || !current.canRefresh;
            pause.setAttribute('aria-pressed', String(Boolean(current.paused)));
            setText(pause, current.paused ? '▶ 继续' : '⏸ 暂停');
            pause.title = current.paused ? '从暂停处继续播放' : '暂停本条语音队列';
            refresh.setAttribute('aria-busy', String(Boolean(current.refreshing)));
            setText(refresh, current.refreshLabel || (current.refreshing ? '↻ 重新获取中' : '↻ 重新获取'));
            const statusText = current.status || (current.refreshing ? '重新获取中' : current.paused ? '已暂停' : current.active ? '播放中' : hasTarget ? '待播放' : '暂无可朗读回复');
            setText(status, statusText);
            setText(compactStatus, statusText);
            compactStatus.title = String(statusText);
            setText(label, current.label);
            label.title = String(current.label ?? '');
            setText(feedback, current.feedback);
        },
        destroy() {
            if (destroyed) return;
            destroyed = true;
            for (const [node, event, listener] of listeners) node.removeEventListener(event, listener);
            host.remove();
            instances.delete(ownerDocument);
        },
    };
    renderCollapsed();
    api.update({});
    document.body.append(host);
    instances.set(ownerDocument, api);
    return api;
}
