// Translates a question (and its options) to Persian with the Claude Code CLI
// that is already installed and signed in on this machine, using Haiku.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const PROMPT = `Translate the user-facing text in this JSON to natural, fluent Persian (Farsi).
Keep code, shell commands, file paths, product names (Claude, GitHub, npm…) and identifiers in English.
Return ONLY the same JSON shape with translated values, no commentary.

`;

function findClaude() {
    const fromPath = GLib.find_program_in_path('claude');
    if (fromPath) return fromPath;
    const home = GLib.get_home_dir();
    const candidates = [
        `${home}/.local/bin/claude`,
        `${home}/.claude/local/claude`,
        `${home}/.npm-global/bin/claude`,
        '/usr/local/bin/claude',
    ];
    // VS Code / Cursor / VSCodium ship a native binary inside the extension
    for (const root of ['.vscode', '.vscode-server', '.cursor', '.vscode-oss']) {
        const dir = Gio.File.new_for_path(`${home}/${root}/extensions`);
        try {
            const en = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            const found = [];
            let info;
            while ((info = en.next_file(null))) {
                if (info.get_name().startsWith('anthropic.claude-code-'))
                    found.push(info.get_name());
            }
            en.close(null);
            // newest version first
            found.sort((a, b) => b.localeCompare(a, undefined, {numeric: true}));
            for (const f of found)
                candidates.push(`${home}/${root}/extensions/${f}/resources/native-binary/claude`);
        } catch (_) {}
    }
    return candidates.find(p => GLib.file_test(p, GLib.FileTest.IS_EXECUTABLE)) ?? null;
}

export class Translator {
    constructor() {
        this._cache = new Map();
        this._binary = undefined;
        this._cancellables = new Set();
    }

    get available() {
        if (this._binary === undefined) this._binary = findClaude();
        return !!this._binary;
    }

    /** @param {{q: string, opts?: string[]}} payload */
    async translate(payload) {
        const key = JSON.stringify(payload);
        if (this._cache.has(key)) return this._cache.get(key);
        if (!this.available) throw new Error('Claude Code CLI not found');

        const proc = new Gio.Subprocess({
            argv: [this._binary, '-p', '--model', 'haiku', '--setting-sources', ''],
            flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        });
        proc.init(null);
        const cancel = new Gio.Cancellable();
        this._cancellables.add(cancel);
        try {
            const [stdout] = await new Promise((resolve, reject) => {
                proc.communicate_utf8_async(PROMPT + key, cancel, (p, res) => {
                    try {
                        const [, out, err] = p.communicate_utf8_finish(res);
                        resolve([out, err]);
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            const match = stdout?.match(/\{[\s\S]*\}/);
            if (!match) throw new Error('No translation returned');
            const result = JSON.parse(match[0]);
            this._cache.set(key, result);
            return result;
        } finally {
            this._cancellables.delete(cancel);
        }
    }

    destroy() {
        this._cancellables.forEach(c => c.cancel());
        this._cache.clear();
    }
}
