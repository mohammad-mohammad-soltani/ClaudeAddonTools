// Watches ~/.cache/claude-status and turns the files written by the hook into
// plain JS objects. Emits 'changed' whenever sessions or requests change.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

export const BASE = GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-status']);
const SESSIONS = GLib.build_filenamev([BASE, 'sessions']);
const REQUESTS = GLib.build_filenamev([BASE, 'requests']);
const RESPONSES = GLib.build_filenamev([BASE, 'responses']);
const HEARTBEAT = GLib.build_filenamev([BASE, 'extension.alive']);

const STALE_THINKING_S = 20 * 60; // Esc-interrupted turns never send Stop
const STALE_WAITING_S = 30 * 60;
const DONE_TTL_S = 3 * 60 * 60;

const decoder = new TextDecoder();

function readDir(dir) {
    const out = [];
    try {
        const en = Gio.File.new_for_path(dir).enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = en.next_file(null))) {
            const name = info.get_name();
            if (!name.endsWith('.json')) continue;
            try {
                const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([dir, name]));
                const rec = JSON.parse(decoder.decode(bytes));
                rec._file = GLib.build_filenamev([dir, name]);
                out.push(rec);
            } catch (_) {}
        }
        en.close(null);
    } catch (_) {}
    return out;
}

export class Store extends Signals.EventEmitter {
    constructor() {
        super();
        this.sessions = [];
        this.requests = [];
        for (const d of [SESSIONS, REQUESTS, RESPONSES])
            GLib.mkdir_with_parents(d, 0o700);

        this._monitors = [SESSIONS, REQUESTS].map(dir => {
            const m = Gio.File.new_for_path(dir).monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            m.connect('changed', () => this._queue());
            return m;
        });
        this._beat();
        this._beatId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 5, () => {
            this._beat();
            return GLib.SOURCE_CONTINUE;
        });
        this.reload();
    }

    // Tells the hook the extension is alive, so it may wait for an answer.
    _beat() {
        try {
            GLib.file_set_contents(HEARTBEAT, String(Date.now()));
        } catch (_) {}
    }

    _queue() {
        if (this._queueId) return;
        this._queueId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
            this._queueId = 0;
            this.reload();
            return GLib.SOURCE_REMOVE;
        });
    }

    reload() {
        this.sessions = readDir(SESSIONS);
        const now = Date.now() / 1000;
        // a request is live while its session is still waiting on it
        // (and, for approvals, while the hook is still waiting for an answer)
        this.requests = readDir(REQUESTS).filter(r => {
            const s = this.sessions.find(x => x.session_id === r.session_id);
            const live = s?.state === 'waiting' && s.request_id === r.id && (!r.wait || now - r.ts < r.wait + 2);
            if (!live && r.kind === 'question') this.remove(r._file);
            return live;
        });
        this.emit('changed');
    }

    effectiveState(s, now = Date.now() / 1000) {
        const age = now - (s.ts || 0);
        if (s.state === 'thinking' && age > STALE_THINKING_S) return 'idle';
        if (s.state === 'waiting' && age > STALE_WAITING_S) return 'idle';
        if (s.state === 'done' && age > DONE_TTL_S) return 'idle';
        return s.state || 'idle';
    }

    requestFor(session) {
        return this.requests.find(r => r.session_id === session.session_id) ?? null;
    }

    respond(request, decision) {
        try {
            GLib.file_set_contents(GLib.build_filenamev([RESPONSES, `${request.id}.json`]),
                JSON.stringify({decision, ts: Date.now() / 1000}));
        } catch (e) {
            logError(e, 'claude-status: cannot write response');
        }
        // question cards are display-only; just forget them
        if (request.kind === 'question') this.remove(request._file);
    }

    remove(path) {
        try {
            Gio.File.new_for_path(path).delete(null);
        } catch (_) {}
        this._queue();
    }

    destroy() {
        for (const id of [this._beatId, this._queueId])
            if (id) GLib.source_remove(id);
        this._monitors.forEach(m => m.cancel());
        try {
            Gio.File.new_for_path(HEARTBEAT).delete(null);
        } catch (_) {}
    }
}
