# GNOME Notes

Environment-specific findings this extension's design is based on, and what
to re-check when porting to a new GNOME Shell version. Recorded so a future
port doesn't have to rediscover any of this from scratch.

## Environment this was built against

- GNOME Shell 46.0
- Ubuntu 24.04.4 LTS
- Wayland session
- GJS 1.80.2
- `org.gnome.mutter dynamic-workspaces`: `true`
- `org.gnome.mutter workspaces-only-on-primary`: `true`

## Ubuntu's accent color mechanism

Ubuntu's Settings → Appearance panel has an accent-color picker, but on this
GNOME version it is **not** backed by a standalone `accent-color` GSettings
key -- confirmed directly:

```sh
$ gsettings list-keys org.gnome.desktop.interface | grep accent
(no output)
```

It works by switching `org.gnome.desktop.interface gtk-theme` between Yaru
color variants instead (e.g. `Yaru-red-dark`). Each variant's real accent
hex was extracted from its own compiled GTK4 theme resource rather than
guessed, since the values aren't otherwise documented anywhere reachable
from this project:

```sh
for d in /usr/share/themes/Yaru*; do
  name=$(basename "$d")
  gresource_file="$d/gtk-4.0/gtk.gresource"
  path=$(gresource list "$gresource_file" | grep "4.0/gtk.css$")
  gresource extract "$gresource_file" "$path" \
    | grep -o "@define-color theme_selected_bg_color [^;]*;" \
    | sed "s/^/$name: /"
done
```

Which produced the palette hardcoded in `lib/accentColor.js`:

| Variant | Hex |
|---|---|
| Yaru (default/orange) | `#E95420` |
| Yaru-bark | `#787859` |
| Yaru-blue | `#0073E5` |
| Yaru-magenta | `#B34CB3` |
| Yaru-olive | `#4B8501` |
| Yaru-prussiangreen | `#308280` |
| Yaru-purple | `#7764D8` |
| Yaru-red | `#DA3450` |
| Yaru-sage | `#657B69` |
| Yaru-viridian | `#03875B` |

(the `-dark` suffix on each doesn't change the accent hex, only the
light/dark chrome around it). `lib/accentColor.js` reads `gtk-theme`,
strips a trailing `-dark`, and looks up the remaining name in this table;
any theme that isn't a recognized Yaru variant resolves to `null`, and
`lib/workspaceIndicator.js` falls back to `stylesheet.css`'s hardcoded
`#3584e4` in that case. This is read-only -- nothing in this project ever
writes to `org.gnome.desktop.interface`.

## Where GNOME's own workspace dots come from

There are actually *two* independent sources of workspace dots on this
install, and the first draft of this document only found one of them.

**1. The bundled `workspace-indicator` extension** (disabled by default).
Ships as a *disabled-by-default* bundled extension:
`workspace-indicator@gnome-shell-extensions.gcampax.github.com`, installed
at
`/usr/share/gnome-shell/extensions/workspace-indicator@gnome-shell-extensions.gcampax.github.com/extension.js`.

**2. GNOME Shell 46's own Activities button** (always present, not an
extension). This is the one this project initially missed, and the one a
real user actually ran into: the core `js/ui/panel.js` `ActivitiesButton`
renders small dots (style class `.workspace-dot`) representing each
workspace directly inside the Activities button, with the active one drawn
as a wider capsule shape. Since `js/ui/panel.js` is compiled into a
`gresource` and not present as loose source on this system (see "Things
that were deliberately NOT assumed" below), this could not be confirmed by
reading source directly. It was instead confirmed empirically:

1. Looking Glass (`Alt+F2`, `lg`) → the picker tool (`inspect(x, y)`,
   clicking the widget) reported the actor's accessible name as
   `panelActivities`.
2. Grepping all installed extensions for that string turned up a match in
   `just-perfection-desktop@just-perfection`'s `stylesheet.css`:
   `.just-perfection-api-accent-color-icon #panelActivities .workspace-dot`
   — Just Perfection merely *recolors* these dots when its "accent color
   icon" option is on; it doesn't create them. That confirmed `.workspace-dot`
   is a real, native style class on the Activities button itself.

`lib/nativeIndicatorHider.js` hides these by adding a marker style class to
`Main.panel` (a public, stable actor reference) and collapsing
`.workspace-dot` to zero size via this extension's own `stylesheet.css` —
see [`ARCHITECTURE.md`](ARCHITECTURE.md) for why this approach was chosen
over patching `panel.js` directly, and why it's safe if the class name ever
changes in a future GNOME version.

That file (GPL-2.0-or-later, part of the `gnome-shell-extensions` source
package) was read directly and used as the architectural reference for this
project, because it's guaranteed to use APIs that are valid for the
GNOME Shell version actually installed. Key things learned from it:

- It's a `PanelMenu.Button` subclass, added via
  `Main.panel.addToStatusArea(name, indicator)`.
- Each dot is an `St.Button`, laid out in an `St.BoxLayout`.
- State tracks two `global.workspace_manager` signals:
  `notify::n-workspaces` (workspace count changed) and `workspace-switched`
  (active workspace changed). These are the only two signals this extension
  needs for the same purpose.
- Clicking calls `workspace.activate(global.get_current_time())` — the
  standard, public way to switch workspaces; nothing lower-level than this
  is needed or should be used.
- Cleanup is one `indicator.destroy()` call. Signal handlers connected via
  `connectObject(..., trackingObject)` are torn down automatically when
  `trackingObject` (a GObject that emits `destroy`) is destroyed — this is
  the modern (GNOME 45+) replacement for manually tracking and
  disconnecting handler IDs.

This extension's `lib/workspaceIndicator.js` follows the same structure,
minus the popup menu and window-thumbnail rendering (not needed for a plain
numbered-square design) and minus the "collapse into a menu past N
workspaces" behavior (intentionally: squares should always be visible,
Hyprland-style).

## 3-finger swipe gesture progress (private API, best-effort)

A user reported that swiping across multiple workspaces with a 3-finger
touchpad gesture only updated the active square once the gesture settled
on the final workspace, not while passing through the intermediate ones.
This matches GNOME's own bundled `workspace-indicator` extension's
behavior too (same two signals as this project, no gesture-progress
tracking) -- so it's a real enhancement opportunity, not a regression.

GNOME's 3-finger workspace-switch gesture is driven by TWO `SwipeTracker`
instances, one per view, both private and both with identical semantics
(one integer snap point per workspace, absolute fractional progress,
`activate()` deferred to the settle animation's `onComplete`):

- **Normal view**: `js/ui/workspaceAnimation.js`'s
  `WorkspaceAnimationController`, which the `WindowManager` instance
  (`Main.wm`) holds as `this._workspaceAnimation._swipeTracker`.
- **Overview** (single Super = window picker, double Super = app grid):
  `js/ui/workspacesView.js`'s `WorkspacesDisplay`, reachable as
  `Main.overview._overview.controls._workspacesDisplay._swipeTracker`
  (chain verified: overview.js `init()` creates `_overview`, whose
  `controls` getter returns the `ControlsManager` that constructs the
  `WorkspacesDisplay`). Its `_switchWorkspaceBegin` literally passes
  `points = [0..n-1]` to `confirmSwipe`, which is what makes the two
  trackers' progress values interchangeable. Only one tracker is active
  at a time (`Shell.ActionMode.NORMAL` vs `.OVERVIEW`), so sharing one
  set of handlers across both is race-free.

This has now been
verified against the installed environment's real source, extracted from
the shell's gresource (see "Things that were deliberately NOT assumed"
below -- an earlier version of this document wrongly believed that was
impossible, and two rounds of misbehaving guesswork followed from it).
`lib/gestureProgressTracker.js` still treats both fields as the private
API they are and stays fully defensive, per tracker:

- Optional chaining along the whole access path.
- A `typeof ... === 'function'` guard before calling `.connect()`.
- A try/catch around each tracker's setup, so a mismatch on one view
  costs only that view's preview.

If you want to verify or update this against a specific install, the
Looking Glass check is:

```
Object.keys(Main.wm._workspaceAnimation)
```

which should include a `_swipeTracker` field backed by `js/ui/swipeTracker.js`'s
`SwipeTracker` class, itself exposing `begin`/`update`/`end` signals.

**What `update`'s `progress` value actually means (this was misread
twice before being pinned down).** The first version assumed `progress`
was a *delta* from the gesture's starting workspace, one unit per
workspace step. On real hardware that produced a directly reported bug:
one swipe direction appeared unresponsive and the other sluggish. A
second version tried to *self-calibrate* a sign/scale from gesture
outcomes (`realDelta / lastProgress`) rather than assume one -- which
also misbehaved, reported as the preview lagging the swipe and only
snapping right after the gesture settled.

Both failures have the same root cause: for this consumer of
`SwipeTracker`, `progress` is not a delta at all. This is no longer an
assumption -- it was **verified line-by-line against this exact install's
real source**, extracted from the shell's gresource (see "Things that
were deliberately NOT assumed" below for the extraction command, which
turned out to be possible after all):

- `_switchWorkspaceBegin` calls `_prepareWorkspaceSwitch()` with no
  arguments, which builds one `WorkspaceGroup` per workspace
  (`workspaceIndices = [...Array(nWorkspaces).keys()]`) positioned at
  exactly `i * baseDistance` -- so `MonitorGroup.getSnapPoints()` returns
  precisely `[0, 1, 2, ..., n-1]`.
- It then calls `tracker.confirmSwipe(baseDistance, points, progress,
  cancelProgress)` with the initial progress set to the *current
  workspace's* strip position.
- `SwipeTracker` emits that same coordinate on every `update`, and its
  `end` signal is `emit('end', duration, endProgress)`.
- `_switchWorkspaceEnd` picks the final workspace as
  `findClosestWorkspace(endProgress)` -- the nearest snap point, i.e.
  `round(endProgress)` clamped to the strip.

So `progress` is an **absolute fractional workspace index** (e.g. `2.4` =
40% of the way from the 3rd to the 4th workspace), in every layout
orientation and text direction (`MonitorGroup.get progress()` normalizes
the sign for vertical and RTL layouts before the value ever reaches the
tracker).

That explains both earlier symptom sets exactly:

- Interpreting an absolute value as a delta means the computed target
  (`beginIndex + progress`) roughly *doubles* the real index -- clamping
  made one direction slam to an edge (looked unresponsive) and the other
  need extra travel (felt sluggish).
- Calibrating `realDelta / lastProgress` against an absolute value learns
  a different "scale" depending on which workspace the gesture happened
  to start from, so the learned factor was garbage for any other starting
  workspace -- and the first gesture after every login had no preview at
  all while waiting to calibrate.

`lib/gestureProgressTracker.js` now mirrors GNOME's own mapping directly
-- `clamp(round(progress), 0, n_workspaces - 1)` -- which needs no
calibration pass, so the preview is live from the very first gesture and
tracks 1:1 with finger movement in both directions. Two further
snappiness details:

- The `end` signal carries `(duration, endProgress)`; the tracker
  previews `round(endProgress)` the instant fingers lift, rather than
  waiting the few hundred ms for GNOME's snap animation to finish and
  emit `workspace-switched`.
- The absolute-index assumption is still verified against ground truth
  after every gesture, and the verification is **event-driven, on the
  next `workspace-switched` signal** -- not a fixed delay. This matters:
  GNOME only calls `activate()` in the `onComplete` of its settle
  animation, whose duration is `MAX_ANIMATION_DURATION(400ms) *
  log2(1 + nWorkspaces)` at worst -- over a second with 5+ workspaces. A
  first version of this check used a fixed 350ms timer, which routinely
  read the ground truth *before* GNOME had activated the target, scored
  its own correct predictions as misses, and tripped the safety valve a
  few swipes into every session (reported as "snappy after login, then
  the live preview dies"). A timer remains only as a fallback for
  gestures that never emit `workspace-switched` (cancelled swipes /
  round trips), which are race-free since the active workspace never
  changed; both are dropped if a new gesture begins first.
- The safety valve itself (`CONSECUTIVE_RESULTS_TO_TOGGLE` consecutive
  mispredictions pauses the preview, with a `console.warn`) is a *pause*,
  not a kill: predictions keep being verified while paused, and the same
  number of consecutive correct ones turns the preview back on. So on a
  hypothetical GNOME build where the semantics differ the preview stays
  off, while a transient confounder (e.g. a keyboard switch landing
  mid-verify) costs a few swipes of liveness, never the rest of the
  session.

A user-visible consequence of the deferred `activate()` worth knowing:
**anything launched during a gesture's settle animation targets the
ORIGIN workspace.** Swipe to the trailing empty workspace and launch an
app within the settle window (which exceeds a second with 5+
workspaces) and the app's startup sequence is pinned to the workspace
you *came from* (`_checkWorkspaces` in the extracted windowManager.js
reads `sequence.get_workspace()`), so the window maps on the second-last
workspace — and the pending switch can end up never committing at all,
in which case `workspace-switched` never fires. That last part bit the
indicator: the gesture-end *prediction* stayed painted with nothing to
correct it. `_resolveVerify` therefore repaints from
`get_active_workspace_index()` on every resolution — the verify
fallback doubles as the display's self-heal, bounding any stale preview
at ~1.5s. The launch-targets-origin behavior itself is stock GNOME and
deliberately not fought.

To re-verify the raw values on a specific install via Looking Glass:

```
Main.wm._workspaceAnimation._swipeTracker.connect('update', (t, p) => log('progress=' + p.toFixed(3)))
```
run alongside `journalctl --user _COMM=gnome-shell -f`, swiping in both
directions: the logged values should hover around the *absolute* index of
whatever workspace is under the gesture, regardless of where the swipe
started.

## Keybinding conflicts (confirmed on this install)

The requested Super+ combinations have **three** independent pre-existing
owners on a stock Ubuntu 24.04 install — the third one (Ubuntu Dock) was
only discovered after the first two were already handled, because its
symptoms looked identical:

| Combo | Already bound to | Schema |
|---|---|---|
| `Super+1` .. `Super+9` | `switch-to-application-1..9` (switch to Nth pinned dash app) | `org.gnome.shell.keybindings` |
| `Super+Left` / `Super+Right` | `toggle-tiled-left` / `toggle-tiled-right` (half-screen window snap) | `org.gnome.mutter.keybindings` |
| `Shift+Super+Left` / `Shift+Super+Right` | `move-to-monitor-left` / `move-to-monitor-right` (move window to adjacent monitor) | `org.gnome.desktop.wm.keybindings` |
| `Super+1` .. `Super+0` (+ Shift/Ctrl variants) | Ubuntu Dock's own "activate Nth pinned app" hot-keys, gated by the `hot-keys` boolean (default `true`) | `org.gnome.shell.extensions.dash-to-dock` |

`Shift+Super+1..9` (the move-window-to-workspace bindings) has no GNOME
default of its own -- `move-to-workspace-N` keys are unbound except
`move-to-workspace-1` = `<Super><Shift>Home`, which doesn't collide --
but Ubuntu Dock's `app-shift-hotkey-1..10` grabs exactly those combos
("launch new instance of Nth pinned app"). Those die with the same
`hot-keys = false` master switch already described below, so the shift
variants needed no additional handling.

The Ubuntu Dock row is the important lesson: Ubuntu's always-on dock is
the preinstalled `ubuntu-dock@ubuntu.com` extension, a fork of Dash to
Dock that shares its `org.gnome.shell.extensions.dash-to-dock` schema.
When `hot-keys` is true it registers **its own** `Meta` keybinding grabs
for `<Super>1..0` (`app-hotkey-1..10`, plus `app-shift-hotkey-*` and
`app-ctrl-hotkey-*` variants) entirely independently of
`org.gnome.shell.keybindings`. So clearing `switch-to-application-N`
alone still left a second live owner of the same accelerators — which is
why `Super+N` kept *intermittently* launching dock apps depending on
which extension's grab won the enable-order race, and why `Super+5` with
only 3 workspaces launched the 5th dock app (this extension's handler
correctly no-ops on a missing workspace, so any app launch means the
dock's grab fired, not ours).

Mutter dispatches only one action per accelerator, so simply adding a new
keybinding on the same combo without addressing the existing owners leaves
behavior undefined. `lib/keybindingManager.js` resolves all three the same
way: it saves each conflicting key's *current* value (not the schema
default — the user may already have customized it), neutralizes it for as
long as this extension's own keybindings are active (`set_strv(key, [])`
for the two GNOME schemas, `hot-keys = false` for the dock, which makes
the dock itself drop all of its number-key grabs), and restores the exact
saved values on disable.

The dash-to-dock schema only exists when the dock is installed, so it's
looked up via `Gio.SettingsSchemaSource` first — constructing
`Gio.Settings` directly with a missing `schema_id` hard-aborts the whole
gnome-shell process. On installs without any dock, that whole code path
silently no-ops.

If you're re-verifying this on a different install or a newer GNOME
version, the commands are:

```sh
gsettings get org.gnome.shell.keybindings switch-to-application-1
gsettings get org.gnome.mutter.keybindings toggle-tiled-left
gsettings get org.gnome.desktop.wm.keybindings move-to-monitor-left
gsettings get org.gnome.shell.extensions.dash-to-dock hot-keys
gsettings get org.gnome.shell.extensions.dash-to-dock app-shift-hotkey-1
```

`switch-to-workspace-1..9` (`org.gnome.desktop.wm.keybindings`) is a
*different, unbound-by-default* set of keys and is not touched by this
extension.

## Moving windows between workspaces (verified against extracted source)

The Shift+Super window-movement features are built on two methods of
GNOME Shell's own `WindowManager` instance (`Main.wm`), both verified by
reading this install's real `js/ui/windowManager.js` (extracted from the
gresource -- see the section below for the command):

**`Main.wm.actionMoveWindow(window, workspace)`** -- the exact method
GNOME's own built-in move-window keybindings dispatch to. Verified
behavior from the source:

- No-ops if the destination workspace is already active (our
  "destination equals current" edge case is handled by GNOME itself).
- Sets `_workspaceAnimation.movingWindow` before the move, so the
  workspace-switch animation visually carries the window along instead of
  leaving it behind and popping it in.
- Ends with `workspace.activate_with_focus(window, timestamp)` -- i.e.
  **GNOME follows the moved window**, keeping it focused. Hyprland's
  `movetoworkspace` follows too, so "follow" is the only defensible
  default; a non-following variant (Hyprland's `movetoworkspacesilent`)
  would be a future setting, not a replacement.
- Window state (fullscreen, maximized) is workspace-independent in
  Mutter; a workspace change never touches it.

**`Main.wm.insertWorkspace(pos)`** -- GNOME Shell already has real
workspace insertion; no window-shifting logic needed to be written for
this project. GNOME itself uses it to prepend a workspace when moving a
window left from workspace 1 (`_showWorkspaceSwitcher`). Verified
mechanics:

- Only operates when dynamic workspaces are on (`return` otherwise) --
  so with static workspaces this extension's "insert new workspace"
  degrades to moving into the existing neighbor workspace, matching how
  GNOME's own bindings behave in static mode.
- It appends one workspace at the end, then shifts every window at
  `index >= pos` one workspace right via `change_workspace_by_index`,
  explicitly skipping windows that must not move: transients (Mutter
  moves them with their ancestor), override-redirect windows, and sticky
  windows (moving would un-stick them).
- If the insertion point is at or left of the active workspace it
  re-activates the shifted workspace with animations blocked, so the
  user sees no spurious switch.

**Workspace lifetime rules** (from `WorkspaceTracker._checkWorkspaces` in
the same file) that the design leans on:

- Empty-workspace cleanup runs in a `Meta.LaterType.BEFORE_REDRAW`
  later, never synchronously -- so an "insert workspace, then move the
  focused window into it" sequence that completes within one dispatch is
  race-free: the tracker only ever sees the already-populated workspace.
- The tracker never removes the *active* workspace or the trailing empty
  one; other empty workspaces are culled. Two user-visible consequences,
  intentional rather than fought (both are plain GNOME dynamic-workspace
  behavior): the origin workspace disappears after its last window is
  moved away, and consequently Shift+Super+Left/Right on a window that
  is *alone* on its workspace nets out to no visible change (the new
  workspace appears, the emptied origin is culled).

**Focused-window resolution** (`lib/windowMover.js`): the focused window
is resolved through `Meta.Window.find_root_ancestor()` so a focused
modal/attached dialog moves *with its parent window* rather than alone,
and `on_all_workspaces` windows are never touched (that covers sticky
windows, desktop/dock windows, and -- under `workspaces-only-on-primary`,
which is on for this install -- every window on non-primary monitors,
which Mutter marks on-all-workspaces; moving those is meaningless and
`change_workspace` would corrupt user-pinned stickiness).

API presence was additionally confirmed against the installed Mutter
introspection data (`grep -a <symbol>
/usr/lib/x86_64-linux-gnu/mutter-14/Meta-14.typelib`):
`reorder_workspace`, `append_new_workspace`, `change_workspace_by_index`,
`find_root_ancestor`, `activate_with_focus`, and the
`workspaces-reordered` signal all exist. `reorder_workspace` (moving a
workspace *object* to a new index) was considered as an alternative
insertion primitive but rejected in favor of `Main.wm.insertWorkspace`:
GNOME's own method is the battle-tested path with all window-class edge
cases already handled, whereas a reorder-based insertion would
re-implement that logic with no proven consumer in this codebase's
target version. The `workspaces-reordered` signal *is* now consumed by
`lib/workspaceIndicator.js`, since a reorder (overview thumbnail drag,
or `insertWorkspace` itself) changes the active workspace's index
without firing `workspace-switched` or `notify::n-workspaces`.

## Tiling: APIs, semantics, and limitations (verified on this install)

Everything the tiling subsystem (`lib/tiling/`) touches was verified
against the installed Mutter introspection data
(`grep -a <symbol> /usr/lib/x86_64-linux-gnu/mutter-14/Meta-14.typelib`)
before use. All of it is public API — the tiling subsystem contains
**zero** private-API reaches:

- Geometry: `Meta.Window.move_resize_frame(user_op, x, y, w, h)` (frame
  coordinates, the correct space for layout), `get_frame_rect()`,
  `Meta.Workspace.get_work_area_for_monitor()` (excludes panel/dock
  struts — never raw monitor geometry).
- Ordering: `Meta.Window.get_stable_sequence()` — monotonically
  increasing creation id, the stateless substitute for a tiling tree.
- Signals: `Meta.Display` `window-created`, `grab-op-end`,
  `workareas-changed`, `window-entered-monitor`, `notify::focus-window`;
  `Meta.Window` `unmanaged`, `shown`, `workspace-changed`,
  `notify::minimized`, `notify::fullscreen`,
  `notify::maximized-horizontally/-vertically`;
  `Meta.WorkspaceManager` `workspace-switched`, `workspace-removed`;
  `Main.layoutManager` `monitors-changed`.
- Chrome: `Main.layoutManager.addChrome(actor, {trackFullscreen: true})`
  for the stacked tab bar (auto-hides in fullscreen; hidden manually
  during the overview via `Main.overview` `showing`/`hidden`).

**Hyprland semantics reproduced** (researched, not guessed): Hyprland's
default layout is *dwindle* — a binary-split layout where each new window
splits the previously last area, split axis chosen by that area's aspect
ratio (wider → side-by-side, taller → top/bottom). 1 window = 100%,
2 = 50/50, the 3rd splits the second's half, spiraling inward. Its
*stacked* (tabbed) layout puts all windows in one content area under a
row of title tabs that compress on overflow. Both are implemented as pure
strategies in `lib/tiling/layoutEngine.js`.

**Deliberate deviations from Hyprland**, each forced by the GNOME
platform or by this project's stateless-layout design decision (see
ARCHITECTURE.md):

- Window order is creation order, not focus-time tree insertion; closing
  a middle window re-flows later windows. (No mutable tree = no
  corruption, no stale state; interactive split ratios/node swaps are
  future work requiring a real tree.)
- Minimize floats the window out of the layout (Hyprland has no
  minimize; GNOME users expect the space back).
- A user-maximized window floats instead of being force-unmaximized —
  maximized windows ignore `move_resize_frame()` and un-doing an explicit
  user action would fight GNOME. Windows that *open* maximized (browsers,
  Electron apps, Files, Settings — anything restoring remembered state)
  are un-maximized so they tile, via a short grace period after tracking
  rather than a creation-time check: **on Wayland the app applies its
  maximized state only after `window-created`** (first surface commit;
  Electron later still), so a creation-time check sees an unmaximized
  window and misses it — found in practice as "only terminal tiles,
  every other app opens maximized and floats". A maximize arriving
  within `MAP_MAXIMIZE_GRACE_US` of tracking is treated as map-state
  restoration and undone; anything later is a user action and floats.
- Under `workspaces-only-on-primary`, secondary monitors tile as one
  workspace-agnostic bucket and can't be stacked (their windows are
  marked on-all-workspaces by Mutter and belong to no workspace).

**Known platform constraints:**

- Windows with size constraints (terminals' character-cell increments,
  apps with min sizes) may not fill their computed rect exactly —
  Mutter honors constraints over the requested size. Small residual gaps
  around such windows are expected, same as in any GNOME tiler.
- `move_resize_frame` is not animated by GNOME; layout changes are
  instantaneous. Animating would require per-window actor tweens
  (future work, listed in the settings outlook).
- User drag-moves of tiled windows snap back on `grab-op-end` (v1
  behavior; drag-to-swap needs a mutable tree).

## Focus border: APIs and the workspace-switch-animation problem

`lib/focusBorder.js` draws a Hyprland-style hint border around the
currently focused window. Every API it uses is public and was verified
the same way as everything else in this document, against the installed
Mutter typelib (`grep -a <symbol> /usr/lib/x86_64-linux-gnu/mutter-14/Meta-14.typelib`)
and the extracted shell source:

- `Meta.Window` signals `position-changed`, `size-changed`,
  `notify::fullscreen`, `notify::minimized`, `unmanaged`; methods
  `get_frame_rect()`, `is_fullscreen()`, `window_type` /
  `Meta.WindowType.NORMAL/DIALOG/MODAL_DIALOG`.
- `global.display` `notify::focus-window`.
- `Main.layoutManager.addChrome(actor, {affectsInputRegion: false})` --
  same chrome mechanism `lib/tiling/stackTabBar.js` uses, here with
  input-region participation explicitly turned off since the border must
  never intercept a click.

**A genuinely new discovery this feature required:** `global.window_manager`
is a public GObject (the `Shell.WM` class, GNOME's own `windowManager.js`
holds it as `this._shellwm`) distinct from the private
`Main.wm._workspaceAnimation._swipeTracker` field `GestureProgressTracker`
reaches into. It emits a public `switch-workspace` signal at the start of
every keyboard- or mouse-driven workspace-switch animation -- confirmed
by reading `js/ui/windowManager.js`'s own extracted source, where
`this._shellwm.connect('switch-workspace', this._switchWorkspace.bind(this))`
is the literal handler that kicks off the switch animation. This matters
because a chrome actor (the border) does not slide with GNOME's
workspace-switch animation -- the window group visually translates during
a switch, but chrome sits in a separate layer above it and stays put.
Left alone, the border would appear to hang motionless on screen while
the real focused window slides away beneath it. Hiding on
`switch-workspace` and resyncing on the already-established authoritative
signal `workspace-switched` brackets a keyboard/mouse switch cleanly, with
zero private API.

**Why that's not sufficient for gesture switches, and the resulting
second consumer of the swipe-tracker private field:** a 3-finger swipe's
live drag never touches `switch-workspace` at all, because the active
workspace doesn't actually change until the gesture commits -- the exact
fact that already forced `GestureProgressTracker` to preview a guess
rather than read ground truth (see that section above). So
`lib/focusBorder.js` also connects, best-effort, to the very same private
field that file already reaches into
(`Main.wm._workspaceAnimation._swipeTracker`), purely for its `begin`
signal, to hide the border for a gesture's live-drag portion. Same
defensive posture as the original reach: optional chaining, a
`typeof ... === 'function'` guard, try/catch around the whole setup. This
is one documented private-API surface with two independent, equally
fail-safe readers -- not a new, separate private reach.

## Stacked tab bar: trackFullscreen, chrome z-order, screen lock, gestures

Four real user-reported bugs in `lib/tiling/tilingManager.js`'s stacked
tab bar. Two of them (the gesture ones) survived a first round of fixes
built on a plausible-but-wrong theory, and were only resolved after the
actual re-show mechanism was found in the extracted shell source -- the
finding below is the important one to keep for posterity.

**`trackFullscreen: true` means GNOME owns your actor's `visible`
property -- your own `hide()` calls WILL be overwritten.** From the
extracted `js/ui/layout.js`:

```js
_updateActorVisibility(actorData) {
    if (!actorData.trackFullscreen)
        return;
    let monitor = this.findMonitorForActor(actorData.actor);
    actorData.actor.visible = !(global.window_group.visible &&
                                monitor && monitor.inFullscreen);
}
```

This *assigns* `visible` -- to `true` in the normal no-fullscreen case --
and `_updateVisibility()` runs it for every tracked actor from
`showOverview()`, `hideOverview()`, `_sessionUpdated()`,
`_updateFullscreen()` (any fullscreen change), and `_windowsRestacked()`
(window restacks!). So a `trackFullscreen` chrome actor that its owner
hid can pop back at essentially any moment. That single flag explained
both gesture bugs at once:

- *Tab bar visible over a gesture-opened overview, but not a Super-key
  one.* The two overview entry paths order things differently
  (extracted `js/ui/overview.js`): `show()` (Super key) calls
  `Main.layoutManager.showOverview()` **before** `_animateVisible()`
  emits `'showing'` -- so the extension's hide runs last and sticks.
  `_gestureUpdate()` (3-finger swipe up) emits `'showing'` **first**
  and calls `showOverview()` **after** -- whose `_updateVisibility()`
  then force-reasserted `visible = true` on the freshly-hidden bar.
  Same signal, same handler, opposite outcome purely from call order.
- *Tab bar hanging over the whole live drag of a 3-finger workspace
  switch despite being hidden on the tracker's `begin` signal* --
  restacks during the drag re-ran `_updateActorVisibility()` and
  un-hid it.

The fix is to **not use `trackFullscreen`** and own visibility outright
(the manager already hides bars for fullscreen buckets itself via its
per-monitor fullscreen check, relayout-driven on `notify::fullscreen`).
Lesson recorded: `trackFullscreen` is only suitable for chrome whose
visibility is *purely* a function of fullscreen state (GNOME uses it for
things like the panel box); any actor whose owner also toggles
visibility for its own reasons must not use it.

**Hiding for the workspace-switch gesture must be a state, not an
event.** Even without `trackFullscreen`, a one-shot `hide()` at gesture
`begin` can be undone by the manager itself: any relayout flush landing
mid-drag re-runs `_syncTabBars()`, whose ground truth (the active
workspace) still says "stacked workspace, show a bar" for the origin
until the gesture commits. So the gesture raises a flag that
`_syncTabBars()` checks exactly like `Main.overview.visible`. Ending the
window is subtle (extracted `js/ui/workspaceAnimation.js`,
`_switchWorkspaceEnd`):

```js
params.onComplete = () => {
    if (!newWs.active)
        newWs.activate(endTime);   // fires workspace-switched at settle
    ...
};
```

- A *real* switch fires `workspace-switched` only when the settle
  animation completes -- the perfect "user has arrived" moment to drop
  the flag and re-show.
- A *cancelled* swipe (snaps back to the origin) never calls
  `activate()` at all -- `newWs.active` is already true -- so waiting
  for `workspace-switched` alone would strand the bars hidden forever.
  The tracker's `end` signal carries `(duration, endProgress)`, and
  GNOME resolves the landing workspace as
  `findClosestWorkspace(endProgress)` = clamped `round()` (the same
  mapping `lib/gestureProgressTracker.js` already mirrors, documented
  above). The extension applies that same mapping at `end`: landing ==
  active means cancel, drop the flag and re-show.

**Chrome z-order: `addChrome()` always stacks the newest actor on top.**
From the extracted `js/ui/layout.js`:

```js
addChrome(actor, params) {
    this.uiGroup.add_child(actor);
    if (this.uiGroup.contains(global.top_window_group))
        this.uiGroup.set_child_below_sibling(actor, global.top_window_group);
    this._trackActor(actor, params);
}
```

Every call repositions `actor` directly below `global.top_window_group`
-- above every chrome actor added before it. `js/ui/messageTray.js`
confirms `Main.messageTray` adds itself via this exact same
`addChrome()` once during core shell startup, long before any user
extension enables -- so an extension's chrome lands *above* the
notification banner layer by construction, silently blocking banners
(chat notifications, low battery, ...). One-line fix after adding:
`Main.layoutManager.uiGroup.set_child_below_sibling(bar, Main.messageTray)`
(`Main.messageTray` is a stable, public `Main.*` export, not a private
field).

**Screen lock disables this (and every non-lock-aware) extension for
its duration -- confirmed, not assumed.** Locking pushes GNOME's session
mode via `Main.sessionMode.pushMode('unlock-dialog')`
(`js/ui/screenShield.js`). In `js/ui/sessionMode.js`, the
`'unlock-dialog'` mode declares no `parentMode`; in
`js/ui/extensionSystem.js`:

```js
_extensionSupportsSessionMode(uuid) {
    ...
    if (extension.sessionModes.includes(Main.sessionMode.currentMode))
        return true;
    if (extension.sessionModes.includes(Main.sessionMode.parentMode))
        return true;
    return false;
}
```

`extension.sessionModes` defaults to `['user']` when `metadata.json` has
no `session-modes` key (this extension's doesn't). While locked,
`currentMode` is `'unlock-dialog'` and `parentMode` is `null` -- neither
matches, so the extension is disabled at lock and re-enabled at unlock.
This is standard, intentional GNOME behavior, not something to defeat by
declaring `unlock-dialog` support (that would keep keybindings and
window manipulation live on the lock screen). The stacked-workspace Set
survives the cycle as module-scope state instead -- ES modules are
cached for the life of the shell process -- see ARCHITECTURE.md. To
re-verify on a specific install:

```sh
journalctl --user _COMM=gnome-shell -f
# then lock (Super+L) and watch for:
#   sessionMode: Pushing mode unlock-dialog
#   Changing state of extension tessera@sbh321.github.io to DEACTIVATING
# and, on unlock:
#   sessionMode: Popping mode unlock-dialog
#   Changing state of extension tessera@sbh321.github.io to ACTIVATING
```

## Panel auto-hide: panelBox mechanics (verified on this install)

Everything `lib/panelAutoHide.js` relies on was verified against the
extracted `js/ui/layout.js` rather than assumed:

- **`panelBox` is registered as** `addChrome(this.panelBox,
  {affectsStruts: true, trackFullscreen: true})`, and `defaultParams`
  fills in `affectsInputRegion: true` — these three values are what the
  module must restore on disable, recorded as a literal in the module.
- **`translation_y` is GNOME's own panel-slide mechanism**: the greeter
  path sets `panelBox.translation_y = -panelBox.height` and
  `_startupAnimationGreeter()` eases it back to 0. Moving the panel via
  translation is therefore cooperating with the shell, not fighting it —
  unlike `visible`, which `_updateActorVisibility()` force-writes for
  every `trackFullscreen` actor (the stacked-tab-bar lesson above; the
  auto-hide module never touches `visible` for exactly that reason, and
  gets correct fullscreen behavior for free).
- **`trackChrome()`/`untrackChrome()` are public and documented as each
  other's inverse** ("Undoes the effect of trackChrome()"), and
  `trackChrome` accepts the same params as `addChrome` — so
  untrack-then-retrack with `affectsStruts: false` is the supported way
  to change an existing chrome actor's strut participation. `_trackActor`
  reconnects the same lifecycle signals (via `connectObject`, which
  `_untrackActor` disconnects) and queues the region update itself. The
  separate `panelBox.connect('notify::allocation', ...)` at layout.js
  line ~288 is a plain `connect`, not `connectObject`, so it survives
  the untrack/retrack cycle untouched.
- **Struts and input rects are computed from transformed geometry**
  (`get_transformed_position/size()` in `_updateRegions`), and on
  Wayland the stage input region is never installed at all
  (`wantsInputRegion` requires `!Meta.is_wayland_compositor()`; input
  routing is actor picking). A translated-off panel therefore neither
  reserves work-area space (moot anyway — struts are untracked while
  active) nor intercepts clicks at the top edge.
- **`Main.panel.style` is owned and clobbered by overview.js.** Verified
  in this install's extracted `js/ui/overview.js`: `_gestureEnd()` and
  `runStartupAnimation()` assign `Main.panel.style = 'transition-duration:
  …'` wholesale, and `_hideDone()` assigns `Main.panel.style = null` after
  *every* overview exit. An extension can therefore never "set and
  forget" an inline style on the panel — it survives only until the
  next overview visit. The panel-opacity feature composes its
  `background-color` declaration into whatever the shell currently has
  and re-asserts it from a `notify::style` handler (idempotent, so its
  own write doesn't re-trigger it).
- **`Main.overview.visibleTarget` vs `.visible`:** `visible` stays true
  until the overview's hide animation *completes*; `visibleTarget`
  flips to false the moment hiding *begins* (both verified in
  overview.js). A "reveal while in overview" condition based on
  `visible` keeps the panel around for the whole zoom-out; based on
  `visibleTarget`, the panel's conceal runs together with the
  overview's own animation.
- **Clutter keys implicit transitions by the property's canonical
  DASHED name.** `get_transition('translation_y')` /
  `remove_transition('translation_y')` compile and run fine but match
  nothing, silently, forever — the key is `'translation-y'`. Verified
  in this install's extracted `js/ui/environment.js`: `_easeActor`
  itself converts (`Object.keys(params).map(p => p.replace('_', '-',
  'g'))`) before calling `remove_transition`/`get_transition`. The
  underscore variant cost a full debugging round: the auto-hide
  module's "is a slide running?" guard always answered no, so a poll
  tick 100ms into every slide wrote `translation_y` directly — and a
  direct set with 0 easing duration *removes* the running implicit
  transition — snapping the panel to its final position and making the
  slide duration appear to have no effect at all.
- **Super shows up in `global.get_pointer()`'s modifier mask as MOD4**
  (standard Mutter/X11 mapping on Ubuntu; `Clutter.ModifierType
  .SUPER_MASK` is additionally checked defensively). Polling that one
  call at 10 Hz covers both the hover-at-edge and hold-Super reveal
  triggers with no barriers, hot-edge actors, or key grabs.

To re-verify the panelBox parameters on a future GNOME version:

```sh
gresource extract /usr/lib/gnome-shell/libshell-*.so \
    /org/gnome/shell/ui/layout.js | grep -A4 'addChrome(this.panelBox'
```

## Things that were deliberately NOT assumed

- The compiled `js/ui/*.js` source tree is not present as loose files on
  this system — it's baked into a `gresource` archive, not exposed as a
  standalone file anywhere under `/usr/share`. **Correction to an earlier
  version of this document, which claimed it was therefore unreadable:**
  the archive is embedded in `/usr/lib/gnome-shell/libshell-14.so` and the
  `gresource` CLI can list and extract from a shared library directly:

  ```sh
  gresource list /usr/lib/gnome-shell/libshell-14.so | grep ui/
  gresource extract /usr/lib/gnome-shell/libshell-14.so \
      /org/gnome/shell/ui/workspaceAnimation.js
  ```

  This is how the swipe-gesture progress semantics were finally verified
  against the exact installed shell version (see the gesture section
  above) after two rounds of misbehaving guesswork — prefer this over
  assuming any `js/ui` behavior from general knowledge when porting.
- No GNOME Shell internals/private classes are patched (no prototype
  overrides). Every import used is a public
  `resource:///org/gnome/shell/...` or
  `resource:///org/gnome/Shell/Extensions/js/...` module, or a standard GI
  namespace (`Clutter`, `GObject`, `St`, `Meta`, `Shell`, `Gio`). This
  project reaches outside its own schema/API surface in exactly four
  isolated, documented places:
  1. `lib/keybindingManager.js` — saves and restores conflicting
     keybinding values in three schemas this extension doesn't own
     (`org.gnome.shell.keybindings`, `org.gnome.mutter.keybindings`, and
     — when installed — `org.gnome.shell.extensions.dash-to-dock`; see
     above).
  2. `lib/nativeIndicatorHider.js` — adds/removes one marker style class
     on `Main.panel` (a public, stable actor reference), and this
     extension's own `stylesheet.css` uses that marker to collapse the
     undocumented `.workspace-dot` style class. No JS reaches into the
     Activities button's internals; the coupling is CSS-selector-only, so
     a class-name mismatch on a future GNOME version just means the
     override silently does nothing rather than breaking anything.
  3. `lib/accentColor.js` — reads (never writes)
     `org.gnome.desktop.interface gtk-theme`, a public schema, just not
     one this extension owns.
  4. `lib/gestureProgressTracker.js` (and, sharing the identical field
     and guards, `lib/focusBorder.js` and `lib/tiling/tilingManager.js`)
     — the one genuine reach into a private, `_`-prefixed internal field
     (`Main.wm._workspaceAnimation._swipeTracker`), guarded by optional
     chaining and try/catch so a mismatch on another device just disables
     that one enhancement (gesture preview, the border's gesture-swipe
     hide, or the tab bar's gesture-swipe hide) rather than breaking
     anything (see the sections above). One surface, three fail-safe
     readers.

## Porting to GNOME 47/48

Nothing in this codebase depends on GNOME-46-specific behavior beyond the
two schema keys, the `.workspace-dot` style class, the
`_workspaceAnimation`/`_swipeTracker` private fields, `addChrome()`'s
newest-on-top stacking order, `Main.messageTray`'s existence as the
notification-layer reference, GNOME's session-mode-based extension
disable/enable around screen lock, and the standard ESM extension API
shape (`Extension`, `ExtensionPreferences`, ES module imports) that has
been stable since GNOME 45. To port:

1. Re-run the `gsettings get` commands above against the target version —
   if GNOME or Ubuntu ever changes those defaults, `SHELL_KEYS_TO_CLEAR` /
   `MUTTER_KEYS_TO_CLEAR` / `DASH_TO_DOCK_SCHEMA` in
   `lib/keybindingManager.js` are the only lines that would need updating.
2. Re-check the Activities button for a `.workspace-dot`-equivalent style
   class using the same Looking-Glass-`inspect()` technique described
   above (there's no more reliable way to check this without the loose
   `js/ui/panel.js` source). If the class name changed,
   `stylesheet.css`'s `.tessera-hide-native-dots .workspace-dot`
   selector is the only thing that needs updating.
3. Re-run `Object.keys(Main.wm._workspaceAnimation)` in Looking Glass to
   confirm `_swipeTracker` still exists with the same shape. If not,
   `lib/gestureProgressTracker.js`, `lib/focusBorder.js`, and
   `lib/tiling/tilingManager.js` all already fail safely (see above) —
   this step is only needed to restore the live-preview enhancement and
   the two gesture-swipe hides, not to avoid breakage.
4. Confirm `global.window_manager` still emits `switch-workspace` (used
   by `lib/focusBorder.js` to hide during keyboard/mouse switch
   animations) — this is a long-stable public signal GNOME's own
   `windowManager.js` depends on internally, so it is very unlikely to
   change, but re-verify with the same source-extraction technique above
   if the border ever seems to hang mid-switch on a new version.
5. Re-check `addChrome()` in `js/ui/layout.js` still stacks newly-added
   chrome directly below `global.top_window_group`, and that
   `Main.messageTray` is still the exported message-tray singleton —
   both back the tab bar's
   `set_child_below_sibling(bar, Main.messageTray)` re-stack. Also
   re-confirm `_updateActorVisibility()` still only force-writes
   `visible` on `trackFullscreen` actors — the tab bars rely on plain
   (non-trackFullscreen) chrome being left alone (see the stacked tab
   bar section above).
6. Re-verify the screen-lock session-mode behavior described above
   (`_extensionSupportsSessionMode()` in `js/ui/extensionSystem.js`,
   `'unlock-dialog'`'s missing `parentMode` in `js/ui/sessionMode.js`)
   still disables/re-enables default-`session-modes` extensions around a
   lock. If that ever changes, the module-scope `stackedWorkspaces` Set
   in `lib/tiling/tilingManager.js` (there specifically to survive that
   cycle) simply becomes unnecessary rather than incorrect.
7. Re-verify `panelBox`'s `addChrome()` parameters (the `gresource`
   one-liner in the panel auto-hide section above): if they ever change,
   `PANEL_BOX_CHROME_PARAMS` in `lib/panelAutoHide.js` must be updated
   to match, or disable() would restore the wrong tracking flags.
8. Bump `"shell-version"` in `metadata.json` to include the new version
   string.
9. Re-run the full manual test pass in `tests/MANUAL_TESTS.md`.
10. If GNOME ever exposes a public Shell-theme accent-color API, that
    would be a good replacement for the Yaru-only lookup in
    `lib/accentColor.js` — see `docs/ROADMAP.md`.
