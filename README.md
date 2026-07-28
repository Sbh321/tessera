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

### Launcher

- **A native Spotlight/Raycast-style launcher** on `Super+Space` (off by
  default — turn it on in Preferences → Launcher). Not a wrapper around
  Rofi, Walker or Ulauncher: it runs inside GNOME Shell on public APIs,
  like everything else here.
- **One search box, every kind of result**, merged and ranked together:
  installed applications (and their `.desktop` actions like *New Private
  Window*), open windows, GNOME Settings panels, installed extensions,
  arithmetic, shell commands, an opt-in clipboard history, and every
  action Tessera itself can perform.
- **Matching that understands how people type**: exact, prefix, word
  (`code` → Visual Studio **Code**), initials (`vsc`, `gimp` → GNU Image
  Manipulation Program), substring, subsequence (`ff` → Firefox), and
  bounded typo tolerance — in that strict order, so a weak match can
  never outrank a strong one.
- **It learns.** Results are re-ranked by how often *and* how recently
  you pick them, whether they are pinned (`Ctrl+D`), and what is relevant
  right now — a window on the current workspace, an app that is already
  running.
- **Tessera's own features are searchable**: `tile`, `stack`, `float`,
  `border`, `panel`, `port`, `color`… plus an argument grammar —
  `workspace 12`, `move firefox 4` — that reaches workspaces beyond the
  `Super+1..9` bindings entirely.
- **Fully keyboard-driven** (arrows, `Ctrl+N`/`P`, `Tab` between
  sections, `Alt+1..9` to jump straight to a result, `Ctrl+Enter` /
  `Shift+Enter` for each result's alternate actions), with mouse support
  and a hint footer that shows what the current result's alternates do.
- **Native look**: follows your GNOME light/dark preference and accent
  color, rounded, animated (and honours GNOME's reduce-animations
  setting). Width, height, corner radius, font size, icons, descriptions
  and a compact density mode are all configurable. Background blur is
  available but off by default — the shell's blur effect always fills a
  rectangle and cannot be clipped to the rounded corners.
- Commands never go through a shell and the calculator has no `eval()` —
  see [`docs/LAUNCHER.md`](docs/LAUNCHER.md), which documents the whole
  subsystem: architecture, providers, ranking, adding your own provider,
  security, performance and limitations.

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
- **Per-window floating** (`Shift+Super+V`): pop the focused window out
  of the layout so it floats — centered and stacked above the tiled
  windows, freely movable and resizable — and press again to re-tile it.
  Hyprland's `togglefloating`, the pop-out-and-float feel of Omarchy.
  It's a per-window choice, not a separate layout mode, and the centered
  size (default 65% of the work area) is configurable in Preferences.
- Windows GNOME wants floating stay floating: dialogs, utility and
  splash windows, minimized and user-maximized windows. Fullscreen
  suspends tiling until it ends. Apps that *open* maximized (browsers,
  editors) are tiled anyway.
- Configurable inner/outer gaps; panel and dock are never overlapped
  (work-area aware). The whole tiling system can be switched off in
  Preferences, leaving just the workspace manager.
- **Focus border**: a Hyprland-style hint border around the currently
  focused window, on every workspace and monitor — independent of
  tiling, so floating windows get one too. Color, width, and corner
  radius are configurable in Preferences (the radius is applied uniformly
  to every window); the default color follows your accent color, same
  logic as the active workspace square.
- **Top panel auto-hide** (off by default): the GNOME top panel slides
  off-screen like a dock and windows reclaim its space; it slides back
  in when the pointer touches the top edge, when the reveal keybinding
  (default `Super+Z`, customizable) toggles it open, in the Activities
  overview, while a panel menu is open, and while the current workspace
  is empty.
- **Top panel background opacity**: a Preferences slider from the
  normal solid background (100%, the default) down to fully
  transparent. Panel text and icons are unaffected, and it works with
  or without auto-hide.
- **Quick menu** (off by default): an optional button on the right of
  the top panel with a **Overview | Tools | Keys** tabbed popup.
  *Overview* has the most-used quick toggles (tiling, focus border,
  panel auto-hide), inner/outer gap steppers, and a shortcut to the
  full settings. *Tools* has a **port killer** (`Shift+Super+P`, SIGTERMs
  whatever is listening on a TCP port) and a **color picker**
  (`Shift+Super+C`, a large magnified lens; click to copy the pixel's
  hex to the clipboard), each keeping a history of the last 20 colors
  picked / ports killed. *Keys* is a read-only reference of every
  configured keybinding. Both tool shortcuts work whether or not the
  menu is shown; toggle the menu on in Preferences → Appearance →
  Quick Menu.

### Workspaces & windows

- `Super+1` .. `Super+9` to jump directly to a workspace — reliably, even
  on Ubuntu where both GNOME and Ubuntu Dock normally own those shortcuts
  (see Keybindings below).
- `Super+0` / `Shift+Super+0` for the **trailing workspace** — the empty
  one GNOME always keeps at the end of the strip. Jump to a blank
  workspace, or send the focused window off to a fresh one, without
  counting how many you currently have.
- `Super+Left` / `Super+Right` to switch to the previous/next workspace.
- `Shift+Super+1` .. `Shift+Super+9` to move the focused window to that
  workspace and follow it.
- `Shift+Super+Left` / `Shift+Super+Right` to move the focused window
  into a brand-new workspace inserted beside the current one,
  Hyprland-style.
- `Shift+Alt+1` .. `Shift+Alt+9` to **swap the whole current workspace
  with another** — all windows exchange places and the view follows your
  content to the target. If the target is empty your windows simply move
  there (and the emptied workspace is culled); does nothing if the
  current workspace is empty.
- **One app per workspace**, optional (Preferences → Tiling → New
  Windows): every newly opened application window is moved onto a
  workspace of its own and the view follows it there. A second toggle
  chooses where that workspace comes from — the trailing workspace at the
  end of the strip (default, keeps the order chronological), or a
  brand-new workspace inserted right beside the current one (keeps
  related work adjacent). Dialogs, popups and pinned windows are never
  moved, and an empty workspace that already exists is always preferred
  over creating another one — a window opening on an empty workspace
  stays put, and one that opens elsewhere while you are looking at an
  empty workspace comes to you.
- Full dynamic-workspaces support — everything integrates with GNOME's
  own workspace model instead of replacing it.

### Panel indicator

- Numbered square indicator, always visible (no collapsing into a
  dropdown at high workspace counts); click a square to switch.
  Placeable left/center/right; GNOME's own Activities button is hidden
  by default (toggleable), and the indicator takes over its job —
  clicking the space around the squares toggles the Activities
  overview, scrolling over the indicator switches workspaces.
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

## Supported GNOME Shell versions

| GNOME Shell | Status |
| --- | --- |
| 46 | ✅ Supported — the version this was built and verified on (Ubuntu 24.04 LTS, Wayland) |
| 47 / 48 | ❌ Not yet — untested and not declared in `metadata.json`; the porting checklist lives in [`docs/GNOME_NOTES.md`](docs/GNOME_NOTES.md) ("Porting to GNOME 47/48") |
| 45 | ❌ Not supported — same modern (ESM) extension format, so the code would load, but every shell internal this extension relies on was verified against 46's extracted source only |
| 44 and earlier | ❌ Cannot work — GNOME 45 switched extensions to ES modules; this extension is ESM-only, and pre-45 shells use the old incompatible `imports.*` extension format |

Only the versions declared in `metadata.json`'s `shell-version` (currently
`["46"]`) will load — GNOME Shell refuses anything else unless
version validation is disabled. Several of this extension's features were
verified against Shell 46's actual extracted source (see
[`docs/GNOME_NOTES.md`](docs/GNOME_NOTES.md)), so new versions are added
there deliberately after re-verification, not by just widening the list.

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
| `Super+0` | Jump to the trailing workspace (the empty one at the end) |
| `Super+Left` | Previous workspace |
| `Super+Right` | Next workspace |
| `Shift+Super+1` .. `Shift+Super+9` | Move focused window to workspace 1-9 (and follow) |
| `Shift+Super+0` | Move focused window to the trailing workspace (and follow) |
| `Shift+Super+Left` | Move focused window to a new workspace inserted on the left |
| `Shift+Super+Right` | Move focused window to a new workspace inserted on the right |
| `Shift+Super+S` | Toggle stacked (tabbed) layout on the current workspace |
| `Shift+Super+V` | Toggle floating for the focused window |
| `Shift+Super+F` | Toggle maximize for the focused window (keeps the panel) |
| `Super+F` | Toggle true fullscreen for the focused window (covers the panel) |
| `Super+Z` | Reveal / hide the auto-hidden top panel (only while auto-hide is on) |
| `Super+Space` | Open / close the launcher (only while the launcher is enabled) |

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
Preferences by clicking its row and pressing the new combo (Backspace
clears, Esc cancels); combos already grabbed by the compositor or this
extension are captured correctly, and any duplicate binding is flagged.
The launcher's `Super+Space` is a fifth collision — GNOME's
`switch-input-source` — and the only one handled *conditionally*: those
keys are cleared only while the launcher is enabled **and** its
accelerator really is `Super+Space`, so leaving the launcher off, or
rebinding it, leaves keyboard-layout switching completely untouched.

See [`docs/GNOME_NOTES.md`](docs/GNOME_NOTES.md) for how each
conflict was found and verified, and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how the restore is kept
exact and reversible.

## Settings

Open via the Extensions app, or:

```sh
gnome-extensions prefs tessera@sbh321.github.io
```

The **Launcher** page covers its on/off switch and shortcut, which
sources to search, the clipboard history and its size, typo tolerance and
search delay, every appearance option (width, height, corner radius, font
size, compact mode, icons, descriptions, animations, blur, light/dark and
accent following), and buttons to forget the ranking history, the pins,
or the clipboard history. The rest of the window covers tiling on/off and
gaps, the focus border's on/off switch, color,
width, and radius, top-panel auto-hide (with adjustable slide duration)
and background opacity, panel position, whether to hide
GNOME's built-in Activities button, square
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
lib/launcher/         The launcher subsystem: searchController.js,
                      fuzzyMatcher.js + calculatorEngine.js (pure,
                      unit-tested), one file per provider,
                      launcherPopup.js / launcherUI.js / theme.js
prefs.js              Adwaita preferences window
stylesheet.css        Default appearance
schemas/              GSettings schema (source of truth for settings)
docs/                 ARCHITECTURE.md, LAUNCHER.md, DEVELOPMENT.md,
                      ROADMAP.md, GNOME_NOTES.md
scripts/              build.sh, install.sh, dev-symlink.sh
tests/                run-tests.sh, schema-validate.sh,
                      launcher-engine-test.js, MANUAL_TESTS.md
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design
rationale and [`docs/GNOME_NOTES.md`](docs/GNOME_NOTES.md) for the exact
GNOME APIs and version-specific findings this was built against.

## License

GPL-2.0-or-later — see [`LICENSE`](LICENSE) for the full text. Every
source file carries a matching SPDX header.
