/** Append complete streamed utterances without interrupting the active player run. */
export class AutomaticSpeechQueue {
    constructor({ player, onError = () => {}, isValid = () => true }) {
        this.player = player;
        this.onError = onError;
        this.isValid = isValid;
        this.pending = [];
        this.current = [];
        this.seen = new Set();
        this.version = 0;
        this.running = false;
    }

    get activeItems() {
        return [...this.current, ...this.pending.flatMap(batch => batch.items)];
    }

    get busy() { return this.running; }

    enqueue(items, options = {}) {
        const fresh = [];
        for (const item of items) {
            if (!item || (item.id != null && this.seen.has(item.id)) || !this.isValid(item)) continue;
            fresh.push(item);
            if (item.id != null) this.seen.add(item.id);
        }
        if (!fresh.length) return;
        this.pending.push({ items: fresh, options: { ...options } });
        if (this.running) return;
        this.running = true;
        // drain handles errors itself: callers do not have to await enqueue.
        void this.drain(this.version);
    }

    stop() {
        ++this.version;
        this.pending = [];
        this.current = [];
        this.seen.clear();
        this.running = false;
        this.player.stop();
    }

    async drain(version) {
        try {
            while (version === this.version && this.pending.length) {
                const batch = this.pending.shift();
                // A chat edit, swipe or changed voice mapping can invalidate work
                // while another batch is still playing.
                this.current = batch.items.filter(item => this.isValid(item));
                if (this.current.length) await this.player.run(this.current, batch.options);
                if (version !== this.version) return;
                this.current = [];
            }
        } catch (error) {
            if (version !== this.version) return;
            this.pending = [];
            this.current = [];
            this.running = false;
            ++this.version;
            // Cancellation also drops waiting utterances; it is not a failure
            // notice. Clear state before notifying so callbacks may start anew.
            if (error?.name !== 'AbortError') {
                try { this.onError(error); } catch { /* UI error reporting must not reject this detached task. */ }
            }
        } finally {
            // stop + enqueue can start a new run before the cancelled promise
            // settles. Its queue and busy indicator belong to the new version.
            if (version === this.version) {
                this.current = [];
                this.running = false;
            }
        }
    }
}
