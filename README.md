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
- **Browser tabs, inside the window list.** With the Tessera Companion
  extension in Chrome/Chromium, each browser window shows its tab count,
  expands (`→`/`←` or its chevron) to list its tabs with their favicons,
  marked with the browser they belong to, and every tab is
  searchable directly by title, host and URL — Enter switches to exactly
  that tab, never a neighbour, even after tabs are reordered, moved
  between windows or closed. Event-driven, local-only, nothing persisted;
  Wayland-native. See [`docs/BROWSER_TABS.md`](docs/BROWSER_TABS.md).
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
- **Three layout modes, one default plus per-workspace choice.** Every
  workspace is *tiled*, *stacked* or *floating*. The **default layout**
  (Preferences → Tiling, the panel menu's Tile | Stack | Float row, or
  the launcher) is what every workspace follows and what new workspaces
  start in; changing it switches every workspace and every open window
  at once. Any single workspace can be switched on its own:
  `Shift+Super+T` tiles it, `Shift+Super+S` stacks it, `Shift+Super+V`
  floats it — and pressing the key of the mode it is already in returns
  it to the default (so with the tiled default, `Shift+Super+S` toggles
  stacking on and off, as it always has).
- **Stacked (tabbed) layout**: all tiled windows share the full content
  area under a row of browser-style tabs — Hyprland's stacked layout.
  Tabs are uniform (equal widths, capped, titles ellipsized like a
  browser's, so a long title never crowds its neighbours), each has a
  close button, a middle click or a three-finger touchpad tap closes a
  tab, a window asking for attention tints its tab, and the row scrolls
  once tabs no longer fit. Stacking is a group posture: a stacked
  workspace with a single window lays out as tiled (full area, no
  one-tab bar) and the tab bar appears the moment a second window opens.
- **Floating layout**: the mode where Tessera steps aside. On a floating
  workspace windows behave exactly as on stock GNOME — they open where
  GNOME puts them, stay maximized if the app says so, and are never
  moved, resized or snapped back — while every other workspace keeps
  its layout. Switch back and the layout the workspace had comes back.
  Not to be confused with per-window floating, below.
- **Directional focus and movement**, Hyprland's `movefocus` and
  `movewindow`: `Ctrl+Super+Arrows` focus the window in that direction
  on screen (tiles, floating windows and other monitors alike; on a
  stacked workspace, left and right step through the tabs), and
  `Ctrl+Shift+Super+Arrows` move the focused window that way — swapping
  it with the neighbouring tile, or moving its tab along the row.
- **Drag to swap, drag to resize**: drop a tiled window onto another
  tile with the mouse and the two swap places; drag a tiled window's
  edge and the split it sits on keeps the new size (the neighbour takes
  the rest). Drops over nothing and edges on the screen border snap
  back as before.
- **Per-window floating** (`Shift+Super+D`): pop the focused window out
  of the layout so it floats — centered and stacked above the tiled
  windows, freely movable and resizable — and press again to re-tile it.
  Hyprland's `togglefloating`, the pop-out-and-float feel of Omarchy.
  It's a per-window choice, orthogonal to the workspace's layout mode,
  and the centered size (default 65% of the work area) is configurable
  in Preferences.
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
| `Shift+Super+T` | Tile the current workspace (again: back to the default layout) |
| `Shift+Super+S` | Stack the current workspace (again: back to the default layout) |
| `Shift+Super+V` | Float the current workspace — stock GNOME behaviour there (again: back to the default layout) |
| `Shift+Super+D` | Toggle floating for the focused window |
| `Ctrl+Super+Left/Right/Up/Down` | Focus the window in that direction (on a stacked workspace, left/right step through tabs) |
| `Ctrl+Shift+Super+Left/Right/Up/Down` | Move the focused window that way: swap with the neighbouring tile, or move its tab along the row |
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
The layout and directional shortcuts (`Shift+Super+S/T/V/D`,
`Ctrl+Super+Arrows`, `Ctrl+Shift+Super+Arrows`) collide with nothing on
a stock install and clear nothing. The vim-style `Super+H/J/K/L` set was
deliberately not used for the directional keys: `Super+H` is GNOME's
minimize and `Super+L` locks the screen.

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
                      launcherPopup.js / launcherUI.js / theme.js,
                      browser*.js (the browser tab link)
companion/            Tessera Companion, the browser extension (modules/)
native-host/          The Native Messaging relay (GJS), registered
                      from Preferences
prefs.js              Adwaita preferences window
stylesheet.css        Default appearance
schemas/              GSettings schema (source of truth for settings)
docs/                 ARCHITECTURE.md, LAUNCHER.md, BROWSER_TABS.md,
                      DEVELOPMENT.md, ROADMAP.md, GNOME_NOTES.md
scripts/              build.sh, install.sh, dev-symlink.sh
tests/                run-tests.sh, schema-validate.sh, the launcher
                      engine / browser tab / companion / relay /
                      installer tests, MANUAL_TESTS.md
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design
rationale and [`docs/GNOME_NOTES.md`](docs/GNOME_NOTES.md) for the exact
GNOME APIs and version-specific findings this was built against.

## License

GPL-2.0-or-later — see [`LICENSE`](LICENSE) for the full text. Every
source file carries a matching SPDX header.
