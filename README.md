# Tessera

> *tessera* (Latin) — a single small square tile in a mosaic.

A Hyprland-inspired **tiling workspace manager** for GNOME Shell:
automatic dwindle tiling, a stacked (tabbed) layout mode, numbered
workspace squares in the panel, and full Super-based keyboard control of
workspaces and windows — while staying a well-behaved GNOME extension
built on public APIs.

```
Panel:      [1] [2] [3] [4] [5]        (numbered workspace squares)

Windows:    +---------+---------+
            |         | Term    |      (automatic dwindle tiling:
            | Firefox +----+----+       1 window = 100%, 2 = 50/50,
            |         |File|Code|       each next window subdivides)
            +---------+----+----+
```

Tessera started as a numbered replacement for GNOME's workspace dots and
grew into a full tiling workspace manager. It brings the Hyprland
workflow to GNOME rather than replacing GNOME: every window and
workspace operation routes through the same public Mutter/Shell APIs
GNOME itself uses, everything is reversible on disable, and windows
GNOME says should float (dialogs, utilities, minimized/maximized
windows) float. Built for GNOME Shell 46 / Ubuntu 24.04 LTS — see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design.

## Features

### Tiling

- **Automatic dwindle tiling**, Hyprland's default layout: one window
  fills the work area, two split 50/50, each further window keeps
  subdividing — per workspace and per monitor, fully automatic as
  windows open, close, move, minimize, or change workspace.
- **Focus-aware insertion**, Hyprland's default behavior: a new window
  splits the *focused* window's tile — focus the left window and the
  newcomer opens inside the left half; the right side never moves.
  Closing a window likewise hands its space back to its neighbor alone,
  and a minimized or maximized window returns to the exact slot it left.
- **Stacked (tabbed) layout mode** per workspace (`Shift+Super+S`): all
  tiled windows share the full content area under a row of browser-style
  tabs with live titles and icons — Hyprland's stacked layout. Needs at
  least two windows: the toggle no-ops on a single-window workspace, and
  a stacked workspace that drops to one window (closed or moved away)
  reverts to tiled on its own.
- Windows GNOME wants floating stay floating: dialogs, utility and
  splash windows, minimized and user-maximized windows. Fullscreen
  suspends tiling until it ends. Apps that *open* maximized (browsers,
  editors) are tiled anyway.
- Configurable inner/outer gaps; panel and dock are never overlapped
  (work-area aware). The whole tiling system can be switched off in
  Preferences, leaving just the workspace manager.
- **Focus border**: a Hyprland-style hint border around the currently
  focused window, on every workspace and monitor — independent of
  tiling, so floating windows get one too. Color, width, and radius are
  configurable in Preferences; the default color follows your accent
  color, same logic as the active workspace square.
- **Top panel auto-hide** (off by default): the GNOME top panel slides
  off-screen like a dock and windows reclaim its space; it slides back
  in when the pointer touches the top edge, while the Super key is
  held, in the Activities overview, while a panel menu is open, and
  while the current workspace is empty.
- **Top panel background opacity**: a Preferences slider from the
  normal solid background (100%, the default) down to fully
  transparent. Panel text and icons are unaffected, and it works with
  or without auto-hide.

### Workspaces & windows

- `Super+1` .. `Super+9` to jump directly to a workspace — reliably, even
  on Ubuntu where both GNOME and Ubuntu Dock normally own those shortcuts
  (see Keybindings below).
- `Super+Left` / `Super+Right` to switch to the previous/next workspace.
- `Shift+Super+1` .. `Shift+Super+9` to move the focused window to that
  workspace and follow it.
- `Shift+Super+Left` / `Shift+Super+Right` to move the focused window
  into a brand-new workspace inserted beside the current one,
  Hyprland-style.
- Full dynamic-workspaces support — everything integrates with GNOME's
  own workspace model instead of replacing it.

### Panel indicator

- Numbered square indicator, always visible (no collapsing into a
  dropdown at high workspace counts); click a square to switch.
  Placeable left/center/right; GNOME's own Activities-button dots are
  hidden by default (toggleable).
- Live preview during a 3-finger touchpad swipe: the active square tracks
  your fingers in real time across every workspace you pass through, and
  snaps to the final one the instant you let go (best-effort — see
  [`docs/GNOME_NOTES.md`](docs/GNOME_NOTES.md)).
- Label styles: numbers `1 2 3` (default), Roman `I II III`, Devanagari
  digits `१ २ ३`, letters `A B C` / `a b c`, Devanagari letters
  `क ख ग`, or plain dots `●` — switchable in Preferences.
- Fully configurable appearance: square size, spacing, border radius,
  padding, font size/weight, filled vs. outline style, and per-state
  colors. The active square's default color follows your Ubuntu
  Settings → Appearance accent color automatically; set a custom color in
  Preferences to override it. Respects GNOME light/dark theming.

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

Covers tiling on/off and gaps, the focus border's on/off switch, color,
width, and radius, top-panel auto-hide (with adjustable slide duration)
and background opacity, panel position, whether to hide
GNOME's built-in Activities-button dots, square
size/spacing/radius/padding (with Small/Medium/Large/XL one-click
presets), label style, font size/weight, filled vs. outline style,
active/inactive colors, whether to show GNOME's trailing empty
workspace, the keybindings master switch, and every individual
accelerator.

## Project layout

```
extension.js          Entry point — wires modules together, no logic itself
lib/                  workspaceIndicator.js, keybindingManager.js,
                      windowMover.js, focusBorder.js, panelAutoHide.js,
                      nativeIndicatorHider.js, accentColor.js,
                      gestureProgressTracker.js, settingsManager.js,
                      utils.js
lib/tiling/           The tiling subsystem: windowFilter.js,
                      layoutEngine.js (pure layout strategies),
                      stackTabBar.js, tilingManager.js
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
