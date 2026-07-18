# Architecture

Tessera began as a numbered workspace *indicator* and grew, feature by
feature, into a Hyprland-inspired tiling workspace manager. The goals
below predate that growth and survived it unchanged — each new capability
(window movement, automatic tiling, stacked layouts) was added as its own
isolated module or subsystem under the same rules, which is why the
indicator sections and the tiling sections of this document describe the
same architecture at different scales.

## Goals that shaped the design

- Work *with* GNOME's window and workspace model, never against or around
  it. Every workspace switch, window move, and window resize in this
  extension goes through the same public Mutter/Shell APIs GNOME's own
  code uses (`Meta.Workspace.activate()`, `Main.wm.actionMoveWindow()`,
  `Meta.Window.move_resize_frame()`, ...). Behavior GNOME owns — focus
  rules, animations, dynamic workspace lifetime, what floats — stays
  GNOME's.
- No monkey-patching of shell internals (no prototype/method overrides
  anywhere in this codebase). The four places this extension reaches
  outside its own GSettings schema are documented and isolated (see
  below); one of them (`lib/gestureProgressTracker.js`) reads a genuinely
  private internal field rather than a comparatively stable public
  schema/CSS-class surface, and is built to fail silently and safely on any
  device where that field doesn't match.
- `disable()` must leave GNOME in exactly the state it was in before
  `enable()` — no leaked signals, actors, or keybindings, and no residual
  changes to keybinding schemas this extension doesn't own.

## Module map

```
extension.js               Entry point. Extension subclass; wires the
                           modules below together. No logic of its own.
lib/settingsManager.js     Typed read-only accessors over this extension's
                           GSettings schema. No signal connections.
lib/workspaceIndicator.js  The panel UI: PanelMenu.Button + one St.Button
                           square per workspace.
lib/keybindingManager.js   Super+1-9 / Super+Left / Super+Right, and the
                           save/restore logic for the GNOME defaults they
                           collide with.
lib/nativeIndicatorHider.js  Hides GNOME's own Activities button (the whole
                           button, dots included); the indicator takes over
                           its overview-toggle and scroll roles.
lib/accentColor.js         Read-only lookup of Ubuntu's current accent
                           color, so the active square's default fill
                           follows Settings > Appearance.
lib/gestureProgressTracker.js  Best-effort live preview of the active
                           square during a 3-finger workspace-switch swipe.
                           The one genuinely private-API reach in this
                           project; mirrors GNOME's own progress-to-
                           workspace mapping (round of an absolute strip
                           index), verifies itself against every gesture's
                           real outcome, and no-ops safely if unsupported.
lib/windowMover.js         Moves the focused window between workspaces
                           (Shift+Super bindings), including inserting a
                           brand-new workspace beside the current one.
                           Stateless composition of GNOME's own
                           Main.wm.actionMoveWindow / insertWorkspace;
                           nothing to clean up by construction.
lib/tiling/                The automatic-tiling subsystem (see its own
                           section below). Nothing outside this directory
                           knows tiling exists except KeybindingManager
                           (dispatches the stacked toggle) and
                           extension.js (composition).
lib/tiling/windowFilter.js Pure classification: layout membership
                           (identity-level) vs current tileability
                           (adds transient states like minimized).
lib/tiling/layoutEngine.js Pure layout structure and geometry: the
                           LayoutTree dwindle split tree and the stacked
                           geometry split. No GNOME imports.
lib/tiling/stackTabBar.js  St tab-bar actor for stacked workspaces.
                           Presentational only.
lib/tiling/tilingManager.js Orchestrator: signals, per-workspace mode,
                           debounced relayout, geometry application.
lib/focusBorder.js         Hyprland-style hint border around the focused
                           window, on every workspace/monitor. Entirely
                           independent of lib/tiling/ -- floating windows
                           get one too. Tracks exactly one window at a
                           time (whichever is focused).
lib/panelAutoHide.js       Dock-style auto-hide for the GNOME top panel
                           (off by default): slides panelBox off-screen
                           via translation_y and reclaims its strut,
                           revealing on top-edge hover, held Super, the
                           overview, and open panel menus. Public API
                           only; zero footprint while the setting is off.
lib/utils.js               Pure helper functions (CSS string building, hex
                           color validation). No GNOME API usage.
prefs.js                   Adwaita preferences window. Separate process
                           from the shell; imports lib/settingsManager.js's
                           sibling concepts are not shared with it directly
                           since prefs.js talks to GSettings itself.
stylesheet.css             Default look. Class-based; JS overlays live
                           user settings as inline style, which always
                           wins over these class rules.
schemas/*.gschema.xml       Single source of truth for every setting.
```

`extension.js` intentionally contains no logic beyond construction/teardown
calls — if a bug isn't in one of the `lib/` modules, it isn't in this
codebase.

## Data flow

```
global.workspace_manager  --(notify::n-workspaces, workspace-switched)-->  WorkspaceIndicator
                                                                                  |
                                                                                  v
                                                                          Tessera[]
                                                                                  |
                                                                     click -> workspace.activate()

this-extension's GSettings --(changed::<key>)--> WorkspaceIndicator --> Tessera.applySettings()
                            --(changed::enable-custom-keybindings)--> KeybindingManager._syncEnabled()

org.gnome.desktop.interface --(changed::gtk-theme)--> WorkspaceIndicator --> Tessera.applySettings()
  (read-only; Ubuntu's accent-color picker switches gtk-theme, see lib/accentColor.js)

Super+1..9 / Super+Left/Right --(Main.wm keybinding dispatch)--> KeybindingManager handler --> workspace.activate() / get_neighbor().activate()

Shift+Super+1..9 / Shift+Super+Left/Right --(Main.wm keybinding dispatch)--> KeybindingManager handler --> WindowMover --> Main.wm.actionMoveWindow() / Main.wm.insertWorkspace()

Shift+Super+S --(Main.wm keybinding dispatch)--> KeybindingManager handler --> TilingManager.toggleStacked()

window/workspace/monitor events --> TilingManager (debounced) --> layoutEngine (pure) --> Meta.Window.move_resize_frame()
                                                              --> StackTabBar (stacked workspaces only)

this-extension's GSettings --(changed::panel-autohide)--> PanelAutoHideManager --> layoutManager.{un,}trackChrome(panelBox) + poll loop --> panelBox.translation_y
this-extension's GSettings --(changed::panel-opacity)---> PanelAutoHideManager --> composes rgba background into Main.panel.style (re-asserted on notify::style; nothing written at 100%)

global.display --(notify::focus-window)--> FocusBorderManager --> resolves color/geometry --> St actor position/size
global.window_manager --(switch-workspace)--\
Main.wm._workspaceAnimation._swipeTracker --(begin, best-effort)--> FocusBorderManager.hide()
global.workspace_manager --(workspace-switched)--> FocusBorderManager (resync/show)
this-extension's GSettings / org.gnome.desktop.interface --(changed::<key>)--> FocusBorderManager (resync)
```

The indicator never reads keybinding state, and the keybinding manager never
touches the panel widget — the two are independent consumers of the same
`SettingsManager`, composed only in `extension.js`. Window movement follows
the same separation: `KeybindingManager` only registers accelerators and
dispatches; all movement logic lives in `lib/windowMover.js`; the indicator
learns about the results purely through the same `global.workspace_manager`
signals it already watches (plus `workspaces-reordered`, added because a
workspace reorder changes the active workspace's *index* without firing
either of the other two signals).

## Window movement (`lib/windowMover.js`)

Both Shift+Super actions are deliberately thin compositions of GNOME
Shell's own `WindowManager` methods rather than re-implementations — see
[`GNOME_NOTES.md`](GNOME_NOTES.md) for how each was verified against this
install's extracted source:

- **Move to workspace N** = `Main.wm.actionMoveWindow(window, workspace)`,
  the same method GNOME's built-in move-window keybindings call. It
  already handles destination-is-current (no-op), carries the window
  through the switch animation, and follows the window with focus —
  matching both GNOME's and Hyprland's follow-the-window behavior, which
  is why "follow" is the default rather than an option (a Hyprland-style
  "silent move" could be added later as a setting without restructuring).
- **Move to new inserted workspace** = `Main.wm.insertWorkspace(pos)`
  followed by the same `actionMoveWindow`. GNOME already ships real
  workspace insertion (it uses it itself to prepend a workspace); an
  alternative design using `WorkspaceManager.reorder_workspace` was
  evaluated and rejected — it exists and would avoid shifting windows,
  but GNOME's own insertion path has every window-class edge case
  (transients, override-redirect, sticky) already handled and proven.

Decisions on the edge cases, all of which resolve to "do what GNOME's
own model does":

- **No focused window / focused sticky window:** clean no-op. Sticky
  covers desktop and dock windows and, under
  `workspaces-only-on-primary`, every window on non-primary monitors —
  moving those is meaningless and `change_workspace` would silently
  un-stick a user-pinned window.
- **Focused dialog:** resolved through `find_root_ancestor()`, so the
  parent window moves and Mutter carries the whole transient family —
  a dialog is never separated from its window.
- **Out-of-range workspace number:** no-op, consistent with the Super+N
  jump bindings (no implicit workspace creation — pressing Shift+Super+9
  with 4 workspaces does nothing rather than surprising the user with 5
  new workspaces).
- **Static workspaces:** `insertWorkspace` is dynamic-only by GNOME's own
  rule, so the insert bindings degrade to moving into the existing
  neighbor workspace (edge of strip: no-op).
- **Emptied origin workspaces** are culled by GNOME's `WorkspaceTracker`
  (never the active or trailing one) — deliberately not fought with
  keep-alives; it's the platform's dynamic-workspace model. Consequence:
  inserting a new workspace for a window that was *alone* nets out to no
  visible change.
- **Race-freedom:** the insert-then-move sequence is synchronous within
  one dispatch, and the tracker's empty-workspace cleanup only runs in a
  `BEFORE_REDRAW` later, so it can never observe the half-done state.

`WindowMover` holds no state, connects no signals, and starts no timers —
there is nothing to clean up, by construction; `disable()` is just
dropping the reference.

## Tiling subsystem (`lib/tiling/`)

Hyprland-style automatic tiling, built as an independent subsystem with
strict internal separation:

```
windowFilter.js   isLayoutMember() / isTileable() — pure classification,
                  no state
layoutEngine.js   LayoutTree (the dwindle split tree over opaque keys)
                  and the stacked geometry split. Pure, zero GNOME
                  imports, integer arithmetic.
stackTabBar.js    presentational St actor; told what to display, never
                  computes or tracks anything itself
tilingManager.js  the only stateful piece: signal lifecycles, per-
                  workspace layout mode, per-bucket trees + reconciliation,
                  debounced relayout, and the one place rectangles meet
                  Meta.Window
```

**The central design decision: a reconciled layout tree.** Each bucket
owns a `LayoutTree` — Hyprland's dwindle model made explicit as a binary
split tree over opaque keys — because the behavior that matters most,
*focus-aware insertion*, is structural: opening a window splits the
**focused** window's tile in half (the focused window keeps the left/top
half, the new one takes the right/bottom half) while every other tile is
left untouched, and closing a window hands its area back to its tree
sibling alone. A count-based stateless strategy fundamentally cannot
express either — it can reassign slots, but never change the split
*shape* around one leaf — which is why the first version of this
subsystem (stateless recompute, windows ordered by
`get_stable_sequence()`) documented exactly this as its accepted
trade-off and the tree as the future work.

The tree is structural state, but it is never *trusted*: every layout
pass still re-derives the bucket's membership from ground truth
(`workspace.list_windows()`, filtered by `windowFilter.js`) and
reconciles the tree against it — leaves whose window left the bucket are
pruned, windows that arrived are inserted, in creation order for
determinism. Reconciliation is idempotent, so callers reconcile-on-read.
This keeps the original philosophy (state re-synced from scratch on
every pass cannot go stale or corrupt, and recovers from any missed
event on the next one) while adding the one thing statelessness could
not provide: memory of *where* each window sits. The insertion anchor —
the toplevel focused at the instant `window-created` fires — is captured
synchronously by the manager, because by the time the debounced layout
pass runs, focus has usually already moved to the new window; the anchor
is consumed on first insertion, and falls back to the classic
dwindle-spiral tail whenever there is no usable anchor (enable-time
adoption, workspace merges, an anchor that closed or lives in another
bucket), which reproduces the old stateless layout bit-for-bit.

Membership is deliberately two-tier (`windowFilter.js`):
`isLayoutMember()` covers identity-level properties (window type,
transient parent, skip-taskbar, stickiness) and decides tree membership;
`isTileable()` adds the transient states (minimized, user-maximized,
momentarily unresizable) and decides who gets a rectangle *this pass*. A
member that is temporarily out — minimized, say — keeps its leaf while
its area flows to its sibling, so restoring it returns it to exactly the
slot it left instead of reinserting it somewhere new. Trees are dropped
wholesale on workspace removal, on monitor topology changes (monitor
indexes reshuffle, so reconciliation rebuilds each bucket in creation
order — same posture as the tab bars), and on `disable()`; an unmanaged
window is purged eagerly from every tree and anchor record rather than
waiting for the next pass, so no layout state ever outlives its
`Meta.Window`. Remaining future work on this structure: interactive
per-node operations (manual split ratios, node swaps) — the tree is now
the natural place for them.

**Layout math is pure and integer.** `LayoutTree.computeRects()` chooses
each split's axis at *compute* time from the aspect ratio of the area
being split (wider than tall → side by side, else stacked vertically),
so the same tree reflows correctly across monitor and work-area changes.
All arithmetic is integer — the first child of a split is rounded, the
second is defined as exactly the remainder — so there is no drift,
overlap, or rounding gap at any depth or fractional scale,
deterministically (verified by a standalone `gjs`/Node test over the
pure engine, including bit-for-bit equivalence of anchorless insertion
with the previous count-based strategy). The stacked layout needs no
structure — every window shares one content rectangle — so it stays a
pure geometry function (`computeStackGeometry`).

**Buckets.** The layout unit is (workspace × monitor). Under
`workspaces-only-on-primary` (this machine's default), Mutter marks every
window on secondary monitors on-all-workspaces, so each secondary monitor
is one workspace-agnostic bucket instead — tiled, but never stacked
(documented limitation; stacked mode is a per-*workspace* property and
those windows belong to no workspace).

**Event → relayout pipeline.** All events funnel into one debounced
queue: dirty workspaces accumulate in a `Set` and a single
`GLib.idle_add` flush lays out only those (plus the cheap secondary
buckets). Rapid bursts — an app spawning several windows, an
`insertWorkspace` shifting every window's workspace — coalesce into one
pass. Application is loop-proof: a window is only moved when its frame
rect differs from the target, so applying a layout converges rather than
re-triggering itself, and the manager deliberately does *not* listen to
size/position changes (only `grab-op-end`, which snaps a user-dragged
tiled window back into its slot).

**What floats** (see `windowFilter.js` for the full reasoning): non-NORMAL
window types (dialogs, utility, splash, menus, docks…), transients,
skip-taskbar windows, unresizable/unmovable windows, minimized windows
(GNOME users expect minimize to reclaim space; Hyprland has no minimize),
user-maximized windows (fighting an explicit maximize would be hostile,
and maximized windows ignore `move_resize_frame` anyway — but windows
that *open* maximized are un-maximized within a short post-tracking grace
period so they join the layout; on Wayland that state arrives after
`window-created`, so a creation-time check alone misses nearly every
real app — see GNOME_NOTES.md), and user-stickied windows. The transient
cases (minimized, maximized) keep their leaf in the layout tree while
floating, so they return to their exact slot. Fullscreen suspends the
entire bucket: nothing is resized or reflowed until fullscreen ends.

**Stacked mode** is Hyprland's stacked layout as a strategy plus one
piece of chrome: every tiled window gets the same content rectangle below
a tab bar (`stackTabBar.js`, one per monitor, added via
`Main.layoutManager.addChrome` — deliberately *without* `trackFullscreen`
and manually managed instead; see "the manager is the sole owner of
tab-bar visibility" below). The bar is told its window list and the
focused window; clicking a tab just calls `window.activate()` and the
manager observes the resulting `notify::focus-window` like any other
focus change — there is deliberately no local selected-tab state to
drift. Tab order is the layout tree's in-order traversal — the same
tree-order tabs Hyprland shows, which for sequentially opened windows is
simply creation order; titles update per-tab via `connectObject` bound
to the tab button so destruction disconnects automatically; overflow
compresses tabs equally with ellipsized labels, as Hyprland's own tab
bar does. The bucket tree persists through stacked mode — reconciliation
runs in both modes, so windows opened while stacked still take their
focus-anchored place in the tree — and toggling stacked off restores
that tiled arrangement.

**Stacked mode is a group posture: it requires at least two windows.**
`Shift+Super+S` on a workspace with fewer than two layout members is a
clean no-op (there is nothing to stack — a lone window under a one-tab
bar is strictly worse than the same window tiled full-area), and a
stacked workspace that *drops* below two members — the last-but-one
window closed, or moved to another workspace/monitor — automatically
reverts to tiled, giving the survivor the full work area back. The
auto-exit lives in `_flush()`, checked against the same ground truth the
buckets are reconciled with, so every membership-changing event heals
the mode on its own relayout pass. The count is of *members*, not
currently-tileable windows, deliberately: minimizing or maximizing one
of two windows is a transient state that keeps its tree slot, so it
keeps stacked mode alive too — only close/move genuinely end
membership, matching the user actions that should end the mode. Turning
stacked OFF is always allowed regardless of count, as a defensive
escape hatch. The workspace-movement shortcuts compose naturally with
all of this because a moved window fires `workspace-changed`, which
retiles both source and destination buckets whatever their modes.

**Focus** is never stolen: the manager never calls `focus()`; it only
`raise()`s the already-focused window in stacked buckets so the focused
window is the visible one.

**Which workspaces are stacked survives screen lock, deliberately not by
instance state.** The `disable()` around a screen lock is not optional or
extension-controlled: locking pushes GNOME's session mode to
`unlock-dialog`, and `js/ui/extensionSystem.js`'s
`_extensionSupportsSessionMode()` checks `metadata.json`'s `session-modes`
(defaulting to `['user']`, same as almost every user extension) against
both the current and the parent session mode — `unlock-dialog` declares
no parent mode of its own, so neither check passes and GNOME disables the
extension for the duration of the lock, re-enabling it on unlock
(verified against the extracted `js/ui/extensionSystem.js` and
`js/ui/sessionMode.js`; see GNOME_NOTES.md). That destroys and rebuilds
the whole `TilingManager` instance — correctly, for everything else in
it — but a per-workspace *user choice* like stacked-vs-tiled should not
silently reset just because the user stepped away. The fix is not
declaring `session-modes: ['user', 'unlock-dialog']` (that would keep the
*entire* extension — keybindings, tiling, focus border — live and
manipulating windows while the screen is locked, a real security/privacy
regression the user never asked for); instead, only the stacked-workspace
`Set` lives at module scope in `tilingManager.js` rather than on the
instance. ES modules stay cached for the life of the shell process (the
same fact `DEVELOPMENT.md` cites as the reason a code change needs a full
shell restart), so that one `Set` — and only that one — survives the
lock/unlock disable-then-enable cycle intact, while the layout trees,
insertion anchors, and every signal correctly rebuild fresh. It resets
only on a genuine new session (a fresh module load), which is the
expected "clean slate" moment.

**The manager is the sole owner of tab-bar visibility — the bars are
deliberately NOT `trackFullscreen` chrome.** The first version passed
`trackFullscreen: true` to `addChrome()`, and that single flag was the
root cause of two user-visible bugs that survived a first round of
plausible-looking fixes: `js/ui/layout.js`'s `_updateActorVisibility()`
**force-writes `visible`** on every `trackFullscreen` actor — from
`showOverview()`/`hideOverview()`, from fullscreen changes, and from
window restacks — so any `bar.hide()` this manager issued could be
silently overwritten a moment later. Concretely (all verified in the
extracted shell source): entering the overview with the Super key calls
`layoutManager.showOverview()` *before* emitting `showing` (our hide ran
last and stuck), but the 3-finger swipe-up gesture path emits `showing`
*first* and calls `showOverview()` after — force-reasserting
`visible = true` right after our hide, which is why the bar appeared over
a gesture-opened overview but not a Super-opened one. Likewise, restacks
during a 3-finger workspace switch kept re-showing a bar that had been
hidden at gesture start. Dropping `trackFullscreen` loses nothing: the
fullscreen case was already handled by `_syncTabBars()`'s own
`_bucketHasFullscreen` check (relayout-driven via `notify::fullscreen`),
and now no shell code ever fights this manager's `hide()`/`show()`
decisions.

**Tab bars hide for the whole lifetime of a workspace-switch gesture, as
a state, not an event.** `_syncTabBars()` treats "a 3-finger
workspace-switch swipe is in flight" exactly like it treats "the
overview is visible": a condition that forces every bucket bar-less on
every sync pass. The flag is raised by the swipe tracker's `begin`
signal (the same `Main.wm._workspaceAnimation._swipeTracker` private
field `gestureProgressTracker.js` and `focusBorder.js` already read,
with the identical optional-chaining/`typeof`/try-catch posture) — a
one-shot `hide()` on `begin` is *not* enough, because any relayout flush
landing mid-drag would re-show the bar for the still-active origin
workspace. The flag drops on `workspace-switched`, which for gestures
fires only when the settle animation completes and GNOME finally
`activate()`s the target — i.e. when the user has genuinely arrived —
or, for a *cancelled* swipe that snaps back to the origin (where
`workspace-switched` never fires at all; `workspaceAnimation.js` only
calls `activate()` when the landing workspace isn't already active), on
the tracker's `end` signal via the same clamped `round(endProgress)`
landing resolution GNOME itself uses (`findClosestWorkspace`). A wrong
prediction can only ever delay the bar's return until the next real
switch, never strand it. Keyboard/mouse switches are deliberately left
alone: the active workspace changes immediately there, the debounced
flush re-syncs the bar right away, and GNOME's own panel chrome behaves
the same way during those animations.

**The tab bar sits below notifications, not above them.** `addChrome()`
always repositions a newly-added actor directly below
`global.top_window_group` (verified against the extracted
`js/ui/layout.js`) — meaning the *last* chrome actor added ends up on top
of every chrome actor added before it, permanently. `Main.messageTray` is
added once, at shell startup, long before any extension enables; a tab
bar created afterwards would otherwise sit above it forever, visually
blocking notification banners (chat messages, low battery, …). The fix
is one explicit re-stack right after `addChrome()`:
`Main.layoutManager.uiGroup.set_child_below_sibling(bar, Main.messageTray)`
— `Main.messageTray` is a stable public reference (not a private reach),
so this is a one-line, version-safe correction rather than a new
private-API surface.

**Cleanup:** every signal id (display, workspace-manager, layout-manager,
overview, settings, per-window, and the two swipe-tracker connections) is
stored and disconnected in `disable()`; the idle source is removed; tab
bars are destroyed; the bucket trees and insertion-anchor records are
cleared (and are purged per-window the moment a window is unmanaged, so
they never hold a dead `Meta.Window`). Windows keep their last geometry —
they are ordinary movable windows and there is no meaningful "pre-tiling"
geometry to restore for windows that were tiled from the moment they
mapped (the same posture as every tiling WM).

**Anticipated future settings** the architecture already accommodates
without restructuring: layout type per workspace (mode key), split
ratios and node swaps (per-node state on the LayoutTree), smart gaps
(engine input), follow-focus behaviors (manager policy), animation
(application step).

## Focus border (`lib/focusBorder.js`)

A Hyprland-style hint border drawn around the currently focused window.
Deliberately built as its own module, entirely independent of
`lib/tiling/` -- a floating window gets a border exactly like a tiled
one, and the feature works with tiling disabled. This mirrors the
project's existing separation of concerns: one visual concern per
module, none of them aware the others exist beyond what `extension.js`
composes.

**Single-window tracking, not the tiling subsystem's per-workspace
bucketing.** Only one window can be focused at a time, so
`FocusBorderManager` needs none of `TilingManager`'s per-workspace/
per-monitor bucket machinery or debounced batch relayout -- it connects
to exactly one `Meta.Window`'s signals at a time (whichever is focused),
disconnecting the previous one on every focus change. This is
intentionally the simplest module in the project.

**Colors are always resolved to a concrete inline value, matching
`WorkspaceSquare._resolveBackgroundColor()` exactly** (user's hex, else
the system accent color via the shared `AccentColorTracker` instance,
else a hardcoded fallback literal) -- this was a real bug fix the first
time around (see "Settings → rendering" below), so the focus border
adopts the same discipline from day one rather than risking the same
flash-of-wrong-color bug on its very first focus change.

**Drawn entirely outside the window's frame**, expanded outward by the
configured border width on every side (a picture frame, never an
overlap) -- it can never obscure window content, and `reactive: false`
on the actor means it can never intercept a click either, so it's purely
decorative chrome layered via `Main.layoutManager.addChrome()`.

**Which windows qualify** is deliberately a *different* filter from
`lib/tiling/windowFilter.js`'s `isTileable()`, not a reuse of it: tiling
asks "should this be auto-arranged", the focus border asks "is this a
real user window worth highlighting" -- a focused dialog should get a
border despite never being tiled. Only `Meta.WindowType.NORMAL`,
`DIALOG`, and `MODAL_DIALOG` qualify; menus, tooltips, docks, the
desktop, and other chrome-ish types are excluded. Minimized and
fullscreen windows hide the border (nothing to highlight, or nothing
that should be drawn over a fullscreen surface).

**The one non-obvious problem this module had to solve: the border is
chrome, so it does not slide with GNOME's workspace-switch animation.**
The window group (containing the actual window actors) visually
translates during a switch, but a chrome actor sits in a separate layer
above it and stays put -- left alone, the border would appear to hang
motionless on screen while the real window slides away beneath it. Two
signals bracket every switch to hide-then-resync around this:

- `global.window_manager` (`Shell.WM`, a public GObject distinct from
  the private field below) emits `switch-workspace` at the start of
  every keyboard- or mouse-driven switch animation -- hides the border.
- A 3-finger swipe's live drag never touches this public signal at all
  (the active workspace doesn't change until the gesture commits, which
  is the whole reason `GestureProgressTracker` has to preview a guess
  rather than read ground truth -- see that section above). So this
  module ALSO connects, best-effort, to the exact same private field
  `GestureProgressTracker` already reaches into
  (`Main.wm._workspaceAnimation._swipeTracker`), purely for its `begin`
  signal, with the identical defensive posture (optional chaining,
  `typeof` guard, try/catch). A mismatch on some future GNOME build
  means the border merely lags for the live-drag portion of a gesture
  switch specifically -- corrected the instant `workspace-switched`
  fires, never a crash, never a stuck border.
- `global.workspace_manager`'s `workspace-switched` (the same
  authoritative signal the indicator and tiling subsystem already treat
  as ground truth) resyncs and re-shows the border once any switch --
  gesture or keyboard -- actually settles.

**Cleanup:** every signal id (display, window-manager, workspace-manager,
the optional swipe-tracker connection, overview, settings, accent-color,
and the currently-tracked window's five signals) is stored and
disconnected in `disable()`; the chrome actor is removed and destroyed.

## Panel auto-hide (`lib/panelAutoHide.js`)

Dock-style auto-hide for the GNOME top panel, off by default
(`panel-autohide`). Like the focus border, it is its own isolated module
that nothing else knows about beyond `extension.js` composition — and
with the setting off it has zero footprint beyond two settings signals.
Auto-hide never restyles, reparents, or `hide()`s the panel: only *how
it appears* changes, per the feature's design brief.

The module also owns the one deliberate exception to "never restyled":
the independent `panel-opacity` setting (default 100). Below 100 a
`background-color: rgba(0,0,0,a)` declaration is composed into
`Main.panel.style` — the stock top bar background is solid black in
every theme variant, so scaling the alpha fades the default look
faithfully. Composed rather than assigned, and re-asserted from a
`notify::style` handler, because overview.js overwrites that property
wholesale on overview transitions and nulls it after every overview
exit (see GNOME_NOTES.md). The write is idempotent (only when the
declaration is missing), so it cannot loop. At 100 nothing is ever
written; `disable()` strips only this module's declaration.

**Sliding uses `panelBox.translation_y` — the shell's own mechanism.**
GNOME's startup animation slides the panel with exactly this property
(`layout.js` sets `translation_y = -height` and eases to 0), so this
module moves the panel the way the shell itself does. It deliberately
never touches `panelBox.visible`: the panelBox is `trackFullscreen`
chrome, whose `visible` property `layout.js` owns and force-reasserts —
the exact trap discovered on the stacked tab bar (see GNOME_NOTES.md).
Cooperating instead of fighting means fullscreen behavior stays entirely
GNOME's: `layout.js` makes the box invisible in fullscreen, and the poll
loop simply never reveals while `panelBox.visible` is false.

**Space is reclaimed with public API only.** While active, the module
re-registers the panelBox's chrome tracking via
`Main.layoutManager.untrackChrome()` + `trackChrome()` (both public and
documented as each other's inverse) with `affectsStruts: false`, so the
top strut disappears and windows — including tiled ones, via the
resulting `workareas-changed` the tiling subsystem already listens to —
extend to the top edge. The revealed panel overlays windows, exactly
Ubuntu Dock's autohide model. On deactivation the original parameters
(`affectsStruts: true, trackFullscreen: true, affectsInputRegion: true`,
verified verbatim from the extracted `layout.js`) are restored. Struts
and input regions are computed from *transformed* positions, and on
Wayland the stage input region is not used at all
(`_updateRegions` checks `!Meta.is_wayland_compositor()`), so a
translated-away panel neither reserves space nor steals clicks.

**One poll loop instead of a web of triggers.** A single 100ms tick
calls `global.get_pointer()`, which answers *both* inputs this feature
needs — pointer position and held modifiers — and re-derives the
reveal/conceal decision from scratch: overview visible, active
workspace empty (no unminimized, taskbar-worthy window on the primary
monitor — nothing for the panel to obscure), Super held (MOD4, plus
`SUPER_MASK` defensively), an open panel menu
(`Main.panel.menuManager.activeMenu` — hiding would tear a menu off its
anchor), keyboard focus inside the panel (Ctrl+Alt+Tab), or the pointer
in the reveal band. The band is asymmetric on purpose — a 1px top edge
while hidden, the full panel strip while revealed — which is the
hysteresis that prevents flapping at the boundary. This is the same
recompute-from-ground-truth posture as the rest of the project: there
are no barriers, hot-edge actors, or global key grabs to leak or go
stale, a missed condition self-corrects on the next tick, and the cost
(one C call at 10Hz) is negligible. The trade-off, accepted: reveal
latency is up to one tick (~100ms), which reads as a deliberate
dock-like delay rather than lag.

**Cleanup:** `disable()` removes the poll source, cancels any running
slide transition, restores `translation_y = 0`, and re-registers the
panelBox with its original tracking parameters — the shell is bit-for-bit
back to stock. GNOME's own screen-lock disable/enable cycle composes
correctly for free: disable restores the panel, and re-enable re-applies
auto-hide only if the setting says so.

## Why `PanelMenu.Button` with no menu

GNOME's own bundled `workspace-indicator` extension (see
[`GNOME_NOTES.md`](GNOME_NOTES.md)) collapses into a dropdown menu once past
6 workspaces, or when workspaces are arranged in a vertical grid. This
project deliberately skips that: the design goal is squares that are always
visible, Hyprland-style, so `WorkspaceIndicator` is constructed with
`dontCreateMenu = true` and there is no equivalent fallback. In practice
this is fine — dynamic workspaces rarely grow past single digits, and this
extension only advertises `Super+1`..`Super+9` for direct jumps anyway.

## The four places this extension reaches outside its own schema

**1. `lib/keybindingManager.js`** reads and temporarily overwrites four
schemas it doesn't own (managed uniformly through one internal list, so a
newly discovered conflict is one entry, not another copy of the
save/clear/watch/restore lifecycle):

- `org.gnome.shell.keybindings` (`switch-to-application-1..9`)
- `org.gnome.mutter.keybindings` (`toggle-tiled-left`, `toggle-tiled-right`)
- `org.gnome.desktop.wm.keybindings` (`move-to-monitor-left/right` —
  GNOME's move-window-to-adjacent-monitor shortcut, bound to
  `<Super><Shift>Left/Right` by default, colliding with the
  move-window-to-new-workspace bindings)
- `org.gnome.shell.extensions.dash-to-dock` (`hot-keys`) — Ubuntu Dock's
  master switch for its *own, independent* `Super+1..0` "activate Nth
  pinned app" grabs. Only touched when the schema actually exists (looked
  up via `Gio.SettingsSchemaSource`, since constructing `Gio.Settings` on
  a missing schema aborts the shell process); on dock-less installs this
  is a silent no-op.

This exists because Mutter dispatches only one action per key accelerator,
and those defaults collide with `Super+1..9` / `Super+Left/Right`. The
*exact* prior value of each key (not the schema default) is saved in memory
before clearing, and restored on `disable()`. See
[`GNOME_NOTES.md`](GNOME_NOTES.md) for how each conflict was discovered and
verified — the Ubuntu Dock one in particular, because its symptoms
(`Super+N` intermittently launching a dock app) were indistinguishable
from the shell-schema race below and masked as it for a while — and the
trade-off this design was chosen over (an alternate modifier combo, which
a user explicitly declined in favor of this approach).

Known limitation: the backup is in-memory, scoped to one enable/disable
cycle. If GNOME Shell crashes while this extension is enabled (rather than
being cleanly disabled first), the cleared defaults stay cleared until the
next `disable()` runs. This is the same trade-off any extension taking this
approach accepts; see `docs/ROADMAP.md` for a possible mitigation.

**Why a bare clear-then-bind wasn't reliable.** The first version of this
manager just cleared the conflicting key and immediately called
`Main.wm.addKeybinding()`, which sometimes lost the race: GNOME's own
handler for e.g. `switch-to-application-5` lives on its *own* separate
`Gio.Settings` instance inside `windowManager.js`, not this manager's. A
write on our instance updates dconf and fires our own `changed` signal
synchronously, but GNOME's separate instance only learns of it
asynchronously, after a real dconf round trip. Depending on exact timing,
GNOME's original grab could still win, which is exactly what a user hit in
practice (`Super+5` intermittently launching the 5th dash favorite instead
of jumping to workspace 5). `_bindAll()` now defends against this two ways:
a one-shot re-clear-and-re-grab ~250ms later (`REASSERT_DELAY_MS`), giving
GNOME's async reaction time to finish before we grab last, and a persistent
watch on every cleared key (and on Ubuntu Dock's `hot-keys`) for as long as
the extension is enabled, which re-clears and re-grabs immediately if
anything repopulates one of them later. `_addKeybinding()` was also
silently ignoring `Main.wm.addKeybinding()`'s return value — a failed grab
now logs a `console.warn` instead of failing invisibly.

**Why the race defenses alone still weren't enough.** Even with the above,
`Super+N` kept occasionally launching a dock app, and `Super+5` with only
3 workspaces *always* launched the 5th dock app on a stock Ubuntu install.
That's because Ubuntu Dock's number-key grabs (see the third schema bullet
above) are registered by the dock extension itself and are completely
untouched by clearing `org.gnome.shell.keybindings` — a second live owner
of the same accelerators that no amount of re-clearing the first owner
could ever displace. Setting the dock's own `hot-keys` switch to `false`
makes the dock remove all of its grabs itself (it watches that key), which
eliminates the collision at the source rather than trying to out-race it;
it's re-asserted by the same delayed re-grab and conflict watch as the
other two schemas, and the user's prior value is restored on `disable()`.

**2. `lib/nativeIndicatorHider.js`** hides GNOME Shell's own Activities
button — the whole top-left button, not just the workspace dots it renders
(style class `.workspace-dot`; a real user running this extension found
both indicators visible side by side, which is how the dots were discovered
— see [`GNOME_NOTES.md`](GNOME_NOTES.md) for the Looking-Glass-based
investigation). The button is hidden via
`Main.panel.statusArea.activities.container.visible` (public actor
references only, no patching of `js/ui/panel.js`), re-asserted on
`Main.sessionMode` 'updated' because the panel's `_updatePanel()` →
`_addToPanelBox()` path calls `container.show()` on every indicator it
lays out (verified in the extracted panel.js). The `.workspace-dot` CSS
collapse in `stylesheet.css`, toggled by a marker class on `Main.panel`,
is kept as a defensive second layer. Both are gated behind the
`hide-native-activities-dots` setting (on by default), and a role or
class-name mismatch on some future GNOME version fails silently — the
button would simply show again — rather than breaking anything. The
button's jobs move to the `WorkspaceIndicator` itself, whose
`vfunc_event` mirrors the stock `ActivitiesButton` verbatim: a click on
the indicator's outer patch (not on a square) toggles the overview
behind the same `shouldToggleByCornerOrButton()` guard, and scrolling
anywhere over it switches workspaces via `Main.wm.handleWorkspaceScroll()`.

**3. `lib/accentColor.js`** reads (never writes) `org.gnome.desktop.interface
gtk-theme` so the active square's default fill follows Ubuntu's
Settings → Appearance accent-color picker, instead of a hardcoded blue.
This GNOME version has no standalone accent-color key (confirmed — see
[`GNOME_NOTES.md`](GNOME_NOTES.md)); Ubuntu's picker actually just switches
`gtk-theme` between Yaru color variants, so the module maps the theme name
to a hex value from a small table of the real, extracted accent colors for
each variant. Unrecognized (non-Yaru) themes resolve to `null`, and
`Tessera._resolveBackgroundColor()` falls back to
`stylesheet.css`'s hardcoded `#3584e4` in that case — same fail-quiet
posture as the other two reaches above. A user's own
`active-background-color` setting always takes priority over the detected
accent, exactly as it already did over the old hardcoded fallback.

**4. `lib/gestureProgressTracker.js`** reads (never writes) a private field,
`Main.wm._workspaceAnimation._swipeTracker`, so the active square previews
live during a 3-finger workspace-switch gesture instead of only updating
once the gesture settles. This is qualitatively different from the three
reaches above: those touch public GSettings schemas or a CSS class name,
both comparatively stable surfaces; this touches an underscore-prefixed
internal field of a private shell class, which carries no stability
guarantee across GNOME versions or distro patches at all.

Because of that, every access is deliberately defensive: optional chaining
down to the field, a `typeof ... === 'function'` check before connecting,
and a try/catch around the whole setup. If the field is missing or
restructured on some GNOME build, `enable()` silently leaves
`_swipeTracker` as `null` and the feature is simply inactive — the
indicator falls back to updating only on `workspace-switched`, identical to
every other behavior in this project. It also never calls
`workspace.activate()` itself: it only feeds a live index guess to
`WorkspaceIndicator._setActiveIndex()` for the visual preview, and the
authoritative `workspace-switched` handler always overwrites that guess
with the real answer — so even a wrong assumption about the gesture's
progress value can only ever produce an inaccurate *preview*, never
incorrect state. This was a deliberate design trade-off for a user who
plans to run this extension across multiple devices with potentially
different GNOME point-versions.

The progress value's semantics were misread twice (first as a raw delta,
then papered over with an outcome-based sign/scale self-calibration that
made the preview laggy and start-workspace-dependent) before being pinned
down: it is an **absolute fractional workspace index**, because
`WorkspaceAnimationController` confirms the swipe with one snap point per
workspace and GNOME itself resolves the gesture's final workspace as
`round(endProgress)`. `GestureProgressTracker` now applies that exact
same mapping — `clamp(round(progress))` — so the preview is live from the
very first gesture (no calibration pass, no blind first swipe), tracks
1:1 with finger travel in both directions, and additionally snaps the
preview to the final square the instant the `end` signal fires, instead
of trailing GNOME's settle animation. The assumption stays guarded: every
gesture's prediction is checked against the workspace GNOME really landed
on -- event-driven on the next `workspace-switched`, because GNOME only
activates the target when its settle animation *completes* (up to ~1s
with many workspaces; a fixed-delay check raced this and falsely tripped
the valve mid-session) -- and after `CONSECUTIVE_RESULTS_TO_TOGGLE`
consecutive misses the preview pauses itself with a `console.warn`
(falling back to settle-on-end), self-re-enabling after the same number
of consecutive correct predictions. So a semantics change in a future
GNOME can only ever cost the enhancement, not correctness. See
[`GNOME_NOTES.md`](GNOME_NOTES.md) for the full history and how to
re-verify the raw values via Looking Glass.

**Two later consumers of this same private field:** `lib/focusBorder.js`
(see below) connects to `Main.wm._workspaceAnimation._swipeTracker`'s
`begin` signal, purely to hide the focus border for the live-drag
portion of a gesture switch, and `lib/tiling/tilingManager.js` connects
to its `begin` and `end` signals to bracket the stacked-mode tab bars'
gesture-hidden state (see the tiling section above). Both reuse the
exact field this section documents rather than opening new ones, with
the identical defensive posture (optional chaining, `typeof` guard,
try/catch) -- so this remains one private-API surface with three
independent, equally fail-safe readers, not a fifth reach.

All four of the above are the only non-obvious, semi-invasive behaviors in
the codebase; everything else is scoped to this extension's own
`org.gnome.shell.extensions.tessera` schema.

## Settings → rendering

Every visual GSettings key is applied twice per square:

1. As a class name (`active`, `outline`) so `stylesheet.css` supplies
   sensible, theme-aware defaults.
2. As an inline style string (`Tessera.applySettings()`,
   `lib/utils.js:buildCssDeclarations`) built only from the settings the
   user has actually changed from their empty/sentinel default. Inline
   style always wins over the class rule, so a user who never touches
   colors gets pure theme-driven defaults, while one who sets a custom hex
   color overrides just that property.

This is why `stylesheet.css`'s structural properties (size, radius,
padding, font) are effectively dead code under normal operation — they
exist purely as a fallback for the brief window before the first
`applySettings()` call, and as living documentation of the schema defaults.

**Why ALL of the active square's colors are always explicit inline values.**
*Inactive* color properties are set to `null` (letting the neutral gray CSS
class rules show through) when the resolved value isn't a valid hex —
that's the intended "use the theme default" path. The *active* square is
the exception, in every color property: `_resolveBackgroundColor()` always
returns a valid hex when active (accent color, or `FALLBACK_ACTIVE_HEX` if
the accent can't be determined), and `_resolveTextColor()` likewise always
resolves active text to a concrete value (`#ffffff` on a filled square,
the accent color itself in outline mode). This was a real bug fix
delivered in stages, not speculative hardening: any active color left to a
stylesheet class rule leaked GNOME's stock blue on non-blue accents —
statically for outline-mode text, and as a transient flash during fast
`Super+Number` switches and gesture previews, because St's transition
engine interpolates through intermediate style states. Three things
together eliminate the whole class of leak:

1. Active colors are never omitted from the inline style (above).
2. `setActive()` applies the inline style *before* toggling the `.active`
   class, so no intermediate state ever resolves colors from the class
   rule alone.
3. `stylesheet.css` carries **no** colors on its `.active` rules anymore —
   there is simply no blue left anywhere for a transition to sample.

`lib/focusBorder.js`'s `_resolveColor()` and `.tessera-focus-border`'s
empty rule apply exactly this same three-part discipline from its very
first version, rather than risking rediscovering the bug a second time.
