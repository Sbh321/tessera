# Manual Test Checklist

GNOME Shell extensions run inside the compositor process, so there is no
practical automated test harness for the panel indicator or keybindings
themselves (see [`../docs/DEVELOPMENT.md`](../docs/DEVELOPMENT.md) for why).
`schema-validate.sh` covers what *can* be automated. Everything else below
is a manual pass, done after `scripts/dev-symlink.sh` and enabling the
extension.

## Placement and native-dots hiding

- [ ] Indicator appears in the left panel box by default; switching
      `panel-position` in Preferences to center/right moves it live, no
      re-enable needed.
- [ ] With `hide-native-activities-dots` on (default), GNOME's own dots
      inside the Activities button (style class `.workspace-dot`) are not
      visible. Confirm via Looking Glass (`Alt+F2`, `lg`,
      `Main.panel.statusArea['activities']`) if unsure which widget you're
      looking at.
- [ ] Toggling `hide-native-activities-dots` off in Preferences brings the
      native dots back immediately, without disabling the whole extension.
- [ ] Disabling the extension restores the native dots even if they were
      hidden at the time.

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
- [ ] Lifting the fingers snaps the highlight to the final workspace
      *immediately* — it must not trail GNOME's settle animation by a
      beat.
- [ ] Releasing the gesture partway (settling on, say, workspace 3 instead
      of continuing to 5) leaves the correct square (3) highlighted, not
      whatever was last previewed. A cancelled swipe (small nudge,
      released) leaves the original square highlighted.
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

## Preferences window

- [ ] Every spin row, switch, and combo row reflects the live GSettings
      value on open, and edits persist (`dconf-editor`
      `/org/gnome/shell/extensions/tessera/` to verify directly).
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
