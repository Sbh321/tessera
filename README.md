# Tessera

> *tessera* (Latin) — a single small square tile in a mosaic.

A GNOME Shell extension that replaces the default workspace dots with
numbered square indicators, inspired by Hyprland's workspace bar:

```
Default GNOME:  ● ○ ○ ○ ○
Tessera:        [1] [2] [3] [4] [5]
```

Built for GNOME Shell 46 / Ubuntu 24.04 LTS. Only the *appearance* of the
workspace indicator changes — clicking, active-workspace tracking, dynamic
workspace count, and switch animations all remain exactly as GNOME defines
them; see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how that's
guaranteed by construction.

## Features

- Numbered square panel indicator, always visible (no collapsing into a
  dropdown menu at high workspace counts).
- Placeable on the left, center, or right of the panel (default: left).
- Hides GNOME's own built-in workspace dots (rendered inside the Activities
  button) by default, so only this indicator is shown — toggle off in
  Preferences if you want both.
- Click a square to switch to that workspace.
- `Super+1` .. `Super+9` to jump directly to a workspace — reliably, even
  on Ubuntu where both GNOME and Ubuntu Dock normally own those shortcuts
  (see Keybindings below).
- `Super+Left` / `Super+Right` to switch to the previous/next workspace.
- `Shift+Super+1` .. `Shift+Super+9` to move the focused window to that
  workspace and follow it.
- `Shift+Super+Left` / `Shift+Super+Right` to move the focused window
  into a brand-new workspace inserted beside the current one,
  Hyprland-style.
- Live preview during a 3-finger touchpad swipe: the active square tracks
  your fingers in real time across every workspace you pass through, and
  snaps to the final one the instant you let go (best-effort — see
  [`docs/GNOME_NOTES.md`](docs/GNOME_NOTES.md)).
- Fully configurable appearance: square size, spacing, border radius,
  padding, font size/weight, filled vs. outline style, and per-state
  colors. The active square's default color follows your Ubuntu
  Settings → Appearance accent color automatically; set a custom color in
  Preferences to override it.
- Respects GNOME light/dark theming by default.
- **Automatic tiling** (Hyprland dwindle-style): normal windows arrange
  themselves per workspace — one window fills the screen, two split
  50/50, further windows keep subdividing. Dialogs, minimized, and
  maximized windows float. Gaps are configurable; the whole feature can
  be switched off in Preferences.
- `Shift+Super+S` toggles a **stacked layout** per workspace: all tiled
  windows share the full content area under a row of browser-style tabs.

## Install

```sh
git clone https://github.com/Sbh321/tessera.git
cd tessera
./scripts/install.sh
```

Then enable it:

```sh
gnome-extensions enable tessera@sbh321.github.io
```

**Wayland note:** GNOME Shell only notices a *brand-new* extension after a
logout/login — the install script prints a reminder. Once it's been
enabled at least once, later updates don't need a relogin.

For local development instead of a one-shot install, see
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

## Keybindings

| Shortcut | Action |
|---|---|
| `Super+1` .. `Super+9` | Jump to workspace 1-9 |
| `Super+Left` | Previous workspace |
| `Super+Right` | Next workspace |
| `Shift+Super+1` .. `Shift+Super+9` | Move focused window to workspace 1-9 (and follow) |
| `Shift+Super+Left` | Move focused window to a new workspace inserted on the left |
| `Shift+Super+Right` | Move focused window to a new workspace inserted on the right |
| `Shift+Super+S` | Toggle stacked (tabbed) layout on the current workspace |

These accelerators collide with four sets of pre-existing defaults on a
stock Ubuntu install: GNOME's `Super+1..9` (switch to a pinned dash app),
GNOME's `Super+Left/Right` (snap a window to half-screen), GNOME's
`Shift+Super+Left/Right` (move window to the adjacent monitor), and
Ubuntu Dock's own `Super+1..0` app hot-keys including their Shift
variants. Enabling Tessera's keybindings (on by default, toggle in
Preferences) temporarily neutralizes all four and restores your exact
prior values when disabled. Pressing `Super+N` or `Shift+Super+N` for a
workspace that doesn't exist is a clean no-op — it never falls through to
launching a dock app. Every accelerator is also individually rebindable in
Preferences. See [`docs/GNOME_NOTES.md`](docs/GNOME_NOTES.md) for how each
conflict was found and verified, and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how the restore is kept
exact and reversible.

## Settings

Open via the Extensions app, or:

```sh
gnome-extensions prefs tessera@sbh321.github.io
```

Covers panel position, whether to hide GNOME's built-in Activities-button
dots, square size/spacing/radius/padding, font size/weight, filled vs.
outline style, active/inactive colors, whether to show GNOME's trailing
empty workspace, the keybindings master switch, and every individual
accelerator.

## Project layout

```
extension.js          Entry point — wires modules together, no logic itself
lib/                  workspaceIndicator.js, keybindingManager.js,
                      nativeIndicatorHider.js, accentColor.js,
                      gestureProgressTracker.js, settingsManager.js,
                      utils.js
prefs.js              Adwaita preferences window
stylesheet.css        Default appearance
schemas/              GSettings schema (source of truth for settings)
docs/                 ARCHITECTURE.md, DEVELOPMENT.md, ROADMAP.md,
                      GNOME_NOTES.md
scripts/              build.sh, install.sh, dev-symlink.sh
tests/                schema-validate.sh, MANUAL_TESTS.md
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design
rationale and [`docs/GNOME_NOTES.md`](docs/GNOME_NOTES.md) for the exact
GNOME APIs and version-specific findings this was built against.

## License

GPL-2.0-or-later.
