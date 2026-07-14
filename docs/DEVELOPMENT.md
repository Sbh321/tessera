# Development

## Prerequisites

- GNOME Shell 46 (Ubuntu 24.04 ships this by default)
- `gnome-shell-extension-prefs` tooling / the `gnome-extensions` CLI
  (`sudo apt install gnome-shell-extensions` if missing)
- `glib-compile-schemas` (part of `libglib2.0-bin`, present by default on
  Ubuntu)

## Fast local iteration

```sh
./scripts/dev-symlink.sh
```

This symlinks the repo directly into
`~/.local/share/gnome-shell/extensions/<uuid>/` and compiles the schema in
place, so editing `lib/*.js` or `stylesheet.css` and reloading the shell is
enough — no rebuild/reinstall step. Re-run it after editing
`schemas/*.gschema.xml` to recompile.

**Reloading the shell:**

- **Wayland** (the default on Ubuntu 24.04): there is no in-place restart.
  Log out and back in to load a brand-new extension for the first time.
  Once it's already loaded and enabled, most day-to-day edits (JS logic,
  CSS, settings changes) take effect by disabling and re-enabling it —
  `gnome-extensions disable <uuid> && gnome-extensions enable <uuid>` —
  without a full logout.
- **X11**: `Alt+F2`, type `r`, `Enter` restarts GNOME Shell in place.

## Packaging for distribution

```sh
./scripts/build.sh     # -> build/<uuid>.shell-extension.zip
./scripts/install.sh   # build + gnome-extensions install
```

Both use `gnome-extensions pack`, the same tool extensions.gnome.org uses
to validate submissions — if this passes, the packaging step of a real
submission will too.

## Debugging

- **Logs**: `journalctl --user _COMM=gnome-shell -f` while reproducing an
  issue. Uncaught JS exceptions inside this extension show up here with a
  stack trace pointing at the offending `lib/*.js` file/line.
- **Looking Glass**: open with the keyboard shortcut bound to
  `toggle-message-tray`/Activities search, type `lg`, or run it from the
  Activities overview search for "Looking Glass". Useful for inspecting
  live actor state (`global.workspace_manager.n_workspaces`,
  `Main.panel.statusArea['<uuid>']`, etc.) without adding temporary log
  lines.
- **Preferences window**: runs in a separate process
  (`gjs`/`gnome-extensions-app`), so its errors do *not* show up in the
  gnome-shell log — run `gnome-extensions prefs <uuid>` from a terminal to
  see `prefs.js` exceptions printed directly to stdout/stderr.

## Why there's no automated test suite for the UI

The panel indicator and keybindings only make sense running inside an
actual Mutter/GNOME Shell compositor process — `St`, `Clutter`, and
`Meta.Workspace` aren't meaningfully mockable outside it, and GNOME Shell
itself doesn't offer a supported headless test harness for third-party
extensions. `tests/schema-validate.sh` covers the one thing that *can* be
verified in isolation (the GSettings schema compiles under
`--strict`). Everything else is covered by the manual checklist in
[`../tests/MANUAL_TESTS.md`](../tests/MANUAL_TESTS.md) — run it after any
change to `lib/workspaceIndicator.js` or `lib/keybindingManager.js` in
particular, since those are the two modules touching live shell/session
state.

## Code style

- ES modules, `GObject.registerClass`, `constructor()`/`super()` — not the
  legacy `_init()` pattern — matching the shape GNOME's own bundled
  extensions use as of GNOME 45+ (see the reference file discussed in
  [`GNOME_NOTES.md`](GNOME_NOTES.md)).
- No abbreviations or cleverness in identifiers; prefer an explicit
  `if`/`else` over a ternary when either branch has a side effect.
- Comments explain *why*, not *what* — see `lib/keybindingManager.js` for
  the standard this project holds itself to (every non-obvious constraint
  gets one line, nothing restates the code).
