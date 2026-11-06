#!/usr/bin/env python3
"""Renders docs/images/setup-*.png from the real setup wizard.
Every action that would change the system is replaced with a no-op.
Usage: python3 docs/showcase/shot-setup.py   (needs a display)"""
import importlib.machinery, importlib.util, os, sys, tempfile, shutil
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
share = tempfile.mkdtemp()
shutil.copy(f"{ROOT}/hooks/claude-status-hook.py", share)
shutil.copy(f"{ROOT}/packaging/setup/claude-status.svg", share)
os.environ["CLAUDE_STATUS_SHARE"] = share

loader = importlib.machinery.SourceFileLoader("setup", f"{ROOT}/packaging/setup/claude-status-setup")
spec = importlib.util.spec_from_loader("setup", loader)
m = importlib.util.module_from_spec(spec)
loader.exec_module(m)
from gi.repository import GLib, Gtk, Adw  # noqa: E402

# --- no side effects
m.write_hooks = lambda **k: None
m.save_prefs = lambda *a: None
m.install_font = lambda p: None
m.enable_extension = lambda: True
m.SetupWindow._mark_done = lambda self: None
m.extension_state = lambda: "enabled"
m.gnome_version = lambda: 46

OUT = f"{ROOT}/docs/images"

def snap(win, name):
    paintable = Gtk.WidgetPaintable(widget=win)
    w, h = win.get_width(), win.get_height()
    s = Gtk.Snapshot()
    paintable.snapshot(s, w, h)
    node = s.to_node()
    tex = win.get_native().get_renderer().render_texture(node, None)
    tex.save_to_png(f"{OUT}/setup-{name}.png")
    print("saved", name)

class ShotApp(m.App):
    def do_command_line(self, cmd):
        win = m.SetupWindow(self)
        win.set_default_size(660, 780)
        win.font_path = None
        win.present()
        plan = [(0, "welcome"), (1, "check"), (2, "options")]
        def run(i=0):
            if i < len(plan):
                page, name = plan[i]
                win.carousel.scroll_to(win.pages[page], False)
                if page == 1: win.refresh_checks()
                GLib.timeout_add(700, lambda: (snap(win, name), run(i + 1), False)[2])
            else:
                win.start_install()
                GLib.timeout_add(1500, lambda: (snap(win, "install"), False)[1])
                GLib.timeout_add(5200, lambda: (snap(win, "done"), self.quit(), False)[2])
        GLib.timeout_add(900, lambda: (run(), False)[1])
        self.hold()
        return 0

for scheme in (sys.argv[1:] or ["light"]):
    pass
ShotApp().run(["x"])
