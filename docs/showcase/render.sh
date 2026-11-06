#!/usr/bin/env bash
# Renders docs/images/*.png (1600x900) from showcase.html with headless Chrome/Chromium.
# Needs: google-chrome or chromium, python3 with Pillow.
set -euo pipefail
cd "$(dirname "$0")"
CHROME="$(command -v google-chrome || command -v chromium || command -v chromium-browser)"
TMP="$(mktemp -d)"
mkdir -p ../images/fa
for scene in hero states approve translate sessions ipsafety paused; do
  # headless Chrome keeps ~88px of window chrome, so render taller and crop
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size=1600,988 --virtual-time-budget=2000 \
    --screenshot="$TMP/$scene.png" "file://$PWD/showcase.html#$scene" >/dev/null 2>&1
  python3 -c "from PIL import Image; Image.open('$TMP/$scene.png').crop((0,0,1600,900)).save('../images/$scene.png', optimize=True)"
  echo "rendered docs/images/$scene.png"
  # Persian version (copy set in Lahzeh)
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size=1600,988 --virtual-time-budget=2000 \
    --screenshot="$TMP/$scene-fa.png" "file://$PWD/showcase.html?lang=fa#$scene" >/dev/null 2>&1
  python3 -c "from PIL import Image; Image.open('$TMP/$scene-fa.png').crop((0,0,1600,900)).save('../images/fa/$scene.png', optimize=True)"
  echo "rendered docs/images/fa/$scene.png"
done
rm -rf "$TMP"
