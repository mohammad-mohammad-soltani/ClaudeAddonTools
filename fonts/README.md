# Persian font

Put the font for Persian text here (`.woff2`, `.ttf` or `.otf`) and run `./install.sh`.
It is installed for your user only, in `~/.local/share/fonts/claude-status/`.

The extension uses **IRANSansX**. IRANSansX is a commercial font, so it isn't
included in this repository; use your own licensed copy. Without it, Persian text
falls back to **Vazirmatn** (free, SIL OFL) or Noto Sans Arabic if installed:

```bash
sudo apt install fonts-vazirmatn      # Ubuntu / Debian
sudo dnf install vazirmatn-fonts      # Fedora
```
