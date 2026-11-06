# Changelog

## 1.0.1 — 2026-11-06

- When one session finishes or needs you while another is still running, the badge briefly announces it by name ("meydan done", "meydan needs you") with a short animation

## 1.0.0 — 2026-11-06

First release.

- Top-bar badge with four states: thinking, needs approval, done, idle
- Shows the project, the model and a timer for the current turn
- Request card that drops out of the badge: Allow, Always allow, Deny, or hand back to the terminal
- Session panel grouped by what needs you, what's working and what's finished
- Persian translation of questions and options through Claude Haiku (Claude Code CLI)
- Claude IP Safety: shows your IP location in the panel; pauses every Claude Code session on an unsupported IP and resumes them on **Dismiss and continue**
- Liquid open and close animations
- `.deb` package with a graphical setup wizard (GTK 4 + libadwaita)
- Script installer for other distributions with GNOME 45–49
