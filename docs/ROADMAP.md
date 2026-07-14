# Roadmap

## Shipped in 0.1.0

- Numbered square panel indicator, replacing the dot-style workspace
  indicator, built as its own `PanelMenu.Button` (see
  [`ARCHITECTURE.md`](ARCHITECTURE.md)).
- Dynamic workspace count and active-workspace tracking via
  `global.workspace_manager` signals.
- Click-to-switch.
- `Super+1`..`Super+9` jump-to-workspace and `Super+Left`/`Super+Right`
  previous/next, including safe override-and-restore of the conflicting
  GNOME defaults (`switch-to-application-N`, `toggle-tiled-left/right`).
- Full settings schema: panel position (left/center/right), hiding GNOME's
  built-in Activities-button workspace dots, square size, spacing, border
  radius, padding, font size/weight, filled-vs-outline style, per-state
  colors, trailing-empty-workspace visibility, and a master keybindings
  on/off switch — all wired up to a working Adwaita preferences UI, not
  just present in the schema.
- Active square defaults to the real Ubuntu accent color (read from
  `gtk-theme`'s Yaru variant, see [`ARCHITECTURE.md`](ARCHITECTURE.md) and
  [`GNOME_NOTES.md`](GNOME_NOTES.md)), live-updating if the user changes
  their accent color while the extension is running; a user-set
  `active-background-color` still overrides it.
- Live active-square preview during a 3-finger workspace-switch swipe
  (`lib/gestureProgressTracker.js`), best-effort and self-correcting via
  `workspace-switched` — see [`ARCHITECTURE.md`](ARCHITECTURE.md) for the
  private-API trade-off this required.

## Near-term

- **Press-to-record keybinding capture widget.** Preferences currently
  accept accelerators as typed text (e.g. `<Super>3`) via `Adw.EntryRow`.
  A `Gtk.EventControllerKey`-based "click here and press a key" widget
  would be more approachable for non-technical users. Deferred for 0.1
  because it's meaningfully more code for a power-user-only rough edge —
  the schema and override logic don't change either way.
- **Persist the keybinding override backup to disk.** Right now
  `KeybindingManager` keeps the saved GNOME-default keybinding values only
  in memory (see the "Known limitation" note in
  [`ARCHITECTURE.md`](ARCHITECTURE.md)). If GNOME Shell crashes while this
  extension is enabled, the cleared defaults stay cleared until the next
  clean `disable()`. Persisting the backup in this extension's own
  GSettings (a private, non-UI-facing key) would let `enable()` detect and
  recover from that case on the next normal startup.
- **Scroll-to-switch on the panel indicator.** Not in the original brief;
  noted here as a plausible follow-up since GNOME's own bundled
  `workspace-indicator` extension supports it and users may expect parity.
  Not implemented speculatively — add only if actually requested.

## Later / exploratory

- **Accent color for non-Yaru themes.** `lib/accentColor.js` only
  recognizes Yaru variants (Ubuntu's own accent-color mechanism on this
  GNOME version); any other theme falls back to the hardcoded `#3584e4`
  in `stylesheet.css`. If GNOME ever ships a general, theme-agnostic
  accent-color API, that would be a strictly better replacement — see
  [`GNOME_NOTES.md`](GNOME_NOTES.md) for why no such API exists yet on
  GNOME 46.
- **Multi-monitor workspace grouping.** Only relevant if
  `workspaces-only-on-primary` is `false` on a given system; not currently
  handled specially since the reference environment runs with it `true`.
  Would need real multi-monitor hardware to design and test against
  properly rather than guessing at behavior.
- **GNOME 47/48 compatibility pass.** Nothing in this codebase is known to
  need it yet (see the porting notes in
  [`GNOME_NOTES.md`](GNOME_NOTES.md)), but should be explicitly re-verified
  once either is available in a supported Ubuntu release rather than
  assumed.

## Explicitly out of scope

- Changing workspace-switch *behavior* (animation timing, wrap logic,
  multi-monitor assignment) — the brief is about appearance only, and this
  project deliberately routes every action through the same public
  `Meta.Workspace` APIs GNOME's own code uses so behavior is untouched by
  construction.
- A dropdown/menu fallback for large workspace counts, matching GNOME's
  bundled `workspace-indicator` extension — deliberately dropped; see
  [`ARCHITECTURE.md`](ARCHITECTURE.md) for why.
