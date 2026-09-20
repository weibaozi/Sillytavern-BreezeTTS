const MARGIN = 8;
const DRAG_THRESHOLD = 5;
const INTERACTIVE = 'button, input, select, textarea, a, audio, video, [role="button"], [role="switch"], [role="slider"], [contenteditable]:not([contenteditable="false"])';

function savedPosition(value) {
    return value && Number.isFinite(value.right) && Number.isFinite(value.bottom)
        ? { right: value.right, bottom: value.bottom } : null;
}

/** Keep a fixed panel on screen. Only a completed drag changes the saved preference. */
export function attachFloatingPosition({ host, handles = [], position, onPositionChange } = {}) {
    const doc = host.ownerDocument;
    const view = doc.defaultView;
    const dragHandles = [...new Set(handles.filter(Boolean))];
    const listeners = [];
    const originalStyle = { right: host.style.right, bottom: host.style.bottom };
    let current = savedPosition(position);
    let gesture = null;
    let suppressedClick = null;
    let destroyed = false;

    const listen = (node, name, handler, options) => {
        node.addEventListener(name, handler, options);
        listeners.push([node, name, handler, options]);
    };
    const viewport = () => ({
        width: view.innerWidth || doc.documentElement.clientWidth,
        height: view.innerHeight || doc.documentElement.clientHeight,
    });
    const geometry = () => {
        if (host.hidden || !host.isConnected) return null;
        const rect = host.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 ? rect : null;
    };
    const clamp = (value, rect) => {
        const { width, height } = viewport();
        return {
            right: Math.min(Math.max(MARGIN, value.right), Math.max(MARGIN, width - rect.width - MARGIN)),
            bottom: Math.min(Math.max(MARGIN, value.bottom), Math.max(MARGIN, height - rect.height - MARGIN)),
        };
    };
    const apply = value => {
        const right = `${value.right}px`, bottom = `${value.bottom}px`;
        if (host.style.right !== right) host.style.right = right;
        if (host.style.bottom !== bottom) host.style.bottom = bottom;
    };
    const refresh = () => {
        if (destroyed || !current) return;
        const rect = geometry();
        if (!rect) return;
        current = clamp(current, rect);
        apply(current);
    };
    const clearDragging = () => {
        delete host.dataset.dragging;
    };
    const finish = cancelled => {
        if (!gesture) return;
        const ended = gesture;
        gesture = null;
        clearDragging();
        if (ended.family === 'pointer') {
            try {
                ended.handle.releasePointerCapture?.(ended.id);
            } catch { /* The pointer may already have been released by the browser. */ }
        }
        if (!ended.moved) return;
        suppressedClick = { handle: ended.handle, until: view.performance.now() + 750 };
        if (cancelled) {
            current = ended.previous;
            if (current) refresh();
            else {
                host.style.right = originalStyle.right;
                host.style.bottom = originalStyle.bottom;
            }
        } else {
            refresh();
            onPositionChange?.({ ...current });
        }
    };
    const begin = (event, handle, family, id, x, y) => {
        if (destroyed || gesture || !Number.isFinite(x) || !Number.isFinite(y)) return;
        const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
        const control = target?.closest(INTERACTIVE);
        if (control && control !== handle && handle.contains(control)) return;
        const rect = geometry();
        if (!rect) return;
        const { width, height } = viewport();
        suppressedClick = null;
        gesture = {
            handle, family, id, x, y, moved: false, previous: current && { ...current },
            origin: { right: width - rect.right, bottom: height - rect.bottom },
        };
        if (family === 'pointer') {
            try {
                handle.setPointerCapture?.(id);
            } catch { /* Detached or synthetic pointers do not support capture. */ }
        }
    };
    const move = (event, x, y) => {
        if (!gesture || !Number.isFinite(x) || !Number.isFinite(y)) return;
        const dx = x - gesture.x, dy = y - gesture.y;
        if (!gesture.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        const rect = geometry();
        if (!rect) { finish(true); return; }
        gesture.moved = true;
        if (host.dataset.dragging !== 'true') host.dataset.dragging = 'true';
        current = clamp({ right: gesture.origin.right - dx, bottom: gesture.origin.bottom - dy }, rect);
        apply(current);
        if (event.cancelable) event.preventDefault();
    };
    const pointerMatches = event => gesture?.family === 'pointer' && event.pointerId === gesture.id;

    for (const handle of dragHandles) {
        listen(handle, 'pointerdown', event => {
            if (event.isPrimary === false || event.button !== 0) return;
            begin(event, handle, 'pointer', event.pointerId, event.clientX, event.clientY);
        });
        listen(handle, 'lostpointercapture', event => {
            if (pointerMatches(event)) finish(true);
        });
    }
    listen(doc, 'pointermove', event => {
        if (pointerMatches(event)) move(event, event.clientX, event.clientY);
    }, { passive: false });
    listen(doc, 'pointerup', event => {
        if (pointerMatches(event)) finish(false);
    });
    listen(doc, 'pointercancel', event => {
        if (pointerMatches(event)) finish(true);
    });

    // Pointer events cover mouse, touch and pen in current browsers. Retain a
    // small fallback for older embedded browsers without PointerEvent support.
    if (!view.PointerEvent) {
        for (const handle of dragHandles) {
            listen(handle, 'mousedown', event => {
                if (event.button === 0) begin(event, handle, 'mouse', 0, event.clientX, event.clientY);
            });
            listen(handle, 'touchstart', event => {
                if (event.touches.length !== 1) return;
                const touch = event.changedTouches[0];
                if (touch) begin(event, handle, 'touch', touch.identifier, touch.clientX, touch.clientY);
            }, { passive: true });
        }
        listen(doc, 'mousemove', event => {
            if (gesture?.family === 'mouse') move(event, event.clientX, event.clientY);
        });
        listen(doc, 'mouseup', () => {
            if (gesture?.family === 'mouse') finish(false);
        });
        listen(doc, 'touchmove', event => {
            if (gesture?.family !== 'touch') return;
            const touch = [...event.changedTouches].find(item => item.identifier === gesture.id);
            if (touch) move(event, touch.clientX, touch.clientY);
        }, { passive: false });
        for (const name of ['touchend', 'touchcancel']) listen(doc, name, event => {
            if (gesture?.family !== 'touch') return;
            if ([...event.changedTouches].some(item => item.identifier === gesture.id)) finish(name === 'touchcancel');
        });
    }

    listen(view, 'resize', refresh);
    listen(view, 'blur', () => finish(true));
    const observer = view.ResizeObserver ? new view.ResizeObserver(refresh) : null;
    observer?.observe(host);
    refresh();

    return {
        refresh,
        consumeClick(event) {
            if (destroyed || !suppressedClick) return false;
            if (view.performance.now() > suppressedClick.until) { suppressedClick = null; return false; }
            // Keyboard activation remains available immediately after a drag.
            if (event?.detail === 0) return false;
            if (event?.target && !suppressedClick.handle.contains(event.target)) return false;
            suppressedClick = null;
            event?.preventDefault();
            event?.stopPropagation();
            return true;
        },
        destroy() {
            if (destroyed) return;
            finish(true);
            destroyed = true;
            suppressedClick = null;
            observer?.disconnect();
            for (const [node, name, handler, options] of listeners) node.removeEventListener(name, handler, options);
        },
    };
}
