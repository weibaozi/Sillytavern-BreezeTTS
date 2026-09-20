import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { attachFloatingPosition } from '../floating-position.js';

function setup(t, position) {
    const dom = new JSDOM('<body><div id="host"><header>Drag <button>Switch</button><input type="range"></header><button id="compact">Breeze</button></div></body>');
    const view = dom.window, doc = view.document;
    const host = doc.querySelector('#host'), header = doc.querySelector('header'), compact = doc.querySelector('#compact');
    let width = 240, height = 160;
    Object.defineProperties(view, { innerWidth: { value: 1000, writable: true }, innerHeight: { value: 800, writable: true } });
    host.getBoundingClientRect = () => {
        const right = view.innerWidth - (parseFloat(host.style.right) || 20);
        const bottom = view.innerHeight - (parseFloat(host.style.bottom) || 96);
        return { width, height, right, bottom, left: right - width, top: bottom - height };
    };
    const saved = [], captures = [];
    for (const handle of [header, compact]) {
        handle.setPointerCapture = id => captures.push(['set', id]);
        handle.releasePointerCapture = id => captures.push(['release', id]);
    }
    const helper = attachFloatingPosition({ host, handles: [header, compact], position, onPositionChange: value => saved.push(value) });
    const pointer = (node, name, x, y, extra = {}) => {
        const event = new view.MouseEvent(name, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: extra.button ?? 0 });
        Object.defineProperties(event, {
            pointerId: { value: extra.pointerId ?? 1 },
            isPrimary: { value: extra.isPrimary ?? true },
        });
        node.dispatchEvent(event);
        return event;
    };
    t.after(() => { helper.destroy(); dom.window.close(); });
    return { view, doc, host, header, compact, helper, saved, captures, pointer, resize: (w, h) => { width = w; height = h; helper.refresh(); } };
}

test('restored position stays inside the viewport after expansion and resize without writing preferences', t => {
    const { host, view, helper, resize, saved } = setup(t, { right: 900, bottom: -10 });
    assert.equal(host.style.right, '752px');
    assert.equal(host.style.bottom, '8px');
    resize(400, 300);
    assert.equal(host.style.right, '592px', 'expanded panel remains in the viewport');
    view.innerWidth = 430;
    view.innerHeight = 320;
    view.dispatchEvent(new view.Event('resize'));
    assert.equal(host.style.right, '22px');
    assert.equal(host.style.bottom, '8px');
    host.hidden = true;
    view.innerWidth = 410;
    helper.refresh();
    assert.equal(host.style.right, '22px', 'hidden geometry does not change the preference');
    host.hidden = false;
    helper.refresh();
    assert.equal(host.style.right, '8px');
    assert.deepEqual(saved, []);
});

test('small pointer movement remains a click; a completed compact drag persists once and consumes its click', t => {
    const { host, compact, doc, helper, pointer, saved, view, captures } = setup(t);
    assert.equal(host.style.right, '', 'no saved position leaves default CSS in control');
    pointer(compact, 'pointerdown', 900, 700);
    pointer(doc, 'pointermove', 902, 702);
    pointer(doc, 'pointerup', 902, 702);
    assert.equal(host.style.right, '');
    assert.deepEqual(saved, []);
    assert.equal(helper.consumeClick(new view.MouseEvent('click', { detail: 1 })), false);
    pointer(compact, 'pointerdown', 900, 700);
    const moved = pointer(doc, 'pointermove', 780, 550);
    assert.equal(moved.defaultPrevented, true);
    assert.equal(host.dataset.dragging, 'true');
    assert.equal(host.style.right, '140px');
    assert.equal(host.style.bottom, '246px');
    assert.deepEqual(saved, [], 'no settings writes during a drag');
    pointer(doc, 'pointerup', 780, 550);
    assert.equal(host.dataset.dragging, undefined);
    assert.deepEqual(saved, [{ right: 140, bottom: 246 }]);
    assert.deepEqual(captures, [['set', 1], ['release', 1], ['set', 1], ['release', 1]]);
    assert.equal(helper.consumeClick(new view.MouseEvent('click', { detail: 0 })), false, 'keyboard activation stays usable');
    const click = new view.MouseEvent('click', { detail: 1, cancelable: true });
    assert.equal(helper.consumeClick(click), true);
    assert.equal(click.defaultPrevented, true);
    assert.equal(helper.consumeClick(new view.MouseEvent('click', { detail: 1 })), false);
});

test('header controls, secondary pointers and right clicks cannot move the panel', t => {
    const { host, header, doc, pointer, saved } = setup(t);
    for (const target of [header.querySelector('button'), header.querySelector('input')]) {
        pointer(target, 'pointerdown', 500, 500);
        pointer(doc, 'pointermove', 100, 100);
        pointer(doc, 'pointerup', 100, 100);
    }
    pointer(header, 'pointerdown', 500, 500, { isPrimary: false });
    pointer(doc, 'pointermove', 100, 100);
    pointer(header, 'pointerdown', 500, 500, { button: 2 });
    pointer(doc, 'pointermove', 100, 100);
    assert.equal(host.style.right, '');
    assert.deepEqual(saved, []);
    pointer(header, 'pointerdown', 500, 500);
    pointer(doc, 'pointermove', 100, 100, { pointerId: 2 });
    assert.equal(host.style.right, '', 'another finger does not move the active drag');
    pointer(doc, 'pointermove', 100, 100);
    pointer(doc, 'pointerup', 100, 100);
    assert.deepEqual(saved, [{ right: 420, bottom: 496 }]);
});

test('cancelled or lost pointer capture restores the previous position without saving', t => {
    const { host, header, doc, pointer, saved } = setup(t, { right: 70, bottom: 90 });
    for (const event of ['pointercancel', 'lostpointercapture']) {
        pointer(header, 'pointerdown', 500, 500);
        pointer(doc, 'pointermove', 0, 0);
        assert.equal(host.style.right, '570px');
        pointer(event === 'pointercancel' ? doc : header, event, 0, 0);
        assert.equal(host.style.right, '70px');
        assert.equal(host.style.bottom, '90px');
        assert.equal(host.dataset.dragging, undefined);
        pointer(doc, 'pointerup', 0, 0);
    }
    assert.deepEqual(saved, []);
});

test('dragging is clamped at both screen edges and destroy removes active listeners', t => {
    const { host, header, doc, helper, pointer, saved, view } = setup(t);
    pointer(header, 'pointerdown', 500, 500);
    pointer(doc, 'pointermove', -5000, -5000);
    assert.equal(host.style.right, '752px');
    assert.equal(host.style.bottom, '632px');
    pointer(doc, 'pointermove', 5000, 5000);
    assert.equal(host.style.right, '8px');
    assert.equal(host.style.bottom, '8px');
    helper.destroy();
    assert.equal(host.style.right, '', 'an interrupted unsaved drag restores CSS positioning');
    pointer(doc, 'pointerup', 5000, 5000);
    pointer(header, 'pointerdown', 500, 500);
    pointer(doc, 'pointermove', 600, 600);
    view.dispatchEvent(new view.Event('resize'));
    assert.equal(host.style.right, '');
    assert.deepEqual(saved, []);
});

test('mouse and touch fallback permit dragging without PointerEvent support', t => {
    const { host, header, compact, doc, view, saved } = setup(t);
    header.dispatchEvent(new view.MouseEvent('mousedown', { button: 0, clientX: 500, clientY: 500, bubbles: true }));
    doc.dispatchEvent(new view.MouseEvent('mousemove', { clientX: 400, clientY: 400, bubbles: true }));
    doc.dispatchEvent(new view.MouseEvent('mouseup', { clientX: 400, clientY: 400, bubbles: true }));
    assert.deepEqual(saved, [{ right: 120, bottom: 196 }]);
    const touch = (node, name, x, y) => {
        const event = new view.Event(name, { bubbles: true, cancelable: true });
        const touches = [{ identifier: 9, clientX: x, clientY: y }];
        Object.defineProperties(event, { touches: { value: name === 'touchend' ? [] : touches }, changedTouches: { value: touches } });
        node.dispatchEvent(event);
        return event;
    };
    touch(compact, 'touchstart', 500, 500);
    assert.equal(touch(doc, 'touchmove', 450, 400).defaultPrevented, true);
    touch(doc, 'touchend', 450, 400);
    assert.equal(host.style.right, '170px');
    assert.deepEqual(saved, [{ right: 120, bottom: 196 }, { right: 170, bottom: 296 }]);
});
