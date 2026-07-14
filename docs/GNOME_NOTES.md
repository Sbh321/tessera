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

GNOME's 3-finger workspace-switch gesture is driven by a `SwipeTracker`
instance private to `js/ui/workspaceAnimation.js`'s
`WorkspaceAnimationController`, which the `WindowManager` instance
(`Main.wm`) holds as `this._workspaceAnimation`. This has now been
verified against the installed environment's real source, extracted from
the shell's gresource (see "Things that were deliberately NOT assumed"
below -- an earlier version of this document wrongly believed that was
impossible, and two rounds of misbehaving guesswork followed from it).
`lib/gestureProgressTracker.js` still treats the field as the private API
it is and stays fully defensive:

- `Main.wm._workspaceAnimation?._swipeTracker` via optional chaining.
- A `typeof ... === 'function'` guard before calling `.connect()`.
- A try/catch around the whole setup.

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
| `Super+1` .. `Super+0` (+ Shift/Ctrl variants) | Ubuntu Dock's own "activate Nth pinned app" hot-keys, gated by the `hot-keys` boolean (default `true`) | `org.gnome.shell.extensions.dash-to-dock` |

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
gsettings get org.gnome.shell.extensions.dash-to-dock hot-keys
```

`switch-to-workspace-1..9` (`org.gnome.desktop.wm.keybindings`) is a
*different, unbound-by-default* set of keys and is not touched by this
extension.

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
  4. `lib/gestureProgressTracker.js` — the one genuine reach into a
     private, `_`-prefixed internal field
     (`Main.wm._workspaceAnimation._swipeTracker`), guarded by optional
     chaining and try/catch so a mismatch on another device just disables
     that one enhancement (see the section above).

## Porting to GNOME 47/48

Nothing in this codebase depends on GNOME-46-specific behavior beyond the
two schema keys, the `.workspace-dot` style class, the
`_workspaceAnimation`/`_swipeTracker` private fields, and the standard ESM
extension API shape (`Extension`, `ExtensionPreferences`, ES module
imports) that has been stable since GNOME 45. To port:

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
   `lib/gestureProgressTracker.js` already fails safely (see above) — this
   step is only needed to restore the live-preview enhancement, not to
   avoid breakage.
4. Bump `"shell-version"` in `metadata.json` to include the new version
   string.
5. Re-run the full manual test pass in `tests/MANUAL_TESTS.md`.
6. If GNOME ever exposes a public Shell-theme accent-color API, that would
   be a good replacement for the Yaru-only lookup in `lib/accentColor.js`
   — see `docs/ROADMAP.md`.
