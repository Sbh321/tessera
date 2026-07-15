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

**Reloading changed code — what actually works on GNOME 45+:**

Extensions are ES modules, and a running shell caches imported modules
for the life of the process. `gnome-extensions disable && enable` re-runs
`disable()`/`enable()` but does **not** re-import changed JS — an earlier
version of this document claimed it did; it doesn't. New code needs a new
gnome-shell process. In order of preference:

1. **X11 session** (`Alt+F2`, `r`, `Enter`): restarts the real shell
   in-place in seconds with all apps kept running — log into "Ubuntu on
   Xorg" at the GDM gear icon for extended dev sessions. The fastest
   stable loop currently available.
2. **Wayland logout/login**: the only way to reload code in the *real*
   Wayland session — needed for a brand-new uuid, and for final
   verification of gesture/multi-monitor behavior before release.

(A nested-shell loop — `dbus-run-session -- gnome-shell --nested
--wayland` — was tried and removed: nested sessions proved buggy and
unstable on this environment even with isolated dconf state. Notes if
ever revisited: isolate settings with a throwaway seeded dconf database
via `DCONF_PROFILE` — the database name must avoid hyphens, since dconf
derives a D-Bus object path from it and hyphens make every write hang —
enable only this extension inside the sandbox, and kill stale
`gnome-shell --nested` processes first.)

Two things never need a shell reload at all: `prefs.js` (runs in its own
short-lived process — just close and reopen the Preferences window), and
quick API experiments, which are fastest in Looking Glass (`Alt+F2`,
`lg`) against the live shell before committing them to code.

**⚠ Symlink mode vs. install.sh.** `dev-symlink.sh` makes the installed
extension path a symlink to this repo. `gnome-extensions install --force`
(run by `install.sh`) deletes the existing installation recursively and
follows symlinks — which would delete **the repo itself, including
`.git`**. `install.sh` now detects the symlink and removes only the link
first, so running it in symlink mode is safe; but know that this footgun
exists in the underlying tool (verified empirically after it wiped this
repo once — the work was recovered from the pushed remote and the
freshly-installed copy).

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
