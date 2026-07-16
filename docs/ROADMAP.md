# Roadmap

Tessera started as a numbered workspace indicator and has grown into a
Hyprland-inspired tiling workspace manager. The sections below track that
evolution: what each stage shipped, what's next, and what's deliberately
not planned.

## Shipped since 0.1.0

- **Renamed to Tessera** (from "Workspace Squares"), uuid
  `tessera@sbh321.github.io`.
- **Window movement**: `Shift+Super+1..9` moves the focused window to a
  workspace and follows it; `Shift+Super+Left/Right` inserts a brand-new
  workspace beside the current one and moves the window into it
  (`lib/windowMover.js`, composed from GNOME's own
  `Main.wm.actionMoveWindow()` / `insertWorkspace()`).
- **Automatic dwindle tiling** (`lib/tiling/`): Hyprland's default
  layout, one reconciled `LayoutTree` per (workspace × monitor) bucket,
  re-synced against ground truth as windows
  open/close/move/minimize/maximize/fullscreen; dialogs and
  other GNOME-floating windows float; configurable inner/outer gaps;
  master enable switch.
- **Focus-aware window insertion**: a new window splits the *focused*
  window's tile (Hyprland's insert-into-focused-container), the rest of
  the layout untouched; closing a window returns its area to its tree
  sibling alone; minimized/maximized windows keep their slot and reclaim
  it on restore. This replaced the original stateless count-based
  recompute with the mutable-but-reconciled tree the first design had
  explicitly deferred (see the tiling section of
  [`ARCHITECTURE.md`](ARCHITECTURE.md)).
- **Stacked (tabbed) layout mode** per workspace (`Shift+Super+S`):
  Hyprland's stacked layout, with a per-monitor tab bar (live titles,
  icons, click-to-raise), implemented as a pluggable layout strategy.
- Gesture-preview reliability fixes (absolute progress mapping verified
  against extracted shell source; event-driven self-verification) and
  keybinding-conflict hardening (Ubuntu Dock hot-keys, move-to-monitor
  defaults).

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

- **Tiling follow-ups** (each anticipated by the current architecture,
  none requiring restructuring — see the tiling section of
  [`ARCHITECTURE.md`](ARCHITECTURE.md)):
  - Directional focus keybindings (`Super+H/J/K/L`-style).
  - Drag-to-swap tiled windows (currently a drag snaps back on
    `grab-op-end`; swapping is a leaf swap on the now-existing
    `LayoutTree`, plus target-slot hit testing).
  - Adjustable split ratios and node swaps — per-node state on the
    `LayoutTree` (the tree itself shipped with focus-aware insertion;
    what remains is exposing interactive operations on it).
  - More layouts (master, grid, spiral variants) — pure additions to
    `lib/tiling/layoutEngine.js`.
  - Per-workspace layout choice and smart gaps as settings.
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

- Reimplementing behavior GNOME already owns — switch/move animations,
  focus rules, dynamic workspace lifetime, what floats. Tessera layers
  the Hyprland workflow *on top of* GNOME's model through its public
  APIs; it is not a compositor replacement, and anything that would
  require monkey-patching shell internals to override that model stays
  out.
- A dropdown/menu fallback for large workspace counts, matching GNOME's
  bundled `workspace-indicator` extension — deliberately dropped; see
  [`ARCHITECTURE.md`](ARCHITECTURE.md) for why.
