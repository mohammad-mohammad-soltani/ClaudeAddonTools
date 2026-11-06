#!/usr/bin/env bash
# Builds dist/claude-status_<version>_all.deb
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(python3 -c "import json;print('1.0.' + str(json.load(open('$ROOT/extension/claude-status@mohammad-soltani/metadata.json'))['version'] - 1))")"
UUID="claude-status@mohammad-soltani"
APP="io.github.mohammad_soltani.ClaudeStatus"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

install -d "$STAGE/DEBIAN" \
  "$STAGE/usr/share/gnome-shell/extensions" \
  "$STAGE/usr/share/claude-status" \
  "$STAGE/usr/bin" \
  "$STAGE/usr/share/applications" \
  "$STAGE/usr/share/icons/hicolor/scalable/apps" \
  "$STAGE/etc/xdg/autostart" \
  "$STAGE/usr/share/doc/claude-status"

cp -r "$ROOT/extension/$UUID" "$STAGE/usr/share/gnome-shell/extensions/$UUID"
install -m 0755 "$ROOT/hooks/claude-status-hook.py" "$STAGE/usr/share/claude-status/claude-status-hook.py"
install -m 0644 "$ROOT/packaging/setup/claude-status.svg" "$STAGE/usr/share/claude-status/claude-status.svg"
install -m 0644 "$ROOT/packaging/setup/claude-status.svg" "$STAGE/usr/share/icons/hicolor/scalable/apps/$APP.svg"
install -m 0755 "$ROOT/packaging/setup/claude-status-setup" "$STAGE/usr/bin/claude-status-setup"
install -m 0644 "$ROOT/packaging/setup/$APP.desktop" "$STAGE/usr/share/applications/$APP.desktop"
install -m 0644 "$ROOT/packaging/setup/claude-status-setup-autostart.desktop" "$STAGE/etc/xdg/autostart/claude-status-setup.desktop"
install -m 0644 "$ROOT/LICENSE" "$STAGE/usr/share/doc/claude-status/copyright"
gzip -9n -c "$ROOT/CHANGELOG.md" > "$STAGE/usr/share/doc/claude-status/changelog.gz"

SIZE="$(du -sk --exclude=DEBIAN "$STAGE" | cut -f1)"
sed -e "s/@VERSION@/$VERSION/" -e "s/@SIZE@/$SIZE/" "$ROOT/packaging/deb/control" > "$STAGE/DEBIAN/control"
install -m 0755 "$ROOT/packaging/deb/postinst" "$ROOT/packaging/deb/postrm" "$STAGE/DEBIAN/"
find "$STAGE/usr" -type d -exec chmod 0755 {} +
find "$STAGE/usr/share/gnome-shell" -type f -exec chmod 0644 {} +

mkdir -p "$ROOT/dist"
OUT="$ROOT/dist/claude-status_${VERSION}_all.deb"
dpkg-deb --root-owner-group -Zxz --build "$STAGE" "$OUT" >/dev/null
echo "built $OUT ($(du -h "$OUT" | cut -f1))"
