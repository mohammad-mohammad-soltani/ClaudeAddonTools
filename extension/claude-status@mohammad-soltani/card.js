// The request card that drops out of the badge when Claude needs you.
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const VERBS = {
    Bash: ['Claude wants to run this command', 'Claude می‌خواهد این دستور را اجرا کند'],
    Edit: ['Claude wants to edit this file', 'Claude می‌خواهد این فایل را ویرایش کند'],
    MultiEdit: ['Claude wants to edit this file', 'Claude می‌خواهد این فایل را ویرایش کند'],
    Write: ['Claude wants to write this file', 'Claude می‌خواهد این فایل را بنویسد'],
    NotebookEdit: ['Claude wants to edit this notebook', 'Claude می‌خواهد این نوت‌بوک را ویرایش کند'],
    WebFetch: ['Claude wants to open this page', 'Claude می‌خواهد این صفحه را باز کند'],
    WebSearch: ['Claude wants to search the web', 'Claude می‌خواهد در وب جستجو کند'],
};
const DEFAULT_VERB = ['Claude wants to use a tool', 'Claude می‌خواهد از یک ابزار استفاده کند'];

function wrapLabel(text, styleClass) {
    const l = new St.Label({text: text ?? '', style_class: styleClass, x_expand: true});
    const ct = l.clutter_text;
    ct.line_wrap = true;
    ct.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    ct.ellipsize = Pango.EllipsizeMode.NONE;
    return l;
}

function setRtl(label, rtl) {
    label.set_text_direction(rtl ? Clutter.TextDirection.RTL : Clutter.TextDirection.LTR);
    label.clutter_text.line_alignment = rtl ? Pango.Alignment.RIGHT : Pango.Alignment.LEFT;
    label.x_align = rtl ? Clutter.ActorAlign.END : Clutter.ActorAlign.FILL;
    if (rtl) label.add_style_class_name('cs-fa');
    else label.remove_style_class_name('cs-fa');
}

function button(label, styleClass, onClick) {
    const b = new St.Button({label, style_class: `cs-btn ${styleClass}`, can_focus: true, x_expand: true});
    b.connect('clicked', onClick);
    return b;
}

export const RequestCard = GObject.registerClass({
    Signals: {'answer': {param_types: [GObject.TYPE_STRING]}},
}, class RequestCard extends St.BoxLayout {
    _init({request, iconWhite, translator, anchor}) {
        super._init({style_class: 'cs-card', vertical: true, reactive: true, visible: false});
        this.request = request;
        this._translator = translator;
        this._anchor = anchor;
        this._lang = 'en';

        const isQuestion = request.kind === 'question';
        const input = request.input ?? {};
        const question = isQuestion ? (input.questions?.[0] ?? {}) : null;

        // original texts (what gets translated)
        this._orig = isQuestion
            ? {q: question.question ?? 'Claude has a question for you', opts: (question.options ?? []).map(o => o.label ?? String(o))}
            : {q: input.description || (VERBS[request.tool] ?? DEFAULT_VERB)[0]};
        this._staticFa = isQuestion || input.description ? null : (VERBS[request.tool] ?? DEFAULT_VERB)[1];

        // ---- header
        const top = new St.BoxLayout({style_class: 'cs-card-top'});
        const logo = new St.Bin({style_class: 'cs-card-logo', child: new St.Icon({gicon: iconWhite, style_class: 'cs-card-logo-icon'})});
        const titles = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        titles.add_child(new St.Label({text: isQuestion ? 'Claude is asking you' : 'Permission needed', style_class: 'cs-card-title'}));
        const project = (request.cwd || '').split('/').filter(Boolean).pop() || 'Claude Code';
        titles.add_child(new St.Label({text: [project, request.model].filter(Boolean).join(' · '), style_class: 'cs-card-sub'}));
        this._trBtn = new St.Button({style_class: 'cs-tr', can_focus: true, y_align: Clutter.ActorAlign.START});
        this._trLabel = new St.Label({text: 'فا', style_class: 'cs-fa'});
        this._trBtn.set_child(this._trLabel);
        this._trBtn.connect('clicked', () => this._toggleTranslate());
        const close = new St.Button({label: '✕', style_class: 'cs-close', can_focus: true, y_align: Clutter.ActorAlign.START});
        close.connect('clicked', () => this.emit('answer', 'terminal'));
        top.add_child(logo);
        top.add_child(titles);
        top.add_child(this._trBtn);
        top.add_child(close);
        this.add_child(top);

        // ---- body
        const body = new St.BoxLayout({style_class: 'cs-card-body', vertical: true});
        body.add_child(new St.Label({text: (isQuestion ? (question.header || 'Question') : request.tool).toUpperCase(), style_class: 'cs-tool'}));
        this._q = wrapLabel(this._orig.q, 'cs-q');
        body.add_child(this._q);

        this._optLabels = [];
        if (isQuestion) {
            const opts = new St.BoxLayout({vertical: true, style_class: 'cs-opts'});
            this._orig.opts.forEach((o, i) => {
                const row = new St.BoxLayout({style_class: 'cs-opt'});
                row.add_child(new St.Label({text: String(i + 1), style_class: 'cs-opt-n', y_align: Clutter.ActorAlign.CENTER}));
                const l = wrapLabel(o, 'cs-opt-text');
                l.y_align = Clutter.ActorAlign.CENTER;
                this._optLabels.push(l);
                row.add_child(l);
                opts.add_child(row);
            });
            body.add_child(opts);
        } else if (request.detail) {
            body.add_child(wrapLabel(`$ ${request.detail}`.replace(/^\$ (?=\/)/, ''), 'cs-cmd'));
        }
        if (request.cwd)
            body.add_child(new St.Label({text: request.cwd.replace(GLib.get_home_dir(), '~'), style_class: 'cs-cwd'}));
        this.add_child(body);

        // ---- actions
        const acts = new St.BoxLayout({style_class: 'cs-actions'});
        if (isQuestion) {
            acts.add_child(button('Answer in terminal', 'cs-primary', () => this.emit('answer', 'terminal')));
        } else {
            acts.add_child(button('Deny', 'cs-ghost', () => this.emit('answer', 'deny')));
            if (request.has_suggestions)
                acts.add_child(button('Always allow', 'cs-secondary', () => this.emit('answer', 'always')));
            acts.add_child(button('Allow', 'cs-primary', () => this.emit('answer', 'allow')));
        }
        this.add_child(acts);

        const foot = new St.BoxLayout({style_class: 'cs-foot'});
        this._footText = new St.Label({text: isQuestion ? 'Reply in the terminal' : 'Answer here or in the terminal', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        foot.add_child(this._footText);
        if (!isQuestion) {
            const term = new St.Button({label: 'Use terminal →', style_class: 'cs-link', can_focus: true});
            term.connect('clicked', () => this.emit('answer', 'terminal'));
            foot.add_child(term);
        }
        this.add_child(foot);

        // ---- countdown bar (time left before the terminal takes over)
        if (request.wait > 0) {
            const track = new St.Widget({style_class: 'cs-bar-track', layout_manager: new Clutter.BinLayout()});
            this._bar = new St.Widget({style_class: 'cs-bar', x_expand: true});
            track.add_child(this._bar);
            this.add_child(track);
        }

        Main.layoutManager.addTopChrome(this);
    }

    async _toggleTranslate() {
        if (this._busy) return;
        if (this._lang === 'fa') {
            this._apply(this._orig, false);
            return;
        }
        if (this._staticFa) {
            this._apply({q: this._staticFa}, true);
            return;
        }
        this._busy = true;
        this._trBtn.add_style_class_name('busy');
        this._trLabel.text = '…';
        try {
            const fa = await this._translator.translate(this._orig);
            if (!this._destroyed) this._apply({q: fa.q ?? this._orig.q, opts: fa.opts ?? this._orig.opts}, true);
        } catch (e) {
            if (!this._destroyed) {
                this._trLabel.text = 'فا';
                this._footText.text = this._translator.available ? 'Translation failed, try again' : 'Claude Code CLI not found';
            }
        } finally {
            this._busy = false;
            if (!this._destroyed) this._trBtn.remove_style_class_name('busy');
        }
    }

    _apply(texts, rtl) {
        this._lang = rtl ? 'fa' : 'en';
        this._q.text = texts.q;
        setRtl(this._q, rtl);
        this._optLabels.forEach((l, i) => {
            l.text = texts.opts?.[i] ?? this._orig.opts[i];
            setRtl(l, rtl);
        });
        this._trLabel.text = rtl ? 'EN' : 'فا';
        this._trLabel.style_class = rtl ? '' : 'cs-fa';
        if (rtl) this._trBtn.add_style_class_name('on');
        else this._trBtn.remove_style_class_name('on');
    }

    // ---- liquid open / close
    _place() {
        const [ax, ay] = this._anchor.get_transformed_position();
        const [aw, ah] = this._anchor.get_transformed_size();
        const mon = Main.layoutManager.primaryMonitor;
        const [, natW] = this.get_preferred_width(-1);
        const w = Math.min(natW, mon.width - 16);
        const x = Math.round(Math.min(Math.max(ax + aw / 2 - w / 2, mon.x + 8), mon.x + mon.width - w - 8));
        this.set_position(x, Math.round(ay + ah + 6));
        // grow out of the badge's centre
        this.set_pivot_point(Math.min(Math.max((ax + aw / 2 - x) / w, 0), 1), 0);
    }

    open() {
        this.show();
        this._place();
        this.remove_all_transitions();
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
        if (this._bar) {
            const left = Math.max(0, this.request.ts + this.request.wait - Date.now() / 1000);
            this._bar.set_pivot_point(0, 0.5);
            this._bar.scale_x = Math.min(1, left / this.request.wait);
            this._bar.ease({scale_x: 0, duration: left * 1000, mode: Clutter.AnimationMode.LINEAR});
        }
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
            this.emit('answer', 'terminal');
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_key_press_event(event);
    }

    destroy() {
        this._destroyed = true;
        super.destroy();
    }
});
