#!/usr/bin/env bash
# Claude Status — installer
# Works on any Linux desktop running GNOME Shell 45+ (Ubuntu, Fedora, Debian,
# Arch, openSUSE, Pop!_OS 24.04+, Zorin, …). Installs per-user, no sudo.
#
#   ./install.sh            install / update
#   ./install.sh --dev      symlink the extension (for hacking on it)
#   ./install.sh --uninstall
set -euo pipefail

UUID="claude-status@mohammad-soltani"
OLD_UUIDS=("claude-status@system-claude")
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
EXT_DIR="$DATA_HOME/gnome-shell/extensions"
APP_DIR="$DATA_HOME/claude-status"
HOOK="$APP_DIR/claude-status-hook.py"
FONT_DIR="$DATA_HOME/fonts/claude-status"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SETTINGS="$CLAUDE_DIR/settings.json"

c_ok=$'\e[32m'; c_warn=$'\e[33m'; c_err=$'\e[31m'; c_dim=$'\e[2m'; c_bold=$'\e[1m'; c_off=$'\e[0m'
ok()   { printf '  %s✓%s %s\n' "$c_ok" "$c_off" "$*"; }
warn() { printf '  %s!%s %s\n' "$c_warn" "$c_off" "$*"; }
die()  { printf '  %s✗ %s%s\n' "$c_err" "$*" "$c_off" >&2; exit 1; }

MODE="install"
case "${1:-}" in
  --uninstall|-u) MODE="uninstall" ;;
  --dev)          MODE="dev" ;;
  ""|--install)   ;;
  -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
  *) die "Unknown option: $1 (try --help)" ;;
esac

# --------------------------------------------------------------- settings.json
# Adds (or removes) our hook entries without touching anything else.
edit_settings() {
  local action="$1"
  python3 - "$SETTINGS" "$HOOK" "$action" <<'PY'
import json, os, sys
path, hook, action = sys.argv[1:4]
cfg = {}
if os.path.exists(path):
    with open(path, encoding="utf-8") as f:
        txt = f.read().strip()
    cfg = json.loads(txt) if txt else {}
hooks = cfg.setdefault("hooks", {})
MARK = "claude-status-hook.py"
for ev in list(hooks):
    groups = hooks[ev]
    for g in groups:
        g["hooks"] = [h for h in g.get("hooks", []) if MARK not in h.get("command", "")]
    hooks[ev] = [g for g in groups if g.get("hooks")]
    if not hooks[ev]:
        del hooks[ev]
if action == "add":
    events = {
        "SessionStart": 5, "SessionEnd": 5, "UserPromptSubmit": 5,
        "PreToolUse": 5, "PostToolUse": 5, "Notification": 5, "Stop": 5,
        # waits for your answer on the top-bar card, then hands back to the terminal
        "PermissionRequest": 120,
    }
    for ev, timeout in events.items():
        entry = {"hooks": [{"type": "command", "command": f'python3 "{hook}" {ev}', "timeout": timeout}]}
        if ev in ("PreToolUse", "PostToolUse", "PermissionRequest", "Notification"):
            entry["matcher"] = "*"
        hooks.setdefault(ev, []).append(entry)
if not hooks:
    cfg.pop("hooks", None)
os.makedirs(os.path.dirname(path), exist_ok=True)
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write("\n")
os.replace(tmp, path)
PY
}

# --------------------------------------------------------------- uninstall
if [[ "$MODE" == "uninstall" ]]; then
  printf '\n%sRemoving Claude Status%s\n' "$c_bold" "$c_off"
  command -v gnome-extensions >/dev/null && gnome-extensions disable "$UUID" 2>/dev/null || true
  rm -rf "$EXT_DIR/$UUID" "$APP_DIR" "$FONT_DIR" "${XDG_CACHE_HOME:-$HOME/.cache}/claude-status"
  ok "extension and data removed"
  if [[ -f "$SETTINGS" ]] && command -v python3 >/dev/null; then
    edit_settings remove && ok "hooks removed from $SETTINGS"
  fi
  command -v fc-cache >/dev/null && fc-cache -f "$DATA_HOME/fonts" >/dev/null 2>&1 || true
  printf '\n  Log out and back in to remove the badge from the top bar.\n\n'
  exit 0
fi

# --------------------------------------------------------------- checks
printf '\n%sInstalling Claude Status%s %s(top-bar badge for Claude Code)%s\n\n' "$c_bold" "$c_off" "$c_dim" "$c_off"

command -v python3 >/dev/null || die "python3 is required. Install it with your package manager (apt/dnf/pacman/zypper install python3)."

if command -v gnome-shell >/dev/null; then
  GS_VER="$(gnome-shell --version 2>/dev/null | grep -oE '[0-9]+' | head -1 || echo 0)"
  if (( GS_VER < 45 )); then
    die "GNOME Shell $GS_VER found; Claude Status needs GNOME 45 or newer (Ubuntu 24.04+, Fedora 39+, Debian 13+)."
  fi
  ok "GNOME Shell $GS_VER"
else
  warn "gnome-shell not found. The hooks will be installed, but the badge needs a GNOME desktop."
fi

if [[ ! -d "$CLAUDE_DIR" ]]; then
  warn "No $CLAUDE_DIR yet. Run Claude Code once; the hooks below will be ready for it."
fi

# --------------------------------------------------------------- extension
mkdir -p "$EXT_DIR" "$APP_DIR"
for old in "${OLD_UUIDS[@]}"; do
  command -v gnome-extensions >/dev/null && gnome-extensions disable "$old" 2>/dev/null || true
  rm -rf "${EXT_DIR:?}/$old"
done
rm -rf "${EXT_DIR:?}/$UUID"
if [[ "$MODE" == "dev" ]]; then
  ln -s "$HERE/extension/$UUID" "$EXT_DIR/$UUID"
  ok "extension linked (dev mode) → $EXT_DIR/$UUID"
else
  cp -r "$HERE/extension/$UUID" "$EXT_DIR/$UUID"
  ok "extension installed → $EXT_DIR/$UUID"
fi

# --------------------------------------------------------------- hook
install -m 0755 "$HERE/hooks/claude-status-hook.py" "$HOOK"
ok "hook installed → $HOOK"

if [[ -f "$SETTINGS" ]]; then
  cp "$SETTINGS" "$SETTINGS.bak-claude-status"
fi
edit_settings add
ok "hooks registered in $SETTINGS ${c_dim}(backup: settings.json.bak-claude-status)${c_off}"

# --------------------------------------------------------------- Persian font
shopt -s nullglob
fonts=("$HERE"/fonts/*.{ttf,otf,woff2})
if (( ${#fonts[@]} )); then
  mkdir -p "$FONT_DIR"
  cp "${fonts[@]}" "$FONT_DIR/"
  command -v fc-cache >/dev/null && fc-cache -f "$FONT_DIR" >/dev/null 2>&1 || true
  ok "Persian font installed"
else
  warn "No font in ./fonts. Persian text will use Vazirmatn or Noto Sans Arabic if you have them."
fi

# --------------------------------------------------------------- translation
CLAUDE_BIN="$(command -v claude || true)"
if [[ -z "$CLAUDE_BIN" ]]; then
  CLAUDE_BIN="$(ls -d "$HOME"/.vscode*/extensions/anthropic.claude-code-*/resources/native-binary/claude 2>/dev/null | sort -V | tail -1 || true)"
fi
if [[ -n "$CLAUDE_BIN" ]]; then
  ok "translation via Claude Haiku → ${c_dim}$CLAUDE_BIN${c_off}"
else
  warn "Claude Code CLI not found; the Translate button needs it (npm i -g @anthropic-ai/claude-code)."
fi

# --------------------------------------------------------------- enable
printf '\n'
if command -v gnome-extensions >/dev/null && gnome-extensions enable "$UUID" 2>/dev/null; then
  ok "extension enabled"
  if [[ "${XDG_SESSION_TYPE:-}" == "x11" ]]; then
    printf '\n  Press %sAlt+F2%s, type %sr%s and press Enter to reload GNOME Shell.\n' "$c_bold" "$c_off" "$c_bold" "$c_off"
  else
    printf '\n  %sLog out and back in%s so GNOME Shell loads the badge.\n' "$c_bold" "$c_off"
  fi
else
  printf '  %sNext:%s log out and back in, then run:\n\n      gnome-extensions enable %s\n' "$c_bold" "$c_off" "$UUID"
fi
printf '  Restart any open Claude Code sessions so they pick up the hooks.\n\n'
