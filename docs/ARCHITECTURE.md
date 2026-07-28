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
                           square during a 3-finger workspace-switch swipe,
                           in both the normal view and the overview (two
                           separate shell SwipeTrackers, same handlers).
                           The one genuinely private-API reach in this
                           project; mirrors GNOME's own progress-to-
                           workspace mapping (round of an absolute strip
                           index), verifies itself against every gesture's
                           real outcome, and no-ops safely if unsupported.
lib/windowMover.js         Focused-window and workspace-content actions:
                           moves the window between workspaces (incl.
                           inserting a brand-new workspace beside the
                           current one), swaps all contents of the current
                           workspace with another (Shift+Alt+N), and
                           toggles its maximized state.
                           Stateless composition of GNOME's own
                           Main.wm.actionMoveWindow / insertWorkspace /
                           Meta.Window.{,un}maximize; nothing to clean up
                           by construction.
lib/newWindowWorkspace.js  Optional "one app per workspace" placement (off
                           by default): decides whether a newly created
                           window should be relocated onto a workspace of
                           its own, and delegates the move itself to
                           WindowMover.moveToNewWorkspace. Owns one
                           window-created signal plus a one-idle-turn
                           deferral per candidate window (a just-created
                           window has not necessarily declared its
                           transient/skip-taskbar state yet).
lib/fullscreenManager.js   "Keybind fullscreen" (Super+F): true,
                           panel-covering fullscreen with exit triggers
                           (toggle key, a new app window, focused-Escape).
                           Tracks only windows IT fullscreened, so it never
                           interrupts an app's own video fullscreen. Owns a
                           window-created + focus signal and a dynamically
                           scoped Escape grab.
lib/tiling/                The automatic-tiling subsystem (see its own
                           section below). Nothing outside this directory
                           knows tiling exists except KeybindingManager
                           (dispatches the stacked and floating toggles)
                           and extension.js (composition).
lib/tiling/windowFilter.js Pure classification: layout membership
                           (identity-level, plus the injected user-float
                           override) vs current tileability (adds
                           transient states like minimized).
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
lib/quickMenu.js           Optional right-hand panel menu (off by default,
                           gated on enable-quick-menu): a PanelMenu.Button
                           whose popup is a segmented Overview | Tools | Keys
                           tab set (toggles + gap steppers; tool launchers +
                           recent-color/killed-port history; a read-only
                           keybinding reference). extension.js owns its
                           create/destroy lifecycle.
lib/launcher/              The launcher subsystem (off by default): a
                           Spotlight/Raycast-style search popup over
                           apps, windows, settings panels, extensions,
                           arithmetic, commands, the clipboard, and
                           every Tessera action. Its own document:
                           docs/LAUNCHER.md. Nothing outside this
                           directory knows it exists except extension.js
                           (composition) and KeybindingManager (which
                           dispatches launcher-toggle into it).
lib/portKiller.js          The "port killer" tool: a modal that SIGTERMs
                           whatever listens on a typed TCP port (lsof/ss
                           discovery) and records it in the killed-ports
                           history. Launched by a keybinding or the menu.
lib/colorPicker.js         The "color picker" tool: a full-screen overlay
                           modelled on GNOME's own PickPixel (GrabHelper +
                           BindConstraint + ClickAction + Shell.Screenshot.
                           pick_color) but with a large color lens/hex
                           readout trailing the pointer. Copies #RRGGBB to
                           the clipboard and records it in picked-colors.
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

Shift+Super+V --(Main.wm keybinding dispatch)--> KeybindingManager handler --> TilingManager.toggleFloating()

Shift+Super+F --(Main.wm keybinding dispatch)--> KeybindingManager handler --> WindowMover.toggleFocusedMaximize()

Super+F --(Main.wm keybinding dispatch)--> KeybindingManager handler --> FullscreenManager.toggleFocused()
Escape (grabbed only while a keybind-fullscreened window is focused) --> FullscreenManager --> Meta.Window.unmake_fullscreen()
global.display --(window-created)--> FullscreenManager (a new app leaves our fullscreens on its workspace)
Shift+Super+S --(same dispatch)--> KeybindingManager handler --> FullscreenManager.exitWorkspace(active) + TilingManager.toggleStacked()

window/workspace/monitor events --> TilingManager (debounced) --> layoutEngine (pure) --> Meta.Window.move_resize_frame()
                                                              --> StackTabBar (stacked workspaces only)

this-extension's GSettings --(changed::panel-autohide)--> PanelAutoHideManager --> layoutManager.{un,}trackChrome(panelBox) + poll loop --> panelBox.translation_y
Super+Z (panel-reveal-toggle; grabbed only while auto-hide active) --> PanelAutoHideManager latches _keyRevealLatched --> poll reveals/conceals panelBox
this-extension's GSettings --(changed::panel-opacity)---> PanelAutoHideManager --> composes rgba background into Main.panel.style (re-asserted on notify::style; nothing written at 100%)

Super+Space (launcher-toggle; NORMAL|OVERVIEW|POPUP) --> LauncherManager.toggle() --> LauncherPopup.open/close
LauncherPopup entry text --> SearchController.search() --> every enabled provider.query() --> fuzzyMatcher --> ranked sections --> LauncherList
LauncherPopup Enter --> SearchController.activate() --> HistoryManager.record() + result.activate() --> Shell.App / Main.activateWindow / TilingManager / WindowMover / ...
Shell.AppSystem --(installed-changed)--> AppProvider/SettingsProvider cache invalidation
global.display.get_selection() --(owner-changed, clipboard only)--> ClipboardProvider --> St.Clipboard.get_text --> capped strv in GSettings

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

The Shift+Super actions are deliberately thin compositions of GNOME
Shell's / Mutter's own methods rather than re-implementations — see
[`GNOME_NOTES.md`](GNOME_NOTES.md) for how each was verified against this
install's extracted source:

- **Move to workspace N** = `Main.wm.actionMoveWindow(window, workspace)`,
  the same method GNOME's built-in move-window keybindings call. It
  already handles destination-is-current (no-op), carries the window
  through the switch animation, and follows the window with focus —
  matching both GNOME's and Hyprland's follow-the-window behavior, which
  is why "follow" is the default rather than an option (a Hyprland-style
  "silent move" could be added later as a setting without restructuring).
- **Move to the trailing workspace** (`Super+0` / `Shift+Super+0`) =
  the same `activate` / `actionMoveWindow` aimed at index
  `n_workspaces - 1`. It addresses a *position*, not a fixed index, so
  unlike the 1–9 bindings it never falls out of range; under dynamic
  workspaces that position is always the empty workspace GNOME keeps at
  the end (`WorkspaceTracker` never culls it), making `Shift+Super+0`
  the "append a fresh workspace" counterpart to the insert-beside
  bindings below.
- **Move to new inserted workspace** = `Main.wm.insertWorkspace(pos)`
  followed by the same `actionMoveWindow`. GNOME already ships real
  workspace insertion (it uses it itself to prepend a workspace); an
  alternative design using `WorkspaceManager.reorder_workspace` was
  evaluated and rejected — it exists and would avoid shifting windows,
  but GNOME's own insertion path has every window-class edge case
  (transients, override-redirect, sticky) already handled and proven.
- **Toggle maximize** = `Meta.Window.maximize()` / `unmaximize()` on the
  focused toplevel (resolved via `find_root_ancestor()`, gated to `NORMAL`
  windows) — the ordinary maximize the window's own maximize button and a
  title-bar double-click produce, keeping the top panel and title bar.
  It needs no tiling-specific code: with tiling on, a user-maximized
  member is already an exclusive occupant (bucket suspends, tab bar
  hides), opening a new app already un-maximizes it
  (`TilingManager._exitMaximized`), and restoring re-tiles it; with tiling
  off it is a plain maximize. This is why it lives here — a focused-window
  action, not a tiling operation. (True panel-covering fullscreen is a
  *different* mode with its own exit rules; it lives in
  `lib/fullscreenManager.js`, below.)

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
- **Emptied origin workspaces** are still culled by GNOME's
  `WorkspaceTracker` (never the active or trailing one) — the cull is not
  *prevented*, it's the platform's dynamic-workspace model. It is only
  *deferred* past the follow animation: both move actions run through
  `_moveFollowing`, which, when the moved window was the source's last
  occupant, calls `Main.wm.keepWorkspaceAlive(source, ~400ms)` so the
  tracker removes it in a clean pass *after* the switch settles rather
  than on the next `BEFORE_REDRAW` mid-slide. Without this, culling the
  source during the animation reindexes every later workspace — including
  the destination's — which jerked the slide and briefly desynced the
  active-square highlight; most visible moving an app off the *viewed*
  workspace onto the *trailing* one, which culls the source and appends a
  new trailing in the same tracker pass. The keep-alive timer is GNOME's
  own (stored on the workspace, self-clearing), so `WindowMover` still
  owns no timer. Consequence unchanged: inserting a new workspace for a
  window that was *alone* nets out to no visible change (the source
  reappears as the freshly-inserted blank).
- **Race-freedom:** the insert-then-move sequence is synchronous within
  one dispatch, and the tracker's empty-workspace cleanup only runs in a
  `BEFORE_REDRAW` later, so it can never observe the half-done state.

`WindowMover` holds no state of its own, connects no signals, and starts
no timer it owns — there is nothing to clean up, by construction;
`disable()` is just dropping the reference.

## New-window placement (`lib/newWindowWorkspace.js`)

Optional, off by default (`new-window-new-workspace`): every newly opened
top-level application window is moved onto a workspace of its own and the
view follows it there. `new-window-adjacent-workspace` picks where that
workspace comes from — the **trailing** workspace at the end of the strip
(default; keeps workspace order chronological) or a **brand-new** one
inserted immediately right of the current workspace (keeps related work
adjacent, shifting every later workspace along). The second setting is
only read while the first is on, and its preferences row is desensitized
to match.

The module decides only *whether* a window qualifies; the move itself —
insertion, follow, and the emptied-source keep-alive — is
`WindowMover.moveToNewWorkspace`, so "move a window to a fresh workspace"
has exactly one implementation shared with the keybindings above.

Two exclusions define the behavior:

- **Identity gate.** Only `NORMAL`, non-transient, non-skip-taskbar,
  non-sticky windows are moved — the same "a real app window is opening"
  test the tiler uses (`TilingManager._opensAsTilingApp`), plus the sticky
  exclusion every workspace move in this extension applies. Dialogs stay
  with their parent; windows on secondary monitors under
  `workspaces-only-on-primary` (which Mutter marks on-all-workspaces) are
  workspace-independent and left alone.
- **Never manufacture an empty workspace when one already exists.** Two
  cases of one rule. A window that opens onto an empty workspace stays
  put: it already has a workspace to itself, and moving it would only
  leave a hole for `WorkspaceTracker` to cull while dragging the user
  elsewhere for no visible gain. This is also what makes the feature
  *settle* instead of marching forward on every window — open an app, land
  on a fresh workspace, and only its *second* window moves on. And a
  window that opens onto an *occupied* workspace while the workspace the
  user is **viewing** is empty is moved to the viewed one — an
  already-running app typically places a new window beside its existing
  ones, and inserting yet another empty workspace next to that one (then
  dragging the user off to it) is strictly worse than using the empty
  workspace they are already sitting on.

  **What counts as occupied is the same predicate as what counts as
  relocatable** (`_isContentWindow`: `NORMAL`, non-transient,
  non-skip-taskbar, non-sticky), and it has to be. When the two differed,
  a workspace holding nothing but a splash screen, a skip-taskbar helper
  or a stray dialog counted as occupied, so a window opening onto a
  *visibly* empty workspace was relocated off it anyway — the user's
  screen said "empty", the check said "occupied". Anything the feature
  would not bother moving is now equally something it does not count as
  being in the way.

The decision is deferred by one idle turn rather than taken synchronously
in `window-created`. A just-created window has not necessarily declared
its transient parent or skip-taskbar state yet — the same client-settling
lag `lib/tiling/tilingManager.js` documents around its own creation-time
checks — so an immediate test would misclassify exactly the popups this
must not touch. One idle turn later the client has committed, and the move
still lands before the user can act on the window. Each pending window
holds one idle source and one `unmanaged` handler, both torn down when the
turn runs, the window closes first, or `disable()` runs.

## Keybind fullscreen (`lib/fullscreenManager.js`)

`Super+F` is *true* fullscreen (`Meta.Window.make_fullscreen()` — covers
the whole monitor including the panel, no title bar), deliberately kept
separate from `Shift+Super+F` **Maximize** (which keeps the panel). Unlike
Maximize — a stateless one-liner in `WindowMover` because the tiler
already gives it every behavior it needs — fullscreen has *exit triggers*
that require state and signals, so it is its own module:

- **The toggle key** leaves it (plain).
- **Opening a new application window** leaves it, so the new window isn't
  hidden behind a fullscreen one — the same intent as the tiler's
  `_exitMaximized` for maximize, driven off `window-created`.
- **Toggling stacked mode** (`Shift+Super+S`) on the fullscreen window's
  workspace leaves it, so the layout toggle actually takes effect instead
  of staying hidden behind the fullscreen — the `exitWorkspace()` entry
  point, composed with `TilingManager.toggleStacked()` in
  `KeybindingManager` (the two modules stay mutually unaware; the
  dispatcher, which already holds both, clears fullscreen exactly as
  `toggleStacked` clears maximize, and only when tiling is enabled).
- **Escape**, while such a window is focused, leaves it.

**The one decision that makes this safe: the module only ever touches
windows the user fullscreened *through it*** (tracked in a `_fullscreened`
Set). A window that fullscreens *itself* — a video player, a game,
YouTube — is never tracked, so none of the exit triggers can ever
interrupt real fullscreen content. The Set is kept honest by a per-window
`notify::fullscreen` watch (drop it the instant it leaves fullscreen by
any means) and an `unmanaged` watch (drop it if it closes), so it can
never hold a window that is no longer in our fullscreen or no longer
exists.

**The Escape grab is scoped by focus, not by "something is fullscreen".**
It is added (`Main.wm.addKeybinding` on the internal
`window-fullscreen-escape` accelerator, default `Escape`) only while the
*focused* toplevel is one of our tracked windows, and removed the moment
focus moves elsewhere (re-synced on `notify::focus-window`). So Escape is
intercepted from exactly the one window the user is looking at in our
fullscreen — never globally, never from an ordinary window, never on
another workspace. Intercepting Escape from that focused window is the
accepted trade-off (an app that itself needs Escape, e.g. vim, won't
receive it while held in this fullscreen — which is why Maximize, not
this, is the everyday full-size mode, and why the accelerator is a
user-overridable schema key). This is the one place besides
`KeybindingManager` that grabs an accelerator, precisely because the grab
is *conditional on live window state* rather than static — a shape
`KeybindingManager`'s save/clear/watch/restore model doesn't fit.

The tiler and this module compose without knowing about each other: both
independently observe `notify::fullscreen`; when this module un-fullscreens
a window, the tiler sees the state change and resumes the bucket / restores
the tab bar on its own. **Cleanup:** `disable()` disconnects the
window-created and focus signals and every per-window watch, clears the
Set, and removes the Escape grab; windows keep whatever fullscreen state
they were in (never yanked out just because the extension is cycling, e.g.
around screen lock).

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
size/position changes in steady state (only `grab-op-end`, which snaps a
user-dragged tiled window back into its slot).

**The one exception: a post-creation settling watch.** A freshly mapped
window often finalizes its own size/position across several async
configures *after* `window-created`/`shown` — CSD frame extents arriving,
an opens-maximized state being undone, a multi-step Wayland configure
(Chromium/Electron apps are the worst offenders). The first layout pass
can land before that settles, so the window ignores the size we asked for
and keeps its own; the visible symptom is a tiled window whose **right and
bottom outer gaps vanish** (it is larger than its tile) while the left and
top look enlarged, stuck that way until some unrelated event triggers a
relayout that finally lands — the exact "wrong gaps after opening Brave on
a fresh workspace, fixes itself once I do something" report. Because a
plain relayout with the *same* work area heals it, the computed target was
always right; only the timing was wrong. So `_watchSettling` connects
`size-changed`/`position-changed` on the new window for a short grace
(`MAP_SETTLE_GRACE_MS`, 2.5s) and re-queues its layout on each, healing it
the instant the client stops fighting, then tears the watch down. It is
scoped to that grace, not permanent, precisely so it does not relayout on
every drag of a floating window or fight a user resizing a tiled one — and
even within the grace it skips the re-apply while a move/resize grab is in
progress (`get_grab_op`), deferring to the same `grab-op-end` snap as
steady state. The re-apply is loop-proof by the same frame-vs-target check
as everything else. The watch is torn down on grace-expiry, on `unmanaged`
(via `_untrackWindow`), and on `disable()`.

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
floating, so they return to their exact slot. On top of all of those
identity/state rules there is one *explicit* user override — a window
toggled to float with Shift+Super+V (see "Per-window floating" below) —
which `windowFilter` treats as a non-member exactly like a dialog.

**Exclusive occupants** (`isExclusiveOccupant`): a fullscreen window, or a
user-maximized layout member, covers its whole bucket, so having one
*suspends the entire bucket* — nothing is resized or reflowed, and the
stacked tab bar hides — until the state ends (`notify::fullscreen` /
`notify::maximized-*` drive the resume). Treating maximize the same as
fullscreen here is what stops a maximize from briefly "zooming" the other
tiles (they used to reflow to fill the maximized window's vacated slot,
pointlessly, since it covers them anyway — most visible with the panel
auto-hidden) and stops the tab bar from floating over a maximized window.
Two explicit user actions override a *maximize* rather than hiding behind
it — opening a new tiling app (`_onWindowCreated`) and toggling stacked
mode (`toggleStacked`) both call `_exitMaximized` first, so the action
lands on the real window set. The **tiler** deliberately never
force-exits *fullscreen* on either (a fullscreen video must not be
interrupted by an unrelated app) — a fullscreen window still suspends the
bucket and hides the tab bar until the user leaves it. Those same two
triggers *do* leave a **keybind**-fullscreen, but that is
`FullscreenManager`'s doing on its own tracked windows (see its section),
not the tiler's, and precisely never touches an app's own video
fullscreen — so the rationale here is intact.

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
fullscreen/maximize case is handled by `_syncTabBars()`'s own
`_bucketHasExclusiveWindow` check (relayout-driven via `notify::fullscreen`
and `notify::maximized-*`), and now no shell code ever fights this
manager's `hide()`/`show()` decisions.

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

**…but during that gesture the bar *slides* with its workspace instead of
just vanishing** (`_attachSwipeTabBars`). The real bars stay hidden (the
flag above); on `begin`, once GNOME's `WorkspaceAnimationController` has
built its per-monitor `MonitorGroup`s (each holding a `WorkspaceGroup`
that clones a workspace's window *actors* and slides on a `progress`
property), we drop a throwaway `StackTabBar` into each stacked
workspace's `WorkspaceGroup`, positioned monitor-locally like the window
clones — so it rides the exact same slide GNOME gives the windows: the
outgoing workspace's bar slides out, an incoming stacked workspace's
slides in. This mirrors, for chrome, what GNOME does for windows (a chrome
actor is never cloned into the animation on its own — the reason the plain
`hide()` was needed in the first place). It is the tiler's *second*
private reach past the swipe tracker — `switchData.monitors` and
`MonitorGroup._workspaceGroups` — so it carries the same posture: one
`try/catch`, everything optional-chained, and on any failure it falls back
to the real bars simply staying hidden for the gesture (the prior
behavior). The throwaway bars are owned by the animation groups —
`_finishWorkspaceSwitch` destroys those on settle/cancel, taking the bars
with them — and each removes itself from `_swipeTabBars` on `destroy`, so
the list self-cleans; `disable()` destroys any that a mid-flight gesture
left behind.

**The tab bar sits in the window layer, not the system-chrome layer.**
`addChrome()` always repositions a newly-added actor directly below
`global.top_window_group` (verified against the extracted
`js/ui/layout.js`) — i.e. in the chrome band *above* the panel, the
lock-screen shield (`screenShieldGroup`), the overview and notifications.
Left there, the bar drew *over* an auto-hidden panel sliding down, *over*
the lock screen, and over notification banners — it read as a free-
floating overlay, not as part of the workspace. The fix is one explicit
re-stack right after `addChrome()`:
`Main.layoutManager.uiGroup.set_child_above_sibling(bar, global.window_group)`.
`window_group` and `top_window_group` are both `uiGroup` children
(layout.js), so this drops the bar to just above the ordinary-window
group: below the panel, lock shield, overview, menus/tooltips
(`top_window_group`) and notifications — everything that should cover it
now does, purely by z-order, no extra signals — while it still draws
above ordinary app windows. This is what makes it behave like part of the
workspace: the auto-hide panel reveals over it, and the lock screen hides
it, for free. (`global.window_group` is a stable public reference, not a
private reach.)

**Cleanup:** every signal id (display, workspace-manager, layout-manager,
overview, settings, per-window, and the two swipe-tracker connections) is
stored and disconnected in `disable()`; the idle source is removed; tab
bars are destroyed; the bucket trees and insertion-anchor records are
cleared (and are purged per-window the moment a window is unmanaged, so
they never hold a dead `Meta.Window`). Windows keep their last geometry —
they are ordinary movable windows and there is no meaningful "pre-tiling"
geometry to restore for windows that were tiled from the moment they
mapped (the same posture as every tiling WM).

**Per-window floating is a membership override, not a third mode.** Tiled
and stacked are the two *layout* modes; floating is orthogonal — a
per-window user choice (Shift+Super+V → `toggleFloating`) to pop one
window out of whichever layout its bucket is in, mirroring Hyprland's
`togglefloating` (and the pop-out-and-float feel of Omarchy). It is
deliberately built as the counterpart to stacked mode's per-*workspace*
choice: a module-scoped `Set` of `Meta.Window` (`floatingWindows`), at
module scope for the identical reason `stackedWorkspaces` is — to survive
the disable()/enable() cycle GNOME runs around screen lock — keyed by the
mutter-owned window object (stable across that cycle) and pruned the
instant a window is unmanaged, so it never holds a dead window.

The whole mechanism is one line of classification plus one of placement.
Classification: `windowFilter`'s `isLayoutMember()` gained an *injected*
`floating` argument (the manager passes this Set to every filter call), so
a floated window simply stops being a layout member — it drops its tree
leaf, its siblings reclaim its area through the same reconciliation that
handles a closed window, and it rejoins (at the dwindle tail) when toggled
back. Keeping the filter pure by *injecting* the state rather than reading
a global preserves the "evaluated fresh every pass, nothing to go stale"
property the rest of the subsystem relies on. Because the override lives at
the `isLayoutMember` level, it cascades correctly and for free through
`isTileable`. `isExclusiveOccupant` is the one place that deliberately does
**not** consult the float set: a floating window that is fullscreened *or
maximized* covers the whole bucket, so — exactly like a tiled one — it must
suspend reflow and hide the stacked tab bar (a floating window sits below
the bar in z-order, so a maximized/fullscreen one would otherwise have the
tab strip drawn across its top). `isExclusiveOccupant` therefore checks
identity-level `isLayoutMember(window)` (no floating set), which is true for
both tiled and user-floated normal windows and false only for stray
maximized dialogs/popups. (Getting this wrong was a real bug: passing the
float set here left the tab bar drawing over a maximized floating window.)
One consequence of the injected parameter elsewhere: every
`.filter(isTileable)` call site had to become
`.filter(w => isTileable(w, floating))`, because `Array.filter` would
otherwise pass the *index* as the floating Set.

Placement (`_floatWindow`): on float the window is un-maximized if needed
(a maximized window ignores `move_resize_frame`), resized to a centered
rectangle at `floating-window-size` percent of its monitor work area
(default 65%), and raised. From then on the tiler never repositions it —
it is not a member, and the manager already ignores size/position changes
— so the user owns its geometry; each relayout pass only re-`raise()`s the
bucket's floated windows above the tiled ones (`_raiseFloating`, a
Hyprland-style always-above-tiling floating layer; `raise()` restacks
without stealing focus). The existing focus border needs no change —
`lib/focusBorder.js` already draws around floating windows.

**Anticipated future settings** the architecture already accommodates
without restructuring: layout type per workspace (mode key), split
ratios and node swaps (per-node state on the LayoutTree), smart gaps
(engine input), follow-focus behaviors (manager policy), animation
(application step), and per-window floating refinements (remembered
floating geometry per window; app-match rules that auto-float on open —
both just richer population of the `floatingWindows` Set).

## Focus border (`lib/focusBorder.js`)

A Hyprland-style hint border drawn around the currently focused window,
with a single configurable corner radius applied uniformly to every
window (there is no API to read an app's own radius, so it is a user
setting rather than something matched per app). Deliberately built as
its own module, entirely independent of
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

**Only a real occupant of the current workspace is bordered.** The guard in
`_sync()` excludes on-all-workspaces (sticky) windows and any window not
literally on the active workspace. This is what keeps an *empty*
workspace border-free: a sticky window (e.g. secondary-monitor windows
under "workspaces only on primary", or a pinned window) counts as present
on every workspace, so without this it would get a border on a workspace
that looks empty.

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
declaration is missing), so it cannot loop. The same declaration pins
`transition-duration: 0ms` (stripping the theme's/overview's own first):
the stock theme sets a permanent 250ms transition on `#panel`, so
without this the re-applied background would *fade* back from solid
black over 250ms every time overview clobbered the style — the
"split-second flash" on a 3-finger swipe out of the overview — instead
of snapping. At 100 nothing is ever written (the shell's
`transition-duration` is left untouched); `disable()` strips only this
module's declaration.

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

**One consequence of releasing the strut: the overview search entry.**
The overview's `ControlsManagerLayout` positions everything from
`getWorkAreaForMonitor().y` (its `_workAreaBox`), which normally starts
*below* the panel because of the strut — with the strut released it
starts at the monitor top, so the "Type to search" entry lands under the
panel (which is revealed in the overview). The module gives
`Main.overview.searchEntry` a `margin-top` of ~1.9x the panel height
while auto-hide is active (`_syncOverviewTopMargin`, refreshed on each
overview `showing` so it tracks the current panel height), which grows
the entry's box and flows the whole top-anchored stack down clear of the
panel; the bottom-anchored dash is untouched. It is cleared when
auto-hide turns off (the returning strut makes the overview reserve the
panel on its own), and the whole thing is guarded so a future shell
change costs only the offset, never a crash. Preferred over
re-asserting the strut in the overview, which would churn a
`workareas-changed` retile of every window on each overview open/close.

**One poll loop instead of a web of triggers.** A single 100ms tick
calls `global.get_pointer()` for the pointer position and re-derives the
reveal/conceal decision from scratch: overview visible, active
workspace empty (no unminimized, taskbar-worthy window on the primary
monitor — nothing for the panel to obscure), the reveal keybinding's
latch (below), an open panel menu
(`Main.panel.menuManager.activeMenu` — hiding would tear a menu off its
anchor), keyboard focus inside the panel (Ctrl+Alt+Tab), or the pointer
in the reveal band. The band is asymmetric on purpose — a 1px top edge
while hidden, the full panel strip while revealed — which is the
hysteresis that prevents flapping at the boundary. This is the same
recompute-from-ground-truth posture as the rest of the project: there
are no barriers or hot-edge actors to leak or go
stale, a missed condition self-corrects on the next tick, and the cost
(one C call at 10Hz) is negligible. The trade-off, accepted: reveal
latency is up to one tick (~100ms), which reads as a deliberate
dock-like delay rather than lag.

**The keyboard reveal is a grabbed accelerator, not a polled modifier**
(an ordinary key like `Z` never appears in the pointer's modifier mask).
`panel-reveal-toggle` (default `Super+Z`, customizable in Preferences) is
grabbed only while auto-hide is active — added in `_activate()`, removed
in `_deactivate()`, so it never consumes `Super+Z` when the feature is
off — and its handler flips a `_keyRevealLatched` boolean that
`_shouldReveal()` honors like any other condition: press to show, press
to hide.

**Cleanup:** `disable()` removes the poll source, releases the reveal
keybinding grab, clears the overview search-entry margin, cancels any
running slide transition, restores `translation_y = 0`, and re-registers
the panelBox with its original tracking parameters — the shell is
bit-for-bit back to stock.

**Screen lock:** the extension declares `"session-modes": ["user",
"unlock-dialog"]`, so lock does NOT disable it. Auto-hide stays active
across the lock — deactivating would restore the strut and reflow/retile
every window on each lock and unlock — and instead simply force-reveals
the panel while `Main.sessionMode.isLocked` (the unlock dialog's clock
and battery must be visible) and lets the normal conditions resume on
unlock. The opacity styling likewise contributes nothing while locked,
deferring to the lock screen's own `unlock-screen` panel style. The
indicator hides its own container on the lock screen, and the
Activities-button hiding persists — which is the whole point: no
per-lock flash of restored-then-rehidden panel state (see
GNOME_NOTES.md).

## Launcher subsystem (`lib/launcher/`)

A native Spotlight/Raycast-style search popup, off by default
(`enable-launcher`). It has its own full document —
[`LAUNCHER.md`](LAUNCHER.md) — covering the search pipeline, the
providers, ranking, the theme system, keyboard/mouse handling,
performance and security. Only the parts that matter to *this* document
(how it fits the rest of the extension) are repeated here.

**It is the second subsystem, built on the same rules as `lib/tiling/`:**
a directory nothing outside it imports except `extension.js`
(composition) and `KeybindingManager` (which dispatches one accelerator
into it), with strict internal separation:

```
constants.js / utils.js / fuzzyMatcher.js / calculatorEngine.js
                  pure, zero GNOME imports, unit-tested outside the shell
searchResult.js / searchProvider.js
                  the record every provider emits and the contract it
                  implements
searchController.js
                  the ONLY place that ranks or groups anything
keyboardController.js
                  the ONLY place that decides what a key means
launcherUI.js / launcherPopup.js / theme.js
                  drawing, the modal grab, and settings-to-CSS
*Provider.js / actionRegistry.js / iconProvider.js /
historyManager.js / favoritesManager.js
                  data sources and stores; none of them touch an actor
```

**The organising rule: providers never render, the UI never searches, and
nothing else ranks.** That is what makes a new provider a new subclass
plus four registration lines rather than a change to the controller, the
UI, the ranking or the popup — the extensibility the feature was asked
for, expressed as a constraint rather than as a plugin API.

**Results are recomputed from scratch on every keystroke**, the same
"re-derive from ground truth, never trust cached state" posture the
tiling subsystem takes with its layout trees. What *is* cached is only
what is expensive and externally invalidated: the installed-app list
(rebuilt on `Shell.AppSystem`'s `installed-changed`) and the
settings-panel list. Windows come straight from Mutter's tab list, so a
closed window can never be listed.

**Two pieces of state deliberately outlive a single search**, both in
GSettings rather than in memory: launch frecency (`launcher-history`) and
pins (`launcher-favorites`). Favorites store *keys*
(`apps:firefox.desktop`), never resolved objects, so a pin survives an
app being uninstalled and reinstalled and a key that no longer resolves
is skipped rather than erroring.

**The one genuinely new integration problem: "the focused window" is not
knowable at activation time.** The popup holds a modal grab, so by the
time an action runs, live focus is not necessarily the window the user
was looking at when they started typing. Rather than guess, the popup
captures `global.display.focus_window` when it opens and passes it
explicitly. That is why `WindowMover.moveFocusedToWorkspace/
moveFocusedToLastWorkspace/moveFocusedToNewWorkspace/
toggleFocusedMaximize`, `TilingManager.toggleFloating` and
`FullscreenManager.toggleFocused` each gained one optional trailing
window parameter, defaulting to the existing "resolve from focus"
behavior for every existing caller. A captured window whose actor is
already gone (it closed while the launcher was open) falls back to live
focus. `WindowMover` also gained a public `moveToWorkspace(window,
index)` — the general form its own `moveFocusedToWorkspace` now delegates
to — because the launcher's `move firefox 4` grammar addresses a window
by name rather than by focus.

**Keybinding conflict handling gained one refinement for this feature.**
`Super+Space` is GNOME's `switch-input-source`, so it joins the existing
save/clear/watch/restore machinery in `KeybindingManager` — but
*conditionally*: the input-source keys are cleared only while the
launcher is enabled **and** its accelerator genuinely collides with them
(`_inputSourceConflicts()` compares the actual accelerator values). A
user who never enables the launcher, or who rebinds it, keeps
input-source switching untouched. The managed-schema list therefore
allows an entry's `keys` to be a function evaluated at bind time, and
`_activeManagedSchemas` records which entries were in force so restore
walks exactly the same list. Toggling either setting rebinds outright
rather than patching the difference, keeping one uniform lifecycle. The
launcher accelerator is also the only one registered with
`Shell.ActionMode.POPUP` on top of `NORMAL | OVERVIEW` — that is what
lets a second press close the launcher from under its own modal grab.

**Cleanup:** with `enable-launcher` off the subsystem's entire footprint
is a constructed object with null fields — no providers, no popup, no
caches, no signals beyond the two settings watchers `enable()` installs.
Turning it off or disabling the extension closes and destroys the popup
(releasing the modal grab), disables every provider (each disconnects its
own signals: the app system's `installed-changed`, the clipboard
selection's `owner-changed`), cancels the warm-up timeout and drops the
icon cache.

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
try/catch) -- so the *swipe tracker* remains one private-API surface with
three independent, equally fail-safe readers.

The tab-bar slide (`_attachSwipeTabBars`) reaches one level deeper on
`begin` -- `_workspaceAnimation._switchData.monitors` and each
`MonitorGroup._workspaceGroups` -- to parent throwaway bars into the
sliding groups. This is the one genuinely *new* private surface added
beyond the swipe tracker, and it is the most volatile (it depends on the
animation's internal actor tree, not just a signal), so it is wrapped in
a single `try/catch` that abandons the whole enhancement on any shape
mismatch, leaving the bars hidden exactly as the pre-slide code did. It
never affects layout correctness -- only whether the bar slides or blinks
during a ~250 ms gesture.

**What the launcher subsystem adds to this list.** It opens no new
private-API surface at all, but it does widen two of the four above and
add one small read-only schema:

- `lib/keybindingManager.js` (#1) additionally clears
  `org.gnome.desktop.wm.keybindings switch-input-source` /
  `switch-input-source-backward` — but *only* while the launcher is
  enabled and its accelerator actually collides with them (see the
  launcher section above). Same save/clear/watch/restore lifecycle,
  same exact restore.
- `lib/accentColor.js`'s settings object (#3) is also read for
  `color-scheme`, so the launcher can follow the light/dark preference.
  Still read-only, still the same schema, still no new Gio.Settings
  instance.
- `lib/launcher/commandProvider.js` reads (never writes)
  `org.gnome.desktop.default-applications.terminal`'s `exec`/`exec-arg`
  to run a command in a terminal — the same two keys GNOME's own Alt+F2
  run dialog reads for the same purpose, looked up through the schema
  source so a system without it degrades to a notification instead of
  aborting the shell.
- `lib/launcher/actionRegistry.js` calls logind's public
  `org.freedesktop.login1.Manager` D-Bus interface for Hibernate, which
  GNOME's own `SystemActions` does not expose. That is an external
  system service with a stable published interface, not a shell
  internal, and the action only appears once `CanHibernate` has
  confirmed support.

Everything else the launcher touches is public Shell/Mutter API
(`Shell.AppSystem`, `Shell.AppUsage`, `Shell.WindowTracker`,
`Shell.BlurEffect`, `Main.pushModal`, `Main.activateWindow`,
`Main.extensionManager`, `Meta.Selection`) — see
[`GNOME_NOTES.md`](GNOME_NOTES.md) for how each was verified.

All of the above are the only non-obvious, semi-invasive behaviors in
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
