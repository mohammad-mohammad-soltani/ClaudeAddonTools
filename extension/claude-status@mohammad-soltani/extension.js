// Claude Status — a top-bar badge for Claude Code.
// https://github.com/mohammad-mohammad-soltani/ClaudeAddonTools
import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Store, BASE} from './store.js';
import {Translator} from './translator.js';
import {RequestCard} from './card.js';
import {IpSafety, flagOf} from './ipsafety.js';
import {IpAlert} from './alert.js';

const AUTHOR_URL = 'https://github.com/mohammad-mohammad-soltani';
const PREFS = GLib.build_filenamev([BASE, 'prefs.json']);
const PRIORITY = {waiting: 3, thinking: 2, done: 1, idle: 0};
const BADGE_TEXT = {thinking: 'Thinking', waiting: 'Approve', done: 'Done', idle: '', blocked: 'Blocked'};
const ROW_TEXT = {thinking: 'Working', waiting: 'Needs you', done: 'Finished', idle: 'Idle'};
const MARK = {waiting: '!', done: '✓', blocked: '!'};

function fmtClock(sec) {
    sec = Math.max(0, Math.floor(sec));
    const m = Math.floor(sec / 60), s = sec % 60;
    if (m < 60) return `${m}:${String(s).padStart(2, '0')}`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function fmtAgo(sec) {
    sec = Math.max(0, Math.floor(sec));
    if (sec < 60) return 'now';
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    return `${Math.floor(sec / 3600)}h ago`;
}

function fmtDuration(sec) {
    sec = Math.max(0, Math.round(sec));
    const m = Math.floor(sec / 60);
    return m ? `${m}m ${sec % 60}s` : `${sec}s`;
}

const projectOf = s => (s.cwd || '').split('/').filter(Boolean).pop() || 'session';

function loadPrefs() {
    try {
        const [, bytes] = GLib.file_get_contents(PREFS);
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch (_) {
        return {};
    }
}

function savePrefs(p) {
    try {
        GLib.file_set_contents(PREFS, JSON.stringify(p));
    } catch (_) {}
}

// Claude mark with a small status dot in its corner
const Mark = GObject.registerClass(
class Mark extends St.Widget {
    _init(gicon, size, styleClass) {
        super._init({layout_manager: new Clutter.BinLayout(), style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
        this.icon = new St.Icon({gicon, icon_size: size, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this.dot = new St.Label({style_class: 'cs-mark', x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.END, visible: false});
        this.add_child(this.icon);
        this.add_child(this.dot);
    }

    setState(state) {
        this.dot.text = MARK[state] ?? '';
        this.dot.visible = !!MARK[state];
        this.dot.style_class = `cs-mark ${state}`;
    }
});

const ClaudeIndicator = GObject.registerClass(
class ClaudeIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, 'Claude Status');
        const icons = ext.dir.get_child('icons');
        this._iconWhite = Gio.FileIcon.new(icons.get_child('claude-white.svg'));
        this._iconColor = Gio.FileIcon.new(icons.get_child('claude.svg'));
        this._prefs = loadPrefs();
        this._store = new Store();
        this._translator = new Translator();
        this._state = null;
        this._card = null;
        this._seen = new Set();
        this._alert = null;
        this._ip = new IpSafety({prefs: this._prefs, savePrefs: () => savePrefs(this._prefs)});

        // ---- badge
        this._badge = new St.BoxLayout({style_class: 'cs-badge idle', y_align: Clutter.ActorAlign.CENTER});
        this._mark = new Mark(this._iconWhite, 15, 'cs-badge-icon');
        this._lblState = new St.Label({style_class: 'cs-state', y_align: Clutter.ActorAlign.CENTER});
        this._lblProject = new St.Label({style_class: 'cs-project', y_align: Clutter.ActorAlign.CENTER});
        this._lblModel = new St.Label({style_class: 'cs-model', y_align: Clutter.ActorAlign.CENTER});
        this._lblTime = new St.Label({style_class: 'cs-time', y_align: Clutter.ActorAlign.CENTER});
        this._lblCount = new St.Label({style_class: 'cs-count', y_align: Clutter.ActorAlign.CENTER});
        // short "<project> done" / "<project> needs you" announcements
        this._toastLbl = new St.Label({style_class: 'cs-toast-text', y_align: Clutter.ActorAlign.CENTER, visible: false});
        this._toasts = [];
        this._prevStates = null;
        for (const a of [this._mark, this._toastLbl, this._lblState, this._lblProject, this._lblModel, this._lblTime, this._lblCount])
            this._badge.add_child(a);
        this.add_child(this._badge);
        this.add_style_class_name('cs-button');

        // ---- panel
        this.menu.actor.add_style_class_name('cs-menu');
        this.menu.box.add_style_class_name('cs-menu-box');
        this._buildMenuChrome();
        this.menu.connect('open-state-changed', (_m, open) => {
            if (open) {
                this._closeCard();
                this._fillMenu();
                this._liquidMenu();
            }
            if (open) this._badge.add_style_class_name('open');
            else this._badge.remove_style_class_name('open');
        });

        this._storeId = this._store.connect('changed', () => this._sync());
        this._ipIds = [
            this._ip.connect('changed', () => {
                this._render();
                this._fillIp();
            }),
            this._ip.connect('paused', () => {
                // remember what each session was doing when it was paused
                const now = Date.now() / 1000;
                this._pausedSessions = this._store.sessions.map(s => ({name: projectOf(s), state: this._store.effectiveState(s, now)}));
                this._closeCard();
                this.menu.close();
                this._openAlert();
            }),
        ];
        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._render();
            return GLib.SOURCE_CONTINUE;
        });
        this._sync();
    }

    // ------------------------------------------------------------ state
    _sync() {
        this._detectTransitions();
        this._render();
        if (this.menu.isOpen) this._fillMenu();
        this._syncCard();
    }

    _top() {
        const now = Date.now() / 1000;
        let top = 'idle', session = null, active = 0;
        for (const s of this._store.sessions) {
            const st = this._store.effectiveState(s, now);
            if (st !== 'idle') active++;
            if (PRIORITY[st] > PRIORITY[top] || (st === top && session && s.ts > session.ts)) {
                top = st;
                session = s;
            }
        }
        return {top, session, active, now};
    }

    // When one session finishes or needs you while another is still busy,
    // the badge briefly announces it by name.
    _detectTransitions() {
        const now = Date.now() / 1000;
        const states = new Map(this._store.sessions.map(s => [s.session_id, [s, this._store.effectiveState(s, now)]]));
        if (this._prevStates && !this._ip?.blocked) {
            for (const [id, [s, st]] of states) {
                const prev = this._prevStates.get(id);
                if (!prev || prev === st || (st !== 'done' && st !== 'waiting')) continue;
                const othersBusy = [...states].some(([oid, [, ost]]) => oid !== id && (ost === 'thinking' || ost === 'waiting'));
                if (othersBusy) this._announce(projectOf(s), st);
            }
        }
        this._prevStates = new Map([...states].map(([id, [, st]]) => [id, st]));
    }

    _announce(name, kind) {
        this._toasts = this._toasts.filter(t => t.name !== name);
        this._toasts.push({name, kind});
        if (!this._toastOn) this._nextToast();
    }

    _nextToast() {
        if (this._toastId) GLib.source_remove(this._toastId);
        this._toastId = 0;
        const t = this._toasts.shift();
        const lbl = this._toastLbl;
        if (!t) {
            this._toastOn = false;
            lbl.visible = false;
            this._state = undefined; // force a full redraw of the normal badge
            this._render();
            return;
        }
        this._toastOn = true;
        for (const a of [this._lblState, this._lblProject, this._lblModel, this._lblTime, this._lblCount]) a.visible = false;
        this._badge.style_class = `cs-badge toast ${t.kind}`;
        this._mark.setState(t.kind);
        lbl.text = t.kind === 'done' ? `${t.name} done` : `${t.name} needs you`;
        lbl.visible = true;
        lbl.remove_all_transitions();
        lbl.opacity = 0;
        lbl.translation_y = 7;
        lbl.ease({opacity: 255, translation_y: 0, duration: 340, mode: Clutter.AnimationMode.EASE_OUT_BACK});
        this._squish();
        this._toastId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3400, () => {
            this._toastId = 0;
            lbl.ease({
                opacity: 0, translation_y: -7, duration: 220, mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onStopped: () => this._nextToast(),
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _render() {
        if (this._toastOn) return;
        let {top, session, active, now} = this._top();
        const blocked = this._ip?.blocked;
        if (blocked) top = 'blocked';
        if (top !== this._state) {
            this._badge.style_class = `cs-badge ${top}${this.menu.isOpen ? ' open' : ''}`;
            this._mark.setState(top);
            this._animate(top);
            if (this._state && top !== 'idle') this._squish();
            this._state = top;
        }
        const busy = blocked || (top !== 'idle' && !!session);
        this._lblState.text = BADGE_TEXT[top];
        this._lblProject.text = blocked ? 'Unsupported IP' : busy ? projectOf(session) : '';
        this._lblModel.text = busy && session ? session.model || '' : '';
        this._lblTime.text = top === 'thinking' && session ? fmtClock(now - (session.turn_started || session.since)) : '';
        this._lblCount.text = active > 1 ? String(active) : '';
        this._lblState.visible = this._lblProject.visible = busy;
        this._lblModel.visible = busy && !!session?.model;
        this._lblTime.visible = top === 'thinking';
        this._lblCount.visible = active > 1;
    }

    _animate(state) {
        if (this._pulseId) {
            GLib.source_remove(this._pulseId);
            this._pulseId = 0;
        }
        const icon = this._mark.icon, dot = this._mark.dot;
        icon.remove_all_transitions();
        dot.remove_all_transitions();
        icon.set_pivot_point(0.5, 0.5);
        icon.scale_x = icon.scale_y = 1;
        dot.opacity = 255;

        if (state === 'thinking') {
            // the mark breathes
            let big = false;
            const step = () => {
                big = !big;
                const s = big ? 1.08 : 0.72;
                icon.ease({scale_x: s, scale_y: s, duration: 700, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE});
                return GLib.SOURCE_CONTINUE;
            };
            step();
            this._pulseId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, step);
        } else if (state === 'waiting') {
            let dim = false;
            this._pulseId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
                dim = !dim;
                dot.ease({opacity: dim ? 90 : 255, duration: 750, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE});
                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    // the badge squashes like a drop leaving it
    _squish() {
        const b = this._badge;
        b.set_pivot_point(0.5, 0.5);
        b.remove_all_transitions();
        b.ease({
            scale_x: 1.1, scale_y: 0.84, duration: 110, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => b.ease({scale_x: 1, scale_y: 1, duration: 420, mode: Clutter.AnimationMode.EASE_OUT_ELASTIC}),
        });
    }

    _liquidMenu() {
        const box = this.menu.box;
        box.set_pivot_point(0.5, 0);
        box.remove_all_transitions();
        box.scale_x = 0.55;
        box.scale_y = 0.2;
        box.ease({scale_x: 1, duration: 380, mode: Clutter.AnimationMode.EASE_OUT_BACK});
        box.ease({scale_y: 1, duration: 520, mode: Clutter.AnimationMode.EASE_OUT_ELASTIC});
        this._squish();
    }

    // ------------------------------------------------------------ request card
    _syncCard() {
        const reqs = this._store.requests;
        // the request on screen was answered elsewhere, or timed out
        if (this._card && !reqs.some(r => r.id === this._card.request.id))
            this._closeCard();
        if (this._card || this._alert || this.menu.isOpen || this._prefs.mute || this._ip.blocked) return;
        const next = reqs.filter(r => !this._seen.has(r.id)).sort((a, b) => a.ts - b.ts)[0];
        if (next) this._openCard(next);
    }

    _openCard(request) {
        this._seen.add(request.id);
        const card = new RequestCard({request, iconWhite: this._iconWhite, translator: this._translator, anchor: this._badge});
        card.connect('answer', (_c, decision) => {
            this._store.respond(request, decision);
            if (this._card === card) this._closeCard();
        });
        this._card = card;
        card.open();
        this._squish();
    }

    _closeCard() {
        const card = this._card;
        if (!card) return;
        this._card = null;
        card.close(() => this._syncCard());
    }

    // ------------------------------------------------------------ IP alert
    _openAlert() {
        if (this._alert || !this._ip.info) return;
        const alert = new IpAlert({info: this._ip.info, sessions: this._pausedSessions ?? [], anchor: this._badge});
        alert.connect('action', (_a, action) => {
            if (action === 'continue') this._ip.continueAnyway();
            else if (action === 'recheck') this._ip.check();
            if (action !== 'recheck') this._closeAlert();
        });
        this._alert = alert;
        alert.open();
        this._squish();
    }

    _closeAlert() {
        const a = this._alert;
        if (!a) return;
        this._alert = null;
        a.close(() => this._syncCard());
    }

    // while blocked, clicking the badge toggles the alert instead of the panel
    vfunc_event(event) {
        const t = event.type();
        if (this._ip?.blocked && (t === Clutter.EventType.BUTTON_PRESS || t === Clutter.EventType.TOUCH_BEGIN)) {
            if (this._alert) this._closeAlert();
            else this._openAlert();
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_event(event);
    }

    // ------------------------------------------------------------ panel
    _buildMenuChrome() {
        const head = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'cs-head'});
        head.add_child(new St.Icon({gicon: this._iconColor, icon_size: 24, y_align: Clutter.ActorAlign.CENTER}));
        const titles = new St.BoxLayout({vertical: true, x_expand: true});
        titles.add_child(new St.Label({text: 'Claude Code', style_class: 'cs-head-title'}));
        this._headSub = new St.Label({style_class: 'cs-head-sub'});
        titles.add_child(this._headSub);
        head.add_child(titles);
        this.menu.addMenuItem(head);

        this._chips = new St.BoxLayout({style_class: 'cs-chips'});
        const chipItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'cs-chip-row'});
        chipItem.add_child(this._chips);
        this.menu.addMenuItem(chipItem);

        this._list = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._list);

        // Claude IP Safety
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const ipItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'cs-ip'});
        const ipBox = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'cs-ip-box'});
        const ipHead = new St.BoxLayout();
        ipHead.add_child(new St.Label({text: 'CLAUDE IP SAFETY', style_class: 'cs-ip-h', x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        this._ipRefresh = new St.Button({style_class: 'cs-ip-re', can_focus: true, child: new St.Icon({icon_name: 'view-refresh-symbolic', icon_size: 14})});
        this._ipRefresh.connect('clicked', () => this._ip.check());
        ipHead.add_child(this._ipRefresh);
        ipBox.add_child(ipHead);
        this._ipCard = new St.BoxLayout({style_class: 'cs-ip-card'});
        this._ipFlag = new St.Label({style_class: 'cs-ip-flag', y_align: Clutter.ActorAlign.CENTER});
        const ipCol = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._ipPlace = new St.Label({style_class: 'cs-ip-place'});
        this._ipSub = new St.Label({style_class: 'cs-ip-sub'});
        this._ipSub.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        ipCol.add_child(this._ipPlace);
        ipCol.add_child(this._ipSub);
        this._ipPill = new St.Label({style_class: 'cs-pill', y_align: Clutter.ActorAlign.CENTER});
        this._ipCard.add_child(this._ipFlag);
        this._ipCard.add_child(ipCol);
        this._ipCard.add_child(this._ipPill);
        ipBox.add_child(this._ipCard);
        this._ipNote = new St.Label({style_class: 'cs-ip-note'});
        this._ipNote.clutter_text.line_wrap = true;
        ipBox.add_child(this._ipNote);
        ipItem.add_child(ipBox);
        this.menu.addMenuItem(ipItem);
        const autoPause = new PopupMenu.PopupSwitchMenuItem('Pause sessions on unsupported IP', this._ip.autoPause);
        autoPause.connect('toggled', (_i, on) => {
            this._ip.autoPause = on;
        });
        this.menu.addMenuItem(autoPause);
        this._fillIp();

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const auto = new PopupMenu.PopupSwitchMenuItem('Pop up requests automatically', !this._prefs.mute);
        auto.connect('toggled', (_i, on) => {
            this._prefs.mute = !on;
            savePrefs(this._prefs);
        });
        this.menu.addMenuItem(auto);
        this.menu.addAction('Clear finished', () => {
            const now = Date.now() / 1000;
            for (const s of this._store.sessions) {
                const st = this._store.effectiveState(s, now);
                if (st === 'done' || st === 'idle') this._store.remove(s._file);
            }
        });

        const credit = new PopupMenu.PopupBaseMenuItem({style_class: 'cs-credit'});
        const box = new St.BoxLayout({x_expand: true, x_align: Clutter.ActorAlign.CENTER});
        box.add_child(new St.Label({text: 'Powered by ', style_class: 'cs-credit-text'}));
        box.add_child(new St.Label({text: 'mohammad mohammad soltani', style_class: 'cs-credit-name'}));
        credit.add_child(box);
        credit.connect('activate', () => {
            try {
                Gio.AppInfo.launch_default_for_uri(AUTHOR_URL, null);
            } catch (e) {
                logError(e);
            }
        });
        this.menu.addMenuItem(credit);
    }

    _fillIp() {
        if (!this._ipCard) return;
        const ip = this._ip, info = ip.info;
        this._ipRefresh.reactive = !ip.checking;
        this._ipRefresh.opacity = ip.checking ? 110 : 255;
        if (!info) {
            this._ipFlag.text = '🌐';
            this._ipPlace.text = ip.checking ? 'Checking your IP…' : "Couldn't check your IP";
            this._ipSub.text = ip.error ?? '';
            this._ipPill.visible = false;
            this._ipNote.text = '';
            this._ipCard.style_class = 'cs-ip-card';
            return;
        }
        this._ipFlag.text = flagOf(info.code);
        this._ipPlace.text = [info.city, info.country].filter(Boolean).join(', ');
        this._ipSub.text = [info.ip, info.isp].filter(Boolean).join(' · ');
        this._ipPill.visible = true;
        this._ipPill.text = info.supported ? '●  Supported' : '●  Unsupported';
        this._ipPill.style_class = `cs-pill ${info.supported ? 'ok' : 'bad'}`;
        this._ipCard.style_class = `cs-ip-card${info.supported ? '' : ' bad'}`;
        this._ipNote.text = info.supported
            ? 'Claude is available in this region.'
            : ip.blocked
                ? "Claude isn't available in this region. Your sessions are paused."
                : "Claude isn't available in this region. Using it from here can get your account banned.";
    }

    _fillMenu() {
        const now = Date.now() / 1000;
        const groups = {waiting: [], thinking: [], done: [], idle: []};
        for (const s of this._store.sessions)
            groups[this._store.effectiveState(s, now)].push(s);
        Object.values(groups).forEach(g => g.sort((a, b) => b.ts - a.ts));

        const active = groups.waiting.length + groups.thinking.length;
        const total = this._store.sessions.length;
        this._headSub.text = total
            ? `${total} session${total > 1 ? 's' : ''}${active ? `, ${active} active` : ''}`
            : 'No sessions yet';

        this._chips.destroy_all_children();
        for (const [k, label] of [['waiting', 'needs you'], ['thinking', 'working'], ['done', 'done']]) {
            if (!groups[k].length) continue;
            const chip = new St.BoxLayout({style_class: `cs-chip ${k}`});
            chip.add_child(new St.Widget({style_class: 'cs-chip-dot', y_align: Clutter.ActorAlign.CENTER}));
            chip.add_child(new St.Label({text: `${groups[k].length} ${label}`, y_align: Clutter.ActorAlign.CENTER}));
            this._chips.add_child(chip);
        }

        this._list.removeAll();
        if (!total) {
            this._list.addMenuItem(new PopupMenu.PopupMenuItem('Start Claude Code and your sessions show up here.',
                {reactive: false, style_class: 'cs-empty'}));
            return;
        }
        for (const [k, title] of [['waiting', 'Needs you'], ['thinking', 'Working'], ['done', 'Finished'], ['idle', 'Idle']]) {
            if (!groups[k].length) continue;
            this._list.addMenuItem(new PopupMenu.PopupMenuItem(title.toUpperCase(), {reactive: false, style_class: 'cs-group'}));
            for (const s of groups[k]) this._list.addMenuItem(this._row(s, k, now));
        }
    }

    _row(s, state, now) {
        const item = new PopupMenu.PopupBaseMenuItem({style_class: `cs-row ${state}`});
        const ic = new Mark(this._iconColor, 17, `cs-row-icon ${state}`);
        ic.setState(state);
        item.add_child(ic);

        const col = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'cs-row-col'});
        const line = new St.BoxLayout();
        line.add_child(new St.Label({text: projectOf(s), style_class: 'cs-row-title', x_expand: true}));
        let right = fmtAgo(now - s.ts);
        if (state === 'thinking') right = fmtClock(now - (s.turn_started || s.since));
        if (state === 'waiting') right = fmtClock(now - s.since);
        line.add_child(new St.Label({text: right, style_class: 'cs-row-time'}));
        col.add_child(line);

        let sub = ROW_TEXT[state];
        if (state === 'done' && s.finished_in) sub = `Finished in ${fmtDuration(s.finished_in)}`;
        else if (state !== 'done' && s.tool) sub = `${s.tool}${s.detail ? `  ${s.detail.split('\n')[0]}` : ''}`;
        if (s.model) sub += `  ·  ${s.model}`;
        const subL = new St.Label({text: sub, style_class: 'cs-row-sub'});
        subL.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        col.add_child(subL);
        const req = state === 'waiting' ? this._store.requestFor(s) : null;
        if (req) col.add_child(new St.Label({text: 'Click to answer →', style_class: 'cs-row-cta'}));
        item.add_child(col);

        item.connect('activate', () => {
            const r = this._store.requestFor(s);
            if (r) {
                this.menu.close();
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 220, () => {
                    if (!this._card) this._openCard(r);
                    return GLib.SOURCE_REMOVE;
                });
            } else if (state === 'done' || state === 'idle') {
                this._store.remove(s._file);
            }
        });
        return item;
    }

    destroy() {
        for (const id of [this._tickId, this._pulseId, this._toastId])
            if (id) GLib.source_remove(id);
        this._tickId = this._pulseId = this._toastId = 0;
        this._card?.destroy();
        this._card = null;
        this._alert?.destroy();
        this._alert = null;
        this._ipIds?.forEach(id => this._ip.disconnect(id));
        this._ip.destroy();
        if (this._storeId) this._store.disconnect(this._storeId);
        this._store.destroy();
        this._translator.destroy();
        super.destroy();
    }
});

export default class ClaudeStatusExtension extends Extension {
    enable() {
        this._indicator = new ClaudeIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
