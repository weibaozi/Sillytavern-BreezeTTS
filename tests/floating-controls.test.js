import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createFloatingControls } from '../floating-controls.js';

function setup(t, callbacks = {}) {
    const dom = new JSDOM('<body></body>');
    const previousDocument = globalThis.document;
    globalThis.document = dom.window.document;
    const controls = createFloatingControls(callbacks);
    const root = controls.host.shadowRoot;
    t.after(() => {
        controls.destroy();
        dom.window.close();
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
    });
    return { dom, controls, root };
}

const ready = {
    visible: true, messages: [{ id: 0, label: '第 1 条回复' }, { id: 2, label: '第 3 条回复' }],
    selectedMessageId: null, messageId: 2, label: '最新回复', status: '待播放',
    canPlay: true, canPause: true, canStop: true, canRefresh: true,
};

test('floating controls remain a singleton and collapse without triggering playback', t => {
    const changes = [], played = [];
    const { controls, root } = setup(t, { onCollapse: value => changes.push(value), onPlay: id => played.push(id) });
    controls.update(ready);
    assert.equal(createFloatingControls(), controls);
    assert.equal(document.querySelectorAll('#breeze-floating-controls').length, 1);
    assert.equal(root.querySelectorAll('.breeze-message-controls button').length, 4);
    const panel = root.querySelector('[aria-label="Breeze 浮动语音控制"]');
    const collapse = root.querySelector('[aria-label="收起语音面板"]');
    const expand = root.querySelector('[aria-label="展开语音面板"]');
    assert.equal(panel.hidden, false);
    assert.equal(expand.hidden, true);
    assert.equal(collapse.getAttribute('aria-expanded'), 'true');
    collapse.click();
    assert.equal(panel.hidden, true);
    assert.equal(expand.hidden, false);
    assert.equal(root.activeElement, expand);
    assert.equal(expand.getAttribute('aria-expanded'), 'false');
    assert.match(expand.textContent, /Breeze.*待播放/);
    controls.update({ status: '播放中', active: true, visible: false });
    assert.equal(controls.host.hidden, true);
    controls.update({ visible: true });
    assert.equal(panel.hidden, true, 'visibility and playback updates retain the collapse preference');
    assert.match(expand.textContent, /播放中/);
    expand.click();
    assert.equal(panel.hidden, false);
    assert.equal(root.activeElement, collapse);
    assert.deepEqual(changes, [true, false]);
    assert.deepEqual(played, []);
});

test('floating controls route callbacks to the current target and keep selection stable', t => {
    const calls = [];
    const { controls, root, dom } = setup(t, {
        onPlay: id => calls.push(['play', id]), onPause: id => calls.push(['pause', id]),
        onStop: id => calls.push(['stop', id]), onRefresh: id => calls.push(['refresh', id]),
        onSelect: id => calls.push(['select', id]),
    });
    controls.update(ready);
    for (const action of ['play', 'pause', 'stop', 'refresh']) root.querySelector(`.breeze-message-${action}`).click();
    assert.deepEqual(calls, [['play', 2], ['pause', 2], ['stop', 2], ['refresh', 2]]);
    const select = root.querySelector('[aria-label="朗读的回复"]');
    select.focus();
    const firstOption = select.options[1];
    select.value = '0'; select.dispatchEvent(new dom.window.Event('change'));
    assert.deepEqual(calls.at(-1), ['select', 0]);
    controls.update({ selectedMessageId: 0, messageId: 0, paused: true, status: '已暂停' });
    assert.equal(select.value, '0');
    assert.equal(select.options[1], firstOption, 'status changes do not rebuild options');
    assert.equal(root.activeElement, select);
    assert.equal(root.querySelector('.breeze-message-controls').dataset.messageId, '0');
    root.querySelector('.breeze-message-play').click();
    assert.deepEqual(calls.at(-1), ['play', 0]);
    assert.equal(root.querySelector('.breeze-message-pause').getAttribute('aria-pressed'), 'true');
    assert.match(root.querySelector('.breeze-message-pause').textContent, /继续/);
    select.value = ''; select.dispatchEvent(new dom.window.Event('change'));
    assert.deepEqual(calls.at(-1), ['select', null]);
    controls.update({ selectionLocked: true, canPlay: false, canPause: false, canStop: false, canRefresh: false });
    assert.equal(select.disabled, true);
    const count = calls.length;
    for (const button of root.querySelectorAll('.breeze-message-controls button')) button.click();
    assert.equal(calls.length, count);
});

test('floating controls render hostile labels as text and disable all actions with no target', t => {
    const hostile = '<img src=x onerror="alert(1)"><script>bad()</script>';
    const { controls, root } = setup(t, { collapsed: true });
    controls.update({ ...ready, messages: [{ id: 2, label: hostile }], label: hostile, status: hostile, feedback: hostile, refreshLabel: hostile });
    assert.equal(root.querySelectorAll('img, script').length, 0);
    assert.equal(root.querySelector('select').options[1].textContent, hostile);
    assert.equal(root.querySelector('[data-target-label]').textContent, hostile);
    assert.equal(root.querySelector('.breeze-message-feedback').textContent, hostile);
    assert.equal(root.querySelector('.breeze-message-refresh').textContent, hostile);
    assert.equal(root.querySelector('.breeze-floating-panel').hidden, true);
    controls.update({ messageId: null });
    assert.equal(root.querySelector('.breeze-message-controls').dataset.messageId, '');
    for (const button of root.querySelectorAll('.breeze-message-controls button')) assert.equal(button.disabled, true);
    controls.destroy();
    assert.equal(document.querySelector('#breeze-floating-controls'), null);
    controls.update(ready);
    assert.equal(document.querySelector('#breeze-floating-controls'), null, 'updates cannot resurrect a destroyed panel');
});

test('master switches stay synchronized and remain usable without a reply in either layout', t => {
    const toggles = [], collapses = [];
    const { controls, root } = setup(t, {
        onToggleEnabled: enabled => { toggles.push(enabled); controls.update({ enabled }); },
        onCollapse: collapsed => collapses.push(collapsed),
    });
    controls.update({ visible: true });
    const [headerSwitch, compactSwitch] = root.querySelectorAll('[data-master-toggle]');
    const panel = root.querySelector('.breeze-floating-panel');
    const compactGroup = root.querySelector('.breeze-floating-compact-group');
    const expand = root.querySelector('[data-expand]');
    assert.equal(root.querySelectorAll('[data-master-toggle]').length, 2);
    assert.equal(compactGroup.hidden, true);
    for (const toggle of [headerSwitch, compactSwitch]) {
        assert.equal(toggle.getAttribute('role'), 'switch');
        assert.equal(toggle.getAttribute('aria-label'), 'Breeze 总开关');
        assert.equal(toggle.getAttribute('aria-checked'), 'true', 'Breeze defaults to enabled');
        assert.equal(toggle.disabled, false);
        assert.equal(toggle.parentElement.closest('button'), null, 'switches are never nested in another button');
    }
    headerSwitch.click();
    assert.deepEqual(toggles, [false], 'master switch works before any reply exists');
    assert.equal(controls.host.hidden, false);
    assert.equal(panel.hidden, false);
    for (const toggle of [headerSwitch, compactSwitch]) assert.equal(toggle.getAttribute('aria-checked'), 'false');
    assert.equal(root.querySelector('[data-status]').textContent, '已关闭');
    assert.equal(root.querySelector('[data-compact-status]').textContent, '已关闭');
    root.querySelector('[data-collapse]').click();
    assert.equal(panel.hidden, true);
    assert.equal(compactGroup.hidden, false);
    assert.equal(compactSwitch.parentElement, expand.parentElement, 'compact master switch is next to the expand action');
    compactSwitch.click();
    assert.deepEqual(toggles, [false, true]);
    assert.equal(panel.hidden, true, 'toggling from the compact view preserves collapse');
    assert.equal(expand.hidden, false);
    assert.deepEqual(collapses, [true], 'the master switch does not trigger expand');
    for (const toggle of [headerSwitch, compactSwitch]) assert.equal(toggle.getAttribute('aria-checked'), 'true');
    assert.equal(root.querySelector('[data-compact-status]').textContent, '暂无可朗读回复');
    for (const button of root.querySelectorAll('.breeze-message-controls button')) assert.equal(button.disabled, true);
});

test('disabled master switch blocks reply actions and cancels in-flight seeking', t => {
    const calls = [];
    const { controls, root, dom } = setup(t, {
        onPlay: id => calls.push(['play', id]), onPause: id => calls.push(['pause', id]),
        onStop: id => calls.push(['stop', id]), onRefresh: id => calls.push(['refresh', id]),
        onSelect: id => calls.push(['select', id]), onSeek: (percent, id) => calls.push(['seek', percent, id]),
    });
    controls.update({ ...ready, timeline: { enabled: true, percent: 10, currentLabel: '0:12', totalLabel: '2:00' } });
    const seek = root.querySelector('[data-seek]');
    const select = root.querySelector('select');
    seek.value = '65'; seek.dispatchEvent(new dom.window.Event('input'));
    controls.update({ enabled: false, active: true, status: '播放中' });
    assert.equal(controls.host.hidden, false);
    assert.equal(controls.host.dataset.state, 'disabled');
    assert.equal(root.querySelector('.breeze-message-controls').dataset.state, 'disabled');
    assert.equal(root.querySelector('[data-status]').textContent, '已关闭');
    assert.equal(root.querySelector('[data-compact-status]').textContent, '已关闭');
    assert.equal(select.disabled, true);
    assert.equal(seek.disabled, true);
    assert.equal(seek.value, '10', 'disabling restores the authoritative seek position');
    for (const button of root.querySelectorAll('.breeze-message-controls button')) {
        assert.equal(button.disabled, true);
        button.click();
    }
    select.value = '0'; select.dispatchEvent(new dom.window.Event('change'));
    seek.value = '80'; seek.dispatchEvent(new dom.window.Event('input'));
    assert.deepEqual(calls, []);
    controls.update({ enabled: true });
    seek.dispatchEvent(new dom.window.Event('change'));
    assert.deepEqual(calls, [], 're-enabling cannot commit the drag started before shutdown');
    assert.equal(select.disabled, false);
    assert.equal(select.value, '', 'disabled selection changes do not alter the selected reply');
    assert.equal(seek.disabled, false);
    for (const button of root.querySelectorAll('.breeze-message-controls button')) assert.equal(button.disabled, false);
    root.querySelector('.breeze-message-play').click();
    assert.deepEqual(calls, [['play', 2]], 're-enabling restores permitted actions for the same reply');
});

test('seekbar previews position without losing a drag to playback updates and commits the current target', t => {
    const calls = [];
    const { controls, root, dom } = setup(t, { onSeek: (percent, id) => calls.push([percent, id]) });
    const timeline = { enabled: true, percent: 10, currentLabel: '0:12', totalLabel: '2:00', hint: '拖动以跳转' };
    controls.update({ ...ready, timeline });
    const seek = root.querySelector('[aria-label="本条语音播放进度"]');
    assert.equal(seek.disabled, false);
    assert.equal(seek.value, '10');
    seek.focus();
    seek.value = '75'; seek.dispatchEvent(new dom.window.Event('input'));
    assert.equal(root.querySelector('[data-seek-current]').textContent, '1:30');
    controls.update({ timeline: { ...timeline, percent: 20, currentLabel: '0:24' } });
    assert.equal(seek.value, '75', 'playback updates do not move a thumb being dragged');
    assert.equal(root.activeElement, seek);
    assert.deepEqual(calls, [], 'previewing never starts playback');
    seek.dispatchEvent(new dom.window.Event('change'));
    assert.deepEqual(calls, [[75, 2]]);
    controls.update({ timeline: { ...timeline, totalLabel: '待准备' } });
    seek.value = '40'; seek.dispatchEvent(new dom.window.Event('input'));
    assert.equal(root.querySelector('[data-seek-current]').textContent, '40%');
    controls.update({ messageId: 0, timeline: { ...timeline, enabled: false, hint: '等待正文生成完成' } });
    assert.equal(seek.disabled, true);
    assert.equal(seek.value, '10', 'target changes cancel a stale drag');
    seek.dispatchEvent(new dom.window.Event('change'));
    assert.deepEqual(calls, [[75, 2]]);
    assert.equal(root.querySelector('[data-seek-hint]').textContent, '等待正文生成完成');
});

test('seekbar discards an old gesture when another enabled reply becomes the target', t => {
    const calls = [];
    const { controls, root, dom } = setup(t, { onSeek: (percent, id) => calls.push([percent, id]) });
    const timeline = { enabled: true, percent: 0, currentLabel: '0:00', totalLabel: '2:00', hint: '' };
    const seek = root.querySelector('[data-seek]');
    const emit = event => seek.dispatchEvent(new dom.window.Event(event));
    controls.update({ ...ready, messageId: 0, timeline });
    seek.value = '65'; emit('input');
    controls.update({ messageId: 1, timeline: { ...timeline, percent: 10, currentLabel: '0:12' } });
    assert.equal(seek.disabled, false);
    emit('change');
    assert.deepEqual(calls, [], 'committing an old drag cannot start the newly selected reply');
    assert.equal(seek.value, '10');

    emit('pointerdown');
    controls.update({ messageId: 0, timeline });
    seek.value = '70'; emit('input');
    controls.update({ messageId: 1, timeline });
    seek.value = '80'; emit('input'); emit('change');
    assert.deepEqual(calls, [], 'repeated input and returning to the original reply cannot revive a cancelled drag');
    assert.equal(seek.value, '0');

    seek.value = '35'; emit('input'); emit('change');
    assert.deepEqual(calls, [[35, 1]], 'a fresh gesture after the cancelled commit can seek the new reply');
    for (const cancellation of ['blur', 'pointercancel']) {
        emit('pointerdown');
        controls.update({ messageId: 0, timeline });
        emit(cancellation);
        seek.value = '20'; emit('input'); emit('change');
        assert.deepEqual(calls.at(-1), [20, 0], `${cancellation} releases the old gesture`);
        controls.update({ messageId: 1, timeline });
    }
});
