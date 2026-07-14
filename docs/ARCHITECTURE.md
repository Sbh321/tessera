# Architecture

## Goals that shaped the design

- Change only the *appearance* of the workspace indicator; never touch how
  workspace switching itself works. Every workspace change in this
  extension goes through `Meta.Workspace.activate()` or
  `Meta.Workspace.get_neighbor()` — the same public APIs GNOME's own code
  uses.
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
lib/nativeIndicatorHider.js  Hides GNOME's own built-in Activities-button
                           workspace dots via a marker style class, so this
                           extension's squares are the only indicator shown.
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
```

The indicator never reads keybinding state, and the keybinding manager never
touches the panel widget — the two are independent consumers of the same
`SettingsManager`, composed only in `extension.js`.

## Why `PanelMenu.Button` with no menu

GNOME's own bundled `workspace-indicator` extension (see
[`GNOME_NOTES.md`](GNOME_NOTES.md)) collapses into a dropdown menu once past
6 workspaces, or when workspaces are arranged in a vertical grid. This
project deliberately skips that: the brief asks for squares that are always
visible, Hyprland-style, so `WorkspaceIndicator` is constructed with
`dontCreateMenu = true` and there is no equivalent fallback. In practice
this is fine — dynamic workspaces rarely grow past single digits, and this
extension only advertises `Super+1`..`Super+9` for direct jumps anyway.

## The four places this extension reaches outside its own schema

**1. `lib/keybindingManager.js`** reads and temporarily overwrites three
schemas it doesn't own:

- `org.gnome.shell.keybindings` (`switch-to-application-1..9`)
- `org.gnome.mutter.keybindings` (`toggle-tiled-left`, `toggle-tiled-right`)
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

**2. `lib/nativeIndicatorHider.js`** hides GNOME Shell's own built-in
workspace dots, which are rendered directly inside the Activities button
(style class `.workspace-dot`) independently of any extension — a real user
running this extension found both indicators visible side by side, which is
how this was discovered (see [`GNOME_NOTES.md`](GNOME_NOTES.md) for the full
Looking-Glass-based investigation). Rather than patch `js/ui/panel.js`
directly, the manager only toggles a marker style class on `Main.panel`
(itself a stable, public actor reference); the actual hiding is a plain CSS
rule in this extension's own `stylesheet.css` targeting `.workspace-dot`.
Because the coupling is CSS-selector-only and gated behind the
`hide-native-activities-dots` setting (on by default), a class-name
mismatch on some future GNOME version fails silently — both indicators
would simply show again — rather than breaking anything.

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
