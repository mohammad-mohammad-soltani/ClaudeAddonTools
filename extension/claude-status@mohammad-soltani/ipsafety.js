// Claude IP Safety: finds where this machine's public IP is located and, when
// that region isn't supported by Claude, pauses every Claude Code process
// (SIGSTOP) until the user chooses to continue (SIGCONT).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

// Regions where Claude isn't offered. Edit `unsupportedCountries` in
// ~/.cache/claude-status/prefs.json to override.
export const DEFAULT_UNSUPPORTED = ['CN', 'HK', 'MO', 'RU', 'BY', 'IR', 'KP', 'SY', 'CU'];

const CHECK_EVERY_S = 5 * 60;
const decoder = new TextDecoder();

// Two independent lookups; we only pause when every lookup that answered agrees.
const PROVIDERS = [
    {
        url: 'https://ipwho.is/',
        parse: j => j.success === false ? null : {
            ip: j.ip, code: j.country_code, country: j.country, city: j.city, isp: j.connection?.isp || j.connection?.org || '',
        },
    },
    {
        url: 'https://ipinfo.io/json',
        parse: j => j.ip ? {
            ip: j.ip, code: j.country, country: '', city: j.city, isp: (j.org || '').replace(/^AS\d+\s+/, ''),
        } : null,
    },
];

export function flagOf(code) {
    if (!/^[A-Z]{2}$/.test(code || '')) return '🌐';
    return String.fromCodePoint(...[...code].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
}

// ------------------------------------------------------------------ processes
function readFile(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? decoder.decode(bytes) : '';
    } catch (_) {
        return '';
    }
}

/** PIDs of running Claude Code processes owned by this user (CLI + editor extensions). */
export function findClaudePids() {
    const pids = [];
    const self = String(new Gio.Credentials().get_unix_pid());
    let en;
    try {
        en = Gio.File.new_for_path('/proc').enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    } catch (_) {
        return pids;
    }
    const uid = String(new Gio.Credentials().get_unix_user());
    let info;
    while ((info = en.next_file(null))) {
        const pid = info.get_name();
        if (!/^\d+$/.test(pid) || pid === self) continue;
        const status = readFile(`/proc/${pid}/status`);
        if (!status.match(new RegExp(`^Uid:\\s+${uid}\\b`, 'm'))) continue;
        const cmd = readFile(`/proc/${pid}/cmdline`).split('\0').filter(Boolean);
        if (!cmd.length) continue;
        const exe = cmd[0], base = exe.split('/').pop();
        const isNative = base === 'claude' && !cmd.includes('-p'); // skip our own translator runs
        const isNode = /node$/.test(base) && cmd.some(a => /@anthropic-ai\/claude-code\/cli\.js$/.test(a));
        if (isNative || isNode) pids.push(Number(pid));
    }
    en.close(null);
    return pids;
}

function signal(pids, sig) {
    if (!pids.length) return;
    try {
        Gio.Subprocess.new(['kill', `-${sig}`, ...pids.map(String)], Gio.SubprocessFlags.STDERR_SILENCE);
    } catch (e) {
        logError(e, 'claude-status: kill failed');
    }
}

// ------------------------------------------------------------------ checker
export class IpSafety extends Signals.EventEmitter {
    /** @param {{prefs: object, savePrefs: Function}} opts */
    constructor({prefs, savePrefs}) {
        super();
        this._prefs = prefs;
        this._savePrefs = savePrefs;
        this._session = new Soup.Session({timeout: 8, user_agent: 'claude-status-gnome'});
        this._cancel = new Gio.Cancellable();
        this.info = null;       // {ip, code, country, city, isp, supported}
        this.checking = false;
        this.error = null;
        this.paused = (prefs.pausedPids ?? []).filter(p => GLib.file_test(`/proc/${p}`, GLib.FileTest.EXISTS));

        this._netId = Gio.NetworkMonitor.get_default().connect('network-changed', () => this._soon());
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, CHECK_EVERY_S, () => {
            this.check();
            return GLib.SOURCE_CONTINUE;
        });
        this.check();
    }

    get unsupportedList() {
        return this._prefs.unsupportedCountries ?? DEFAULT_UNSUPPORTED;
    }

    get autoPause() {
        return this._prefs.autoPause !== false;
    }

    set autoPause(v) {
        this._prefs.autoPause = v;
        this._savePrefs();
    }

    /** blocked = unsupported IP, sessions paused, and the user hasn't chosen to continue */
    get blocked() {
        return this.paused.length > 0;
    }

    _soon() {
        if (this._soonId) GLib.source_remove(this._soonId);
        this._soonId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 3, () => {
            this._soonId = 0;
            this.check();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _lookup(p) {
        const msg = Soup.Message.new('GET', p.url);
        const bytes = await new Promise((resolve, reject) => {
            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancel, (s, res) => {
                try {
                    resolve(s.send_and_read_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });
        if (msg.get_status() !== 200) throw new Error(`HTTP ${msg.get_status()}`);
        return p.parse(JSON.parse(decoder.decode(bytes.get_data())));
    }

    async check() {
        if (this.checking) return;
        this.checking = true;
        this.emit('changed');
        try {
            const results = (await Promise.allSettled(PROVIDERS.map(p => this._lookup(p))))
                .filter(r => r.status === 'fulfilled' && r.value?.code).map(r => r.value);
            if (!results.length) throw new Error('No IP lookup answered');

            const bad = this.unsupportedList;
            const verdicts = results.map(r => !bad.includes(r.code));
            const supported = verdicts.some(v => v); // pause only if every answer says unsupported
            const best = results[0];
            this.error = null;
            const prevIp = this.info?.ip;
            this.info = {...best, country: best.country || results.find(r => r.country)?.country || best.code, supported};

            if (supported) {
                if (this.paused.length) this.resume();
                this._prefs.acceptedIp = null;
            } else if (this.autoPause && this._prefs.acceptedIp !== this.info.ip) {
                this.pause();
            }
            if (prevIp !== this.info.ip) this.emit('ip-changed');
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) this.error = e.message;
        } finally {
            this.checking = false;
            this.emit('changed');
        }
    }

    pause() {
        const pids = findClaudePids().filter(p => !this.paused.includes(p));
        signal(pids, 'STOP');
        this.paused = [...this.paused, ...pids];
        this._prefs.pausedPids = this.paused;
        this._savePrefs();
        this.emit('paused');
        this.emit('changed');
    }

    resume() {
        signal(this.paused, 'CONT');
        this.paused = [];
        this._prefs.pausedPids = [];
        this._savePrefs();
        this.emit('changed');
    }

    /** "Dismiss and continue": resume and don't pause again for this IP. */
    continueAnyway() {
        if (this.info) this._prefs.acceptedIp = this.info.ip;
        this.resume();
    }

    destroy() {
        this._cancel.cancel();
        Gio.NetworkMonitor.get_default().disconnect(this._netId);
        for (const id of [this._timer, this._soonId])
            if (id) GLib.source_remove(id);
        // never leave Claude frozen when the extension goes away
        if (this.paused.length) this.resume();
        this._session.abort();
    }
}
