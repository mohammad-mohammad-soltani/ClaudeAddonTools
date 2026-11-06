// The red alert that drops out of the badge when the IP is unsupported
// and every Claude Code session has been paused.
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {flagOf} from './ipsafety.js';

const WAS = {waiting: 'was waiting for you', thinking: 'was working', done: 'was finished', idle: 'was idle'};

function wrap(text, style_class) {
    const l = new St.Label({text, style_class, x_expand: true});
    l.clutter_text.line_wrap = true;
    l.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    l.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return l;
}

export const IpAlert = GObject.registerClass({
    Signals: {'action': {param_types: [GObject.TYPE_STRING]}},
}, class IpAlert extends St.BoxLayout {
    /** @param {{info: object, sessions: {name: string, state: string}[], anchor: Clutter.Actor}} p */
    _init({info, sessions, anchor}) {
        super._init({style_class: 'cs-card cs-alert', vertical: true, reactive: true, visible: false});
        this._anchor = anchor;

        const top = new St.BoxLayout({style_class: 'cs-alert-top'});
        top.add_child(new St.Bin({
            style_class: 'cs-card-logo',
            child: new St.Icon({icon_name: 'security-high-symbolic', style_class: 'cs-alert-shield'}),
        }));
        const t = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        t.add_child(new St.Label({text: 'All sessions paused', style_class: 'cs-card-title'}));
        t.add_child(new St.Label({text: 'Claude IP Safety', style_class: 'cs-card-sub'}));
        top.add_child(t);
        const close = new St.Button({label: '✕', style_class: 'cs-close', can_focus: true, y_align: Clutter.ActorAlign.START});
        close.connect('clicked', () => this.emit('action', 'close'));
        top.add_child(close);
        this.add_child(top);

        const body = new St.BoxLayout({style_class: 'cs-alert-body', vertical: true});
        body.add_child(wrap("Your IP address isn't supported by Claude", 'cs-alert-h'));

        const ip = new St.BoxLayout({style_class: 'cs-ip-card bad'});
        ip.add_child(new St.Label({text: flagOf(info.code), style_class: 'cs-ip-flag', y_align: Clutter.ActorAlign.CENTER}));
        const col = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        col.add_child(new St.Label({text: [info.city, info.country].filter(Boolean).join(', '), style_class: 'cs-ip-place'}));
        col.add_child(new St.Label({text: [info.ip, info.isp].filter(Boolean).join(' · '), style_class: 'cs-ip-sub'}));
        ip.add_child(col);
        ip.add_child(new St.Label({text: '●  Unsupported', style_class: 'cs-pill bad', y_align: Clutter.ActorAlign.CENTER}));
        body.add_child(ip);

        body.add_child(wrap('Using Claude from an unsupported region can get your account banned. ' +
            'To protect it, every Claude Code session was paused.', 'cs-alert-p'));

        if (sessions.length) {
            body.add_child(new St.Label({text: 'PAUSED', style_class: 'cs-alert-lh'}));
            for (const s of sessions) {
                const row = new St.BoxLayout({style_class: 'cs-alert-row'});
                row.add_child(new St.Label({text: '■', style_class: 'cs-alert-sq', y_align: Clutter.ActorAlign.CENTER}));
                row.add_child(new St.Label({text: s.name, x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
                row.add_child(new St.Label({text: WAS[s.state] ?? '', style_class: 'cs-alert-was', y_align: Clutter.ActorAlign.CENTER}));
                body.add_child(row);
            }
        }
        this.add_child(body);

        const acts = new St.BoxLayout({style_class: 'cs-actions'});
        const cont = new St.Button({label: 'Dismiss and continue', style_class: 'cs-btn cs-outline', can_focus: true, x_expand: true});
        cont.connect('clicked', () => this.emit('action', 'continue'));
        const again = new St.Button({label: 'Check again', style_class: 'cs-btn cs-white', can_focus: true, x_expand: true});
        again.connect('clicked', () => this.emit('action', 'recheck'));
        acts.add_child(cont);
        acts.add_child(again);
        this.add_child(acts);

        Main.layoutManager.addTopChrome(this);
    }

    _place() {
        const [ax, ay] = this._anchor.get_transformed_position();
        const [aw, ah] = this._anchor.get_transformed_size();
        const mon = Main.layoutManager.primaryMonitor;
        const [, natW] = this.get_preferred_width(-1);
        const w = Math.min(natW, mon.width - 16);
        const x = Math.round(Math.min(Math.max(ax + aw / 2 - w / 2, mon.x + 8), mon.x + mon.width - w - 8));
        this.set_position(x, Math.round(ay + ah + 6));
        this.set_pivot_point(Math.min(Math.max((ax + aw / 2 - x) / w, 0), 1), 0);
    }

    // same liquid motion as the request card
    open() {
        this.show();
        this._place();
        this.opacity = 0;
        this.scale_x = 0.3;
        this.scale_y = 0.08;
        this.ease({opacity: 255, duration: 160, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this.ease({scale_x: 1, duration: 420, mode: Clutter.AnimationMode.EASE_OUT_BACK});
        this.ease({scale_y: 1, duration: 520, mode: Clutter.AnimationMode.EASE_OUT_ELASTIC});
        this.get_children().forEach((c, i) => {
            c.opacity = 0;
            c.ease({opacity: 255, delay: 140 + i * 40, duration: 260, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        });
        this.grab_key_focus();
    }

    close(done) {
        if (this._closing) return;
        this._closing = true;
        this.remove_all_transitions();
        this.get_children().forEach(c => c.ease({opacity: 0, duration: 100}));
        this.ease({
            scale_x: 0.3, scale_y: 0.06, opacity: 0, delay: 60, duration: 280,
            mode: Clutter.AnimationMode.EASE_IN_BACK,
            onStopped: () => {
                this.destroy();
                done?.();
            },
        });
    }

    vfunc_key_press_event(event) {
        if (event.get_key_symbol() === Clutter.KEY_Escape) {
            this.emit('action', 'close');
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_key_press_event(event);
    }
});
