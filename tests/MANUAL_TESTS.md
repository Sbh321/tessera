# Manual Test Checklist

GNOME Shell extensions run inside the compositor process, so there is no
practical automated test harness for the panel indicator or keybindings
themselves (see [`../docs/DEVELOPMENT.md`](../docs/DEVELOPMENT.md) for why).
`schema-validate.sh` covers what *can* be automated. Everything else below
is a manual pass, done after `scripts/dev-symlink.sh` and enabling the
extension.

## Placement and Activities-button hiding

- [ ] Indicator appears in the left panel box by default; switching
      `panel-position` in Preferences to center/right moves it live, no
      re-enable needed.
- [ ] With `hide-native-activities-dots` on (default), GNOME's whole
      Activities button is gone from the top-left — no dots, and no
      leftover clickable strip that toggles the overview. Confirm via
      Looking Glass (`Alt+F2`, `lg`,
      `Main.panel.statusArea['activities']`) if unsure which widget
      you're looking at.
- [ ] The indicator takes over the button's job: clicking the hover
      patch AROUND/BETWEEN the squares (not a square itself) toggles the
      Activities overview, and clicking it again inside the overview
      leaves it. Clicking an individual square still switches to that
      workspace without opening the overview.
- [ ] Scrolling the mouse wheel anywhere over the indicator switches
      workspaces, exactly like scrolling over the stock Activities
      button.
- [ ] Toggling `hide-native-activities-dots` off in Preferences brings the
      native button (dots included) back immediately, without disabling
      the whole extension.
- [ ] Disabling the extension restores the native button even if it was
      hidden at the time.
- [ ] Lock (Super+L) and unlock with the setting on: the Activities
      button never appears — not on the lock screen, not as a flash
      during the lock or unlock transition (the extension keeps running
      in the unlock-dialog session mode and re-hides it whenever the
      panel re-shows indicators on session-mode changes). The workspace
      squares are also absent from the lock screen's panel, and
      reappear immediately on unlock.

## Accent color

- [ ] With `active-background-color` left empty (default), the active
      square's fill matches your current Settings → Appearance accent
      color (e.g. red, blue, purple).
- [ ] Changing the accent color in Settings → Appearance while the
      extension is running updates the active square's color live, no
      re-enable needed.
- [ ] Setting a custom `active-background-color` in Preferences overrides
      the accent color; clearing it back to empty reverts to following the
      accent again.

## 3-finger swipe gesture preview

- [ ] The very FIRST swipe after logging in (or re-enabling the extension)
      already previews live — there is no calibration pass anymore (this
      was a reported bug: the preview used to be dead for the first
      gesture and laggy/start-workspace-dependent afterwards).
- [ ] Swiping across multiple workspaces (e.g. 1 to 5) highlights each
      intermediate square *as the swipe passes it*, roughly when the
      screen content is more than half-way onto that workspace — not only
      after stopping. Traverse continuously without pausing on any
      workspace; the highlight must keep up with the finger.
- [ ] Test both directions specifically: left-to-right and right-to-left
      should feel equally responsive, with similar finger travel needed
      per workspace step.
- [ ] The SAME live preview works inside the overview: press Super once
      (window picker, workspace thumbnails on top) and 3-finger swipe
      horizontally — intermediate squares highlight as the strip passes
      them, and lifting the fingers snaps the highlight to the final
      workspace immediately, exactly like in the normal view. Repeat
      from the app grid (double Super). Clicking a workspace thumbnail
      in the overview also updates the indicator instantly (that path
      commits the switch immediately and always worked via
      workspace-switched).
- [ ] Lifting the fingers snaps the highlight to the final workspace
      *immediately* — it must not trail GNOME's settle animation by a
      beat.
- [ ] Releasing the gesture partway (settling on, say, workspace 3 instead
      of continuing to 5) leaves the correct square (3) highlighted, not
      whatever was last previewed. A cancelled swipe (small nudge,
      released) leaves the original square highlighted.
- [ ] Swipe to the trailing (empty) workspace and IMMEDIATELY launch an
      app (within ~1s, e.g. from the dock). GNOME's own race applies —
      the switch only commits when the settle animation completes, so
      the app may land on the origin (second-last) workspace and the
      switch may never commit — but the indicator must repaint the REAL
      active workspace within ~1.5s (the verify fallback) instead of
      keeping the predicted trailing square highlighted until the next
      manual switch.
- [ ] The indicator must never get stuck on a stale preview square — it
      always resyncs on gesture end. If the preview ever disagrees with
      where gestures actually land twice in a row, it pauses itself with a
      `tessera:` warning in
      `journalctl --user _COMM=gnome-shell` (and re-enables after two
      correct outcomes) — in normal operation that warning must never
      appear (see [`../docs/GNOME_NOTES.md`](../docs/GNOME_NOTES.md) on
      the absolute progress-index mapping if it does).
- [ ] Longevity: use swipes normally for several minutes — including slow
      lazy swipes across many workspaces (their settle animation takes
      >1s) and quick cancelled nudges — and confirm the live preview stays
      live the whole time. This was a real regression: a fixed-delay
      ground-truth check raced GNOME's settle animation and silently
      paused the preview a few swipes into every session.
- [ ] Swipe as fast as possible across several workspaces. The active
      square should stay in your accent color throughout — it must never
      flash the old default blue (`#3584e4`) partway through, even on a
      non-blue accent (this was a real bug, twice: see
      [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md), "Why ALL of
      the active square's colors are always explicit inline values").

## Core indicator

- [ ] Panel shows one square per workspace, numbered from 1.
- [ ] Switching the label style in Preferences (numbers → roman →
      devanagari → letters → letters-lower → devanagari-letters → dots)
      relabels every square live, including after workspaces are
      added/removed; setting an invalid value by hand
      (`gsettings set ... label-style bogus`) falls back to numbers
      without errors.
- [ ] The active workspace's square is visually distinct (fill/outline per
      current `indicator-style`).
- [ ] Clicking a square switches to that workspace.
- [ ] Switching workspaces by any other means (keyboard, Activities overview,
      `wmctrl`) updates the active square within one redraw.
- [ ] Creating a new workspace (drag a window to the empty last workspace in
      the overview) adds a square immediately.
- [ ] Removing a workspace (close its last window when
      `dynamic-workspaces=true`) removes its square immediately, and all
      later squares renumber correctly.
- [ ] `show-empty-workspaces` toggle: with it off, the single trailing empty
      workspace GNOME always keeps is hidden; turning it back on reveals it
      without needing to restart the shell.

## Keybindings

- [ ] `Super+1`..`Super+9` jump directly to the corresponding workspace
      (creating it first if `dynamic-workspaces` needs to grow — GNOME does
      this automatically when you activate a workspace index that doesn't
      exist yet only up to `n-workspaces`; jumping past the last one is a
      no-op, which is correct).
- [ ] `Super+Left` / `Super+Right` move to the previous/next workspace and
      correctly wrap or stop at the ends the same way GNOME's own
      `switch-to-workspace-left/right` does (compare behavior with those
      bindings before installing, to confirm parity).
- [ ] With the extension enabled, `Super+1`..`Super+9` no longer launches
      pinned dash apps, and `Super+Left/Right` no longer snaps the window to
      half-screen.
- [ ] Hold down e.g. `Super+1`/`Super+2` alternately as fast as you can
      manage for a few seconds. Every press switches workspace, none ever
      launches a dock app, and the active square keeps your accent color
      throughout — no blue flash on any press (see
      [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md), "Why ALL of
      the active square's colors are always explicit inline values").
- [ ] While enabled, `gsettings get org.gnome.shell.extensions.dash-to-dock
      hot-keys` reports `false` (on an install with Ubuntu Dock / Dash to
      Dock); setting it back to `true` by hand is immediately reverted to
      `false` by the conflict watch.
- [ ] Disabling the extension (`gnome-extensions disable ...`) restores
      `Super+1`..`Super+9` app-switching (including the dock's `hot-keys`
      value) and `Super+Left/Right` window snapping to exactly what they
      were before enabling — including if you had customized them yourself
      beforehand.
- [ ] Toggling `enable-custom-keybindings` off in Preferences while the
      extension is running immediately releases the keybindings and restores
      the GNOME defaults, without needing to disable/re-enable the whole
      extension. Toggling it back on re-applies the override.
- [ ] Editing an accelerator field in Preferences (e.g. changing Workspace 3
      from `<Super>3` to something else) takes effect immediately, no
      restart needed.
- [ ] With only 3 workspaces existing, pressing `Super+5` is a clean no-op
      — it must never launch the 5th pinned dock app. Repeat this
      immediately after every enable and after a fresh login several times
      in a row; this was the specific failure that exposed Ubuntu Dock's
      own independent `hot-keys` grabs, on top of the shell-schema race
      the re-assert/watch logic was added for (see
      [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) and
      [`../docs/GNOME_NOTES.md`](../docs/GNOME_NOTES.md)).
- [ ] Check `journalctl --user _COMM=gnome-shell` for
      `tessera: failed to grab keybinding` warnings after
      enabling — there should be none in normal operation.

## Window movement (Shift+Super)

- [ ] `Shift+Super+N` moves the focused window to workspace N and follows
      it there with the window still focused; all other windows on both
      workspaces stay put. Test from every workspace to every workspace,
      with single and multiple windows.
- [ ] `Shift+Super+N` with N pointing at the current workspace, or at a
      workspace number that doesn't exist, is a clean no-op — and never
      launches a dock app ("launch new instance of pinned app" is Ubuntu
      Dock's default for exactly these combos).
- [ ] With focus on the desktop (no window focused), every Shift+Super
      binding is a clean no-op — no errors in the journal.
- [ ] Focus a modal/attached dialog (e.g. a file chooser) and press
      `Shift+Super+N`: the parent window moves together with its dialog —
      the dialog is never separated from its window.
- [ ] A fullscreen window stays fullscreen after moving; a maximized
      window stays maximized.
- [ ] **Emptying the viewed workspace onto the trailing one is smooth.**
      Set up 6 workspaces (5 with one window each, 6th the trailing
      empty). On workspace 1, `Shift+Super+6` to move its only window to
      the trailing workspace: the slide to the destination is smooth — no
      mid-animation jump/jerk — and the emptied source (1) disappears
      cleanly *after* you arrive, not during the slide. The indicator's
      active square is correct throughout and never flickers to a wrong
      square; final state is 5 windowed workspaces + 1 trailing empty with
      the moved window's workspace active. Repeat from other workspaces
      and moving to other targets — no stale/extra square lingers beyond a
      brief moment, no errors in the journal.
- [ ] `Shift+Super+Right` on workspace 3 of 6 inserts a new workspace
      between 3 and 4 with only the focused window on it, and follows it;
      the original workspaces 4-6 are now 5-7 with their windows intact.
      `Shift+Super+Left` inserts between 2 and 3 likewise.
- [ ] After the insert, if the origin workspace still has windows it
      survives; if it was left empty it is culled by GNOME's dynamic
      workspace tracking (expected — consequence: inserting for a window
      that was *alone* on its workspace nets out to no visible change).
- [ ] The indicator's square count and active square stay correct through
      every move and insert, including during/after a 3-finger swipe done
      immediately afterwards (no stale preview square).
- [ ] Drag-reorder a workspace thumbnail in the Activities overview: the
      indicator's active square updates (workspaces-reordered signal).
- [ ] With `Super+Shift+Left/Right` before enabling the extension moving
      the window to the adjacent *monitor* (GNOME default), disabling the
      extension restores exactly that behavior (`move-to-monitor-left/right`
      values restored).
- [ ] Multi-monitor, `workspaces-only-on-primary=true` (this install's
      default): a focused window on a secondary monitor is a clean no-op
      for every move binding (those windows are effectively sticky);
      windows on the primary move normally.

## Tiling

- [ ] Open 1 window: it fills the work area minus outer gaps. Open a
      2nd: 50/50 side-by-side. A 3rd (with the 2nd still focused):
      splits the second half vertically (dwindle spiral). Continue to
      ~10 windows: every split stays gap-consistent with no overlaps or
      holes.
- [ ] **Focus-aware insertion**: with two windows side by side, focus
      the LEFT one and open a third — it splits the *left* tile (left
      window keeps the top/left half, newcomer takes the other half);
      the right window must not move by a single pixel. Repeat with the
      RIGHT one focused: only the right side splits.
- [ ] With 4+ windows, focus one of the *early* windows (e.g. the big
      left one) and open a new window: only that window's tile splits;
      every other tile stays exactly where it was.
- [ ] Focus a floating window (a dialog) or the desktop and open a new
      tileable window: it joins at the spiral tail (the classic
      position), no errors in the journal.
- [ ] Close windows in various orders (first, middle, last): the closed
      window's space goes to the window(s) it was split against — the
      rest of the layout does not reshuffle — and never leaves stale
      geometry.
- [ ] Rapidly open several windows at once (e.g. shell-loop launching 5
      terminals): exactly one final layout, no flicker storm, no
      overlaps.
- [ ] Dialogs (file choosers), splash screens, and utility windows float
      above the tiling and are never resized into the layout.
- [ ] Minimize a tiled window: its neighbors reclaim the space. Restore:
      it returns to the *exact slot* it left, even if other windows were
      focused in between.
- [ ] Maximize a tiled window: it floats at full work area (not fought);
      unmaximize: it returns to its previous slot. An app that *starts*
      maximized joins the layout tiled. While it stays maximized its tiled
      siblings are **not** reflowed — they hold their slots behind it (no
      brief "zoom" of the other tiles, most visible with the top panel
      auto-hidden); unmaximize retiles everything back.
- [ ] Fullscreen a window: nothing on that workspace/monitor is
      resized while it's fullscreen; leaving fullscreen restores the
      layout.
- [ ] **A new app drops an existing maximize.** With one window maximized
      on a workspace, launch another app on that same workspace: the
      maximize is released and both windows tile. Opening a *dialog or
      transient* (e.g. a file chooser) does **not** break it, and a
      maximize on a *different* workspace is untouched. A **true
      fullscreen** window is deliberately left alone — opening an app does
      not kick it out of fullscreen (a fullscreen video keeps playing).
- [ ] Drag-move a tiled window and release: it snaps back into its slot
      (grab-op-end).
- [ ] Panel/dock avoidance: tiles never underlap the top panel or Ubuntu
      Dock (work area, not raw monitor geometry).
- [ ] Gap settings in Preferences apply live; 0/0 gaps produce perfectly
      abutting windows with no 1px holes (also check with fractional
      scaling enabled).
- [ ] Disable tiling in Preferences: windows stay where they are and are
      never repositioned again; re-enable: layout reasserts.

## Stacked layout (Shift+Super+S)

- [ ] Shift+Super+S on a tiled workspace with 2+ windows: all tiled
      windows move to one shared content area below a tab bar (one tab
      per window, icons + titles); the focused window is visible.
      Pressing again restores the tiled arrangement the workspace had
      before stacking.
- [ ] **Shift+Super+S needs at least two windows.** On an empty
      workspace and on a workspace with a single window, pressing it is
      a clean no-op: no tab bar, no mode change (open a second window
      afterwards to confirm the workspace is still tiled), no errors in
      the journal. One normal window plus a floating dialog is still a
      no-op — dialogs are not layout members and don't count.
- [ ] Open a window *while stacked* (a tab appears), then toggle stacked
      off: the new window sits next to the window that was focused when
      it opened, everything else in its prior slot.
- [ ] Clicking a tab raises and focuses that window and highlights its
      tab; Alt+Tab to a stacked window also raises it and updates the
      highlight.
- [ ] Window titles in tabs update live (e.g. switch browser tabs).
- [ ] Opening a window on a stacked workspace adds a tab immediately;
      closing one (active or inactive) removes its tab and leaves a
      valid state while 2+ windows remain.
- [ ] **Dropping to one window auto-exits stacked mode.** On a stacked
      workspace with exactly two windows: close one — the tab bar
      disappears and the survivor immediately retiles to the full work
      area (minus gaps), no one-tab bar left behind. Repeat by moving a
      window away instead (Shift+Super+N and Shift+Super+Left/Right):
      same result. Re-stacking afterwards requires pressing
      Shift+Super+S again once 2+ windows are present — the mode does
      not come back on its own.
- [ ] **Minimize does NOT auto-exit stacked mode.** On a stacked
      workspace with two windows, minimize one: the workspace stays
      stacked (one tab remains). Restore it: both tabs return.
- [ ] **Maximize/fullscreen a stacked window hides the whole tab bar**
      (not just that window's tab), like fullscreen does — the tab bar
      must not float over the maximized/fullscreen window. The workspace
      stays stacked: unmaximize / leave fullscreen and the full tab bar
      returns.
- [ ] Stacked state is per workspace: switch between a stacked and a
      tiled workspace repeatedly — mode and tab bar follow correctly.
- [ ] Shift+Super+N moving a window off a stacked workspace removes its
      tab; moving one onto a stacked workspace adds a tab. Same for
      Shift+Super+Left/Right into new workspaces.
- [ ] The tab bar disappears in the Activities overview and while a
      window on the workspace is fullscreen or maximized, and reappears
      after.
- [ ] **Toggling stacked drops an existing maximize.** With a window on
      the workspace maximized, press Shift+Super+S: the maximize is
      released first, then the workspace toggles stacked/tiled on the real
      window set. A true-fullscreen window is left alone (the mode flag
      still toggles; the visible effect resumes when fullscreen ends).
- [ ] Many windows (15+) on a stacked workspace: tabs compress with
      ellipsized titles, no clipping or overflow off-screen.
- [ ] **Notifications draw above the tab bar, not behind it.** On a
      stacked workspace, trigger a notification banner (a chat app
      message, a low-battery warning, `notify-send "test"` from a
      terminal) — it must appear fully on top of the tab bar, never
      obscured by or clipped behind it.
- [ ] **The auto-hide panel reveals OVER the tab bar, not behind it.**
      With `panel-autohide` on and a stacked workspace, hover the top edge
      to reveal the panel: it must slide down *on top of* the tab bar. The
      panel-opacity and the panel's own contents stay fully visible; the
      tab bar is what gets covered.
- [ ] **The tab bar is not visible on the lock screen.** On a stacked
      workspace, lock (`Super+L`): the lock screen must fully cover the tab
      bar (no strip of tabs showing over/through the lock UI). (Distinct
      from the stacked-mode-survives-lock test below, which is about state,
      not visibility.)
- [ ] **Stacked mode survives locking the screen.** On a stacked
      workspace, lock the screen (`Super+L`), wait a few seconds, then
      unlock: the workspace must still be stacked with its tab bar
      intact, not silently reverted to tiled. Test with a mix of stacked
      and tiled workspaces open at once to confirm only the
      already-tiled ones stay tiled.
- [ ] **The tab bar disappears for the Activities overview reached via
      3-finger swipe up, not just via the Super key.** On a stacked
      workspace, do a slow 3-finger swipe up and watch during the live
      drag (not just after it settles) — the bar must vanish as the
      overview starts appearing and MUST NOT pop back while the
      overview is up (this was a real bug: trackFullscreen chrome gets
      its visibility force-reasserted by the shell on the gesture path
      specifically — see GNOME_NOTES.md). Also release the swipe
      early/cancel it: the bar returns once the desktop settles back.
- [ ] **The tab bar slides WITH its workspace during a switch swipe.**
      With a stacked workspace active, do a slow 3-finger left/right swipe
      and hold it mid-drag: the bar must travel horizontally locked to its
      workspace's windows (not blink out at the start, the old behavior),
      exactly like an app window does. Swiping ONTO another stacked
      workspace: that workspace's bar slides in with it. Swiping onto a
      tiled (non-stacked) workspace: no bar slides in. The real (non-
      sliding) bar must never additionally float on top during the drag —
      including while windows open/close/retile on other workspaces in the
      background. On landing, the destination's real bar takes over cleanly
      (if stacked); a cancelled swipe (nudge and release back onto the same
      workspace) restores the origin's bar. Repeat several swipes, both
      directions, fast and slow, and confirm no leftover/duplicate bar and
      no errors in the journal.
- [ ] **Swipe-slide degrades safely.** If a future GNOME changes the
      workspace-animation internals, the sliding-bar enhancement is fully
      guarded: worst case the bar simply stays hidden for the swipe
      (the previous behavior) — never a crash or a stuck/duplicated bar.
      (Nothing to do here on this version; noted so the private-API reach
      is on the checklist.)

## Per-window floating (Shift+Super+V)

- [ ] With two or more tiled windows, focus one and press Shift+Super+V:
      it pops out, resizes to a centered rectangle (~65% of the work area
      by default), and floats above the others, which reflow to fill its
      old slot. Press Shift+Super+V again: it re-joins the tiled layout.
- [ ] The floated window is freely movable and resizable with the mouse,
      and the tiler never snaps it back (unlike a tiled window, which
      snaps back on grab-op-end).
- [ ] A floated window stays stacked ABOVE the tiled ones after a relayout
      (open/close another window on the same workspace and confirm the
      floater is still on top).
- [ ] **Float geometry setting.** Change "Floating size" in Preferences →
      Tiling → Floating (e.g. to 40 or 90) and float a window: the
      centered size follows the new percentage.
- [ ] **A maximized or fullscreen floating window hides the stacked tab
      bar.** On a stacked workspace with 3+ windows, float one (2+ stay
      stacked, so the tab bar still shows) then maximize the floating
      window, and separately fullscreen it: in BOTH cases the tab bar must
      hide — it must never remain drawn across the top of the covering
      window. Un-maximize / leave fullscreen and the tab bar returns.
      (A floating window covers the bucket exactly like a tiled one, so it
      counts as an exclusive occupant; only a stray maximized dialog/popup
      does not.)
- [ ] **Dialogs/utilities are unaffected.** Focus a dialog or other
      already-floating window and press Shift+Super+V: nothing happens
      (there is no layout membership to toggle).
- [ ] **Floating survives locking the screen.** Float a window, lock and
      unlock: it must still be floating (not silently re-tiled) — same
      module-scoped-state guarantee as stacked mode.
- [ ] Close a floated window: no errors in the journal, and its float
      entry is dropped (open a new window in its place and confirm normal
      tiling; nothing lingers).
- [ ] Float toggle interacts cleanly with stacked mode: floating a window
      on a stacked workspace removes it from the tab bar; unfloating adds
      it back. Dropping a stacked workspace to one non-floated member via
      float still auto-exits stacked (float ends membership like a move).

## Toggle maximize (Shift+Super+F)

- [ ] Focus a normal window and press Shift+Super+F: it maximizes to fill
      the work area but KEEPS the top panel and title bar visible (exactly
      like the window's maximize button / a title-bar double-click). Press
      again: it restores / re-tiles.
- [ ] On a stacked workspace, maximizing hides the tab bar; restoring
      brings it back (exclusive-occupant path).
- [ ] With tiling on, maximize a window then open a new app: the maximize
      is released and both tile (TilingManager._exitMaximized).
- [ ] No focused window / a focused dock or panel: clean no-op.
- [ ] A focused dialog maximizes its parent window, never the dialog alone.

## Toggle fullscreen (Super+F)

- [ ] Focus a normal window and press Super+F: it goes TRUE fullscreen —
      covers the panel and everything, no title bar (YouTube-video style),
      distinct from Shift+Super+F maximize. Press Super+F again: it leaves
      fullscreen and returns to its previous geometry.
- [ ] Works with tiling both ON and OFF.
- [ ] On a stacked workspace, fullscreening hides the tab bar; leaving it
      brings the bar back.
- [ ] **Escape leaves it — but only while focused.** With a window in
      Super+F fullscreen and focused, press Escape: it leaves fullscreen.
      Then verify Escape is NOT swallowed otherwise: with no keybind-
      fullscreen active, Escape works normally in every app (menus close,
      etc.).
- [ ] **A new app window leaves our fullscreen.** Super+F a window, then
      launch another app onto the same workspace: the fullscreen window
      drops back out so the new one is visible.
- [ ] **Toggling stacked leaves our fullscreen.** With a window in Super+F
      fullscreen on a workspace that has 2+ windows, press Shift+Super+S:
      the window leaves fullscreen and the stacked layout takes effect
      (rather than the toggle doing nothing behind the fullscreen). With
      tiling disabled, Shift+Super+S does NOT disturb the fullscreen.
- [ ] **An app's OWN fullscreen is never force-exited.** Play a video and
      let the PLAYER go fullscreen (its own button, not Super+F): opening a
      new app or pressing Escape must NOT be intercepted by the extension —
      only the app/player controls it. (The extension only tracks windows
      it fullscreened via Super+F.)
- [ ] No focused window / a focused dock or panel: Super+F is a clean
      no-op, no errors in the journal.
- [ ] A focused dialog fullscreens its parent window, never the dialog
      alone (find_root_ancestor).

## Panel auto-hide

- [ ] Off by default: on a fresh install the top panel behaves like
      stock GNOME — always visible, windows never underlap it.
- [ ] Enable "Auto-hide the top panel" in Preferences (Appearance → Top
      Panel): the panel slides up and off within a moment (no re-enable
      of the extension needed), and maximized/tiled windows grow to use
      the freed space (tiled workspaces retile automatically).
- [ ] Push the pointer against the very top edge of the primary
      monitor: the panel slides in over the windows (they do not
      resize), stays while the pointer is anywhere on it, and slides
      away shortly after the pointer leaves it downward.
- [ ] Sliding in and sliding out are equally smooth — the same speed
      and gentle start/stop in both directions; the reveal never pops
      most of the way in a single jump.
- [ ] Changing "Slide duration" in Preferences (default 500 ms) takes
      effect on the very next slide, in both directions, without
      re-enabling anything.
- [ ] Switch to an empty workspace (or close/minimize every window on
      the current one): the panel slides in and stays without any
      pointer or key input. Opening a window on it slides the panel
      away again (once the pointer is off the top), and the new window
      still gets the full reclaimed height.
- [ ] **Reveal keybinding (default Super+Z).** With the panel hidden and
      the pointer away from the top edge, press Super+Z: the panel slides
      in and STAYS (latched). Press Super+Z again: it slides away. Rebind
      it in Preferences → Keybindings → Panel and confirm the new combo
      works and Super+Z no longer does.
- [ ] The reveal keybinding is scoped to auto-hide: turn "Auto-hide the
      top panel" OFF and confirm Super+Z is no longer grabbed (it reaches
      apps / does nothing), then ON again and it works.
- [ ] Open the calendar or quick-settings from the revealed panel, then
      move the pointer down into the open menu: the panel must NOT
      slide away while the menu is open; closing the menu lets it hide.
- [ ] Clicking panel items on the revealed panel works normally over a
      maximized window (input lands on the panel, not the window
      underneath).
- [ ] Activities overview (Super tap or 3-finger swipe up): the panel
      is visible for the whole time the overview is open, and on
      leaving it the panel's slide-out starts together with the
      overview's zoom-out animation — no visible pause where the panel
      lingers before moving (pointer away from the top).
- [ ] **No overlap of the panel and the "Type to search" entry.** In the
      overview (Super tap and 3-finger swipe up), the search entry sits
      clear BELOW the panel, not underneath it. Confirm with auto-hide ON;
      compare with auto-hide OFF (must look the same). Type a query — the
      results area is also clear of the panel. Turn auto-hide off while in
      the overview: the entry stays correctly placed (no leftover margin).
- [ ] Fullscreen a window (e.g. a video): the panel does not appear,
      not even when the pointer touches the top edge (stock GNOME
      fullscreen behavior); leaving fullscreen restores auto-hide
      behavior.
- [ ] Toggle the setting off again: the panel returns immediately,
      stays permanently visible, and windows shrink back below it
      (strut restored). Disable the whole extension with the setting
      still on: same full restoration, and re-enabling the extension
      re-applies auto-hide.
- [ ] Lock (Super+L) and unlock with auto-hide on: the lock screen's
      panel (clock, battery) is visible and looks stock, and after
      unlock the panel slides away again once no reveal condition
      holds. Windows must NOT reflow/retile on lock or unlock (the
      strut stays released across the lock — the extension keeps
      running in the unlock-dialog session mode).
- [ ] Lock and unlock repeatedly in quick succession: no flashing of
      GNOME's Activities button, no workspace squares on the lock
      screen, and no window jumping — each cycle looks identical.
- [ ] With "Background opacity" at its default 100%, the panel's look
      is unchanged in every state — same style, height, and contents;
      only sliding in/out is new.

## Panel background opacity

- [ ] Drag the "Background opacity" slider (Appearance → Top Panel)
      down: the panel background fades live over a maximized window
      (0% = fully see-through), while the clock, indicators, and this
      extension's workspace squares stay fully opaque and clickable.
- [ ] Works with auto-hide off — a permanently visible panel can still
      be made translucent.
- [ ] The translucency survives an overview round-trip: open the
      Activities overview (Super tap, 3-finger swipe, or hot corner),
      search for an app, come back — the panel background is still at
      the slider's value, not reset to solid (GNOME's overview code
      rewrites the panel's inline style on every exit; the extension
      re-asserts it).
- [ ] **No flash on overview exit.** With opacity below 100%, 3-finger
      swipe UP into the overview then swipe DOWN to exit (and repeat a
      few times, fast and slow). The panel background must NOT flash
      solid-black for a split second on the way out — it stays at the
      configured translucency throughout. (The fix pins the panel's CSS
      transition to 0ms; without it the theme's permanent 250ms
      transition faded the re-applied background back from solid on every
      exit.) Check the Super-tap and hot-corner exit paths too.
- [ ] Back at 100%, the panel is pixel-identical to stock (the inline
      style is removed, not a near-opaque black); disabling the
      extension at any slider value also restores the stock look.
- [ ] With opacity below 100%, lock the screen: the lock screen's panel
      uses GNOME's own unlock-screen styling (no translucent black
      injected); after unlock the configured translucency is back.

## Focus border

- [ ] Clicking between windows (tiled or floating) moves the border to
      whichever window is now focused, immediately and correctly sized
      around its frame — never overlapping the window's content, never
      lagging behind.
- [ ] Alt+Tab between windows moves the border correctly, including
      across workspaces and monitors.
- [ ] With `focus-border-color` empty (default), the border matches your
      current Settings → Appearance accent color; it never flashes the
      old default blue on a non-blue accent, including during fast
      focus changes (Alt+Tab rapidly between several windows).
- [ ] Setting a custom `focus-border-color` overrides the accent color;
      clearing it back to empty reverts to following the accent again,
      live, no re-enable needed. Width and radius changes in Preferences
      apply immediately to whichever window currently has the border.
- [ ] Focusing the desktop (clicking empty space, or `Super+D`/Show
      Desktop) removes the border entirely — no border floating with no
      target.
- [ ] Minimizing the focused window removes its border; restoring it (or
      focusing another window) resolves to a valid state either way.
- [ ] Fullscreening the focused window removes the border for as long as
      it's fullscreen; leaving fullscreen restores it.
- [ ] Resizing or dragging the focused window (mouse drag, not a
      keybinding) keeps the border tracking it continuously, with no
      visible lag.
- [ ] Focus a modal/attached dialog (e.g. a file chooser): the dialog
      itself gets the border, sized to the dialog, not its parent window.
- [ ] Switch workspaces via keyboard (`Super+Left/Right`), mouse click on
      a panel square, and a 3-finger touchpad swipe: in every case the
      border ends up correctly around the newly focused window on the
      destination workspace, with no stale border left hanging at the old
      position during or after the switch animation. The swipe case is
      the important one — the border should disappear for the live drag
      and reappear once the gesture settles, never appear to "hang" while
      the workspace visually slides past it.
- [ ] Disabling `enable-focus-border` in Preferences removes it
      immediately; re-enabling restores it around whatever is currently
      focused, live, no re-enable of the whole extension needed.
- [ ] Enable/disable the whole extension repeatedly: no duplicate or
      orphaned border actors, and `journalctl --user _COMM=gnome-shell`
      shows no leaked-signal warnings referencing this extension.

## Preferences window

- [ ] Every spin row, switch, and combo row reflects the live GSettings
      value on open, and edits persist (`dconf-editor`
      `/org/gnome/shell/extensions/tessera/` to verify directly).
- [ ] The Small/Medium/Large/XL preset buttons set square size, spacing,
      and padding together — the three spin rows below update instantly
      and the indicator resizes live; hand-tweaking a spin row afterwards
      works normally (presets are one-shot, not a stored mode). Large
      matches the schema defaults.
- [ ] Clearing a color field back to empty reverts that square state to the
      GNOME-theme default from `stylesheet.css`.
- [ ] Entering an invalid value in a color field (e.g. `notacolor`) is
      silently ignored by the indicator (falls back to the theme default)
      rather than crashing the shell.

## Theming

- [ ] Toggle GNOME's dark/light theme (Settings → Appearance) while the
      extension is enabled; both filled and outline styles stay legible in
      both.
- [ ] Try at least one non-Yaru shell theme if available (via the bundled
      `user-theme` extension) to confirm the squares don't visually break.

## Cleanup correctness

- [ ] After `disable()`, `Looking Glass` (`lg` in the overview, or
      `journalctl --user _COMM=gnome-shell`) shows no leftover errors
      referencing this extension.
- [ ] Re-enabling after disabling produces a clean single row of squares —
      no duplicate panel indicators, no doubled keybinding handlers (test by
      enabling/disabling three times in a row, then confirming `Super+1`
      still only switches to workspace 1 once, not fired twice).
