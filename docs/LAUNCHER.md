# Launcher

Tessera's launcher is a native GNOME Shell search popup in the spirit of
macOS Spotlight, Raycast and the VS Code command palette: one shortcut
(`Super+Space`), one search box, and every kind of result merged into a
single ranked list — applications, open windows, GNOME Settings panels,
extensions, arithmetic, shell commands, clipboard entries, and every
action Tessera itself can perform.

It is **not** a wrapper around Rofi, Walker, Ulauncher, or any external
process. Everything runs inside gnome-shell on public Mutter/Shell/St
APIs, on the same terms as the rest of this extension: no monkey-patching,
no private-field reaches, and nothing left behind on `disable()`.

It is **off by default** (`enable-launcher`), because its default
shortcut collides with GNOME's input-source switcher — see
[Keyboard](#keyboard) below.

---

## Architecture

```
lib/launcher/
    launcher.js            Subsystem entry point: builds providers, owns
                           the popup, exposes toggle(). The ONLY file in
                           here that knows Tessera exists.
    constants.js           Provider ids, ranking weights, timings. No
                           gettext (module scope must stay side-effect
                           free).
    utils.js               Pure string/number helpers. No GNOME imports.
    fuzzyMatcher.js        Pure matching and scoring. No GNOME imports.
    calculatorEngine.js    Pure tokenizer + parser. No GNOME imports.
    searchResult.js        The one record every provider produces.
    searchProvider.js      Base class and interface contract.
    searchController.js    Ranking, grouping, activation. Owns providers.
    keyboardController.js  Key press -> intent. Nothing else.
    launcherUI.js          The result list (pooled rows). Draws only.
    launcherPopup.js       The card, the modal grab, the animations.
    theme.js               Settings + GNOME theme -> concrete CSS.
    iconProvider.js        Result -> Gio.Icon, with fallbacks.
    historyManager.js      Frecency store (what you launch).
    favoritesManager.js    Pinned results, in user order.
    actionRegistry.js      The static action catalogue.
    appProvider.js         Installed applications.
    windowProvider.js      Open windows.
    actionProvider.js      Actions + the "workspace 5" grammar.
    commandProvider.js     "> command" execution.
    calculatorProvider.js  Arithmetic results.
    recentProvider.js      The resting (empty-query) view.
    clipboardProvider.js   Clipboard history (opt-in).
    settingsProvider.js    GNOME Settings panels.
    extensionProvider.js   Installed shell extensions.
```

The one rule the whole subsystem is organised around:

> **Providers never render. The UI never searches. Nothing else ranks.**

Concretely: a provider returns plain data records and has no access to an
actor; `launcherUI.js` receives already-ranked, already-grouped sections
and has no access to a provider; `searchController.js` is the only file
that scores or orders anything; `keyboardController.js` is the only file
that decides what a key means. Each of those can be changed without
reading the others.

`calculatorEngine.js` is the one file not named in the original brief. It
exists so the arithmetic evaluator — the most logic-dense, most
edge-case-prone part of the launcher — carries no GNOME imports and can
therefore be unit-tested outside the shell, exactly as
`lib/tiling/layoutEngine.js` is split from `tilingManager.js` for the same
reason.

### Coupling to the rest of Tessera

`extension.js` constructs `LauncherManager` with one object:

```js
new LauncherManager(settingsManager, accentColorTracker, {
    tilingManager, windowMover, fullscreenManager,
    openPreferences, openPortKiller, openColorPicker, uuid,
});
```

That object is the entire coupling surface. It reaches providers as
`context.tessera`, and only `actionRegistry.js` and `actionProvider.js`
use it. Nothing in `lib/launcher/` is imported by anything outside it
except that one construction, plus `KeybindingManager` dispatching
`launcher-toggle` into `toggle()`.

Actions that operate on "the focused window" do **not** read
`global.display.focus_window` when they run. The popup holds a modal
grab, so live focus at activation time is not necessarily the window the
user was looking at when they started typing. Instead the popup captures
the focused window on open and hands it over as `context.targetWindow()`,
which is passed explicitly to `WindowMover`, `TilingManager` and
`FullscreenManager` through the optional window parameter those methods
gained for this purpose. A captured window that has since closed falls
back to live focus.

Two additions to existing modules came out of this, both backward
compatible (every existing caller keeps its behaviour):

- an optional trailing window argument on
  `WindowMover.moveFocusedToWorkspace` / `moveFocusedToLastWorkspace` /
  `moveFocusedToNewWorkspace` / `toggleFocusedMaximize`,
  `TilingManager.toggleFloating` and `FullscreenManager.toggleFocused`;
- a new public `WindowMover.moveToWorkspace(window, index)` — the general
  form `moveFocusedToWorkspace` now delegates to — because the launcher's
  `move firefox 4` grammar addresses a window by name rather than by
  focus.

The launcher also appears in two places outside its own preferences page:
the quick menu's **Overview** tab carries an `enable-launcher` toggle, and
its **Keys** tab lists `launcher-toggle` alongside the other shortcuts.

---

## The search pipeline

```
        entry text
            |
            v
   parseQuery()                    searchController.js
   { trimmed, terms[], prefix, commandBody, allowTypos }
            |
            +--> (empty query) --> favorites resolved by their provider
            |                      + every provider's defaultResults()
            |
            +--> (prefix "> ") --> commandProvider ONLY
            |
            +--> (otherwise)  --> every enabled provider's query(parsed)
                                       |
                                       v
                                  matchFields()       fuzzyMatcher.js
                                  score 0..1 + highlight positions
                                       |
                                       v
                                  SearchResult records
            |
            v
   rank()  = score x provider weight
             + favorite boost
             + frecency boost
             + provider-declared context boost
            |
            v
   group into sections, cap per section and overall,
   priority sections first, then by their best result
            |
            v
   launcherUI.setSections()
```

Results are recomputed from scratch on every keystroke — the same
"re-derive from ground truth, never trust cached state" posture the
tiling subsystem uses. There is no incremental result state that can go
stale, and at the scale involved (a few hundred apps, tens of windows) a
full pass costs well under a millisecond.

### Matching

`fuzzyMatcher.js` scores a query term against one string through
**non-overlapping tiers**, so a weaker kind of match can never outrank a
stronger one however the bonuses land:

| Tier | Example | Score band |
|---|---|---|
| Exact | `firefox` → Firefox | 1.0 |
| Prefix | `fire` → **Fire**fox | 0.88 – 0.97 |
| Word prefix | `code` → Visual Studio **Code** | 0.78 – 0.86 |
| Acronym (initials) | `vsc` → **V**isual **S**tudio **C**ode | 0.72 – 0.77 |
| Substring | `udio` → Visual St**udio** Code | 0.62 – 0.69 |
| Subsequence | `ff` → **F**ire**f**ox | 0.30 – 0.61 |
| Typo (edit distance) | `fierfox` → Firefox | ≤ 0.10 |

Subsequence matches are scored by how *tight* they are: consecutive runs,
hits on word boundaries and overall density all raise the score, while a
long lead-in lowers it. The match is found by a forward pass for
feasibility followed by a backward tightening pass, so `code` against
"Chromium Code Editor" resolves to the tight run in the second word
rather than scattering across the first.

The typo tier is bounded Damerau-Levenshtein (transpositions included),
abandoned as soon as the distance provably exceeds the budget, and only
attempted for queries of at least four characters. Note that a *dropped*
character (`firfox`) never reaches it — that is already a subsequence.
The `launcher-fuzzy` setting gates this tier alone; the others are what
make short queries work at all.

Multi-term queries (`vs code`) require **every** term to match some
field. The combined score is 75% average, 25% worst term, so one strong
term cannot carry a weak one — `firefox zzz` does not find Firefox.

Fields are weighted per provider (title 1.0, keywords ~0.75, description
~0.5). Highlight positions are collected for the `title` field only and
are guaranteed to line up with the original string: case/accent folding
is done per character so that folding never changes the string's length.

### Ranking

```
rank = matchScore × PROVIDER_WEIGHT[provider]
     + FAVORITE_BOOST          (0.12, pinned)
     + FRECENCY_MAX_BOOST × f  (0.10 × frecency, 0..1)
     + contextBoost            (provider-declared, ≤ 0.04)
```

All boosts are small relative to the 0..1 match score: they reorder
near-equal matches, which is the point of adaptive ranking, but can never
float a poor match above a good one.

- **Provider weight** breaks ties between kinds of result — an app beats
  an extension entry with the same spelling.
- **Frecency** combines how often and how recently a result was launched,
  with a two-week half-life, saturating so the difference between one and
  five launches matters much more than between 50 and 55.
- **Context boost** is declared by the provider, because only it knows
  what "relevant right now" means: a window on the current workspace, a
  window high in the MRU order, an application that is already running.

### Section order

**Open Windows always comes first** (`PRIORITY_SECTIONS`), in the resting
view and in every search, whenever it has anything to show. Switching to
something already open is the most common thing a launcher is asked to
do, and unlike every other section its entries are things the user put on
screen themselves — so pressing `Super+Space`, typing a word and hitting
Enter goes to the window you meant rather than launching a second copy of
it. (`Ctrl+Enter` on the application below still opens a new window.)

Priority is enforced in two places, because a display-order rule alone
would be a promise the result cap could quietly break:

- windows are **filled first**, so they get first claim on the
  maximum-results budget;
- the windows **section sorts first**, regardless of scores.

Windows are also weighted level with applications rather than below them
(`PROVIDER_WEIGHT`): an open window and an app that match a query equally
well are equally good answers, and which one leads is decided by the
priority rule instead of by quietly discounting one of them.

Below the priority sections, sections lead with whichever holds the
strongest single result, so the best of the rest is the next row. Exact
ties fall back to a fixed order (`SECTION_ORDER`) so the layout never
shuffles between identical searches.

**Favorites are a section only in the resting view.** With an empty
query, pinned keys are resolved back into live results (each by its
owning provider's `resultForKey()`) and shown together, in the user's pin
order. While *searching*, a pinned result stays in its natural section
and merely carries `FAVORITE_BOOST` — so a search never reshuffles
familiar groupings, and a pinned app is still found under "Applications"
where you expect it. Sections and their titles are:

| Section | Title |
|---|---|
| `windows` | Open Windows |
| `calculator` | Calculator |
| `commands` | Run Command |
| `favorites` | Favorites |
| `apps` | Applications |
| `actions` | Actions |
| `recent` | Recent |
| `clipboard` | Clipboard |
| `settings` | System Settings |
| `extensions` | Extensions |

---

## Providers

Every provider extends `SearchProvider` and implements at most six
things:

```js
get enabled()      // consult the user's settings
warmUp()           // optional: build caches off the critical path
query(parsed)      // the search; returns results or a Promise of them
defaultResults()   // optional: the empty-query view
enable()/disable() // optional: signals and other resources
resultForKey(id)   // optional: needed only if entries can be pinned
```

| Provider | Searches | Enter | Ctrl+Enter | Shift+Enter |
|---|---|---|---|---|
| `appProvider` | name, keywords, description, executable, `.desktop` actions | launch or focus | new window | open on the trailing workspace |
| `windowProvider` | title, application, WM class | switch to it | bring it to this workspace | — |
| `actionProvider` | the action catalogue + `workspace N` / `move <app> N` | run | — | — |
| `commandProvider` | `>`/`$` prefixed command lines | run | run with the opposite terminal setting | — |
| `calculatorProvider` | arithmetic | copy the result | — | — |
| `recentProvider` | (empty query only) | launch or focus | new window | — |
| `clipboardProvider` | clipboard text | copy again | pin / unpin | — |
| `settingsProvider` | GNOME Settings panel names, keywords | open that panel | — | — |
| `extensionProvider` | extension names and descriptions | enable / disable | open its preferences (when it has any) | — |

Results from `appProvider`, `actionProvider`, `settingsProvider` and
`extensionProvider` are **pinnable** (`Ctrl+D`); the others are not —
windows and calculator answers are too transient to pin, and clipboard
entries have their own pin list for the privacy reason below.

Notes on specific ones:

- **Applications** are read once and cached, invalidated by
  `Shell.AppSystem`'s `installed-changed`. Apps GNOME itself hides are
  excluded exactly as the app grid excludes them (`should_show()` plus the
  parental-controls filter). `.desktop` actions ("New Private Window")
  are offered as their own rows, scored slightly below the app itself.
- **Windows** come from `global.display.get_tab_list(NORMAL_ALL, null)` —
  the same MRU ordering Alt+Tab walks — so "recently focused" ranking is
  free and a closed window can never be listed. Activation hands off to
  `Main.activateWindow()`, GNOME's own helper. This section always leads
  the list; see "Section order" below.
- **Recent** answers only the empty query. During a search, recency and
  frequency are applied as a ranking boost to the app provider's results
  instead, which is what stops every search listing Firefox twice. Its
  list merges two sources: Tessera's own launch history first, then
  GNOME's shell-wide `Shell.AppUsage` (the database behind the overview's
  app ranking), so the resting view is useful on a profile that has never
  used the launcher before. Anything already pinned is skipped, since the
  favorites section above it is showing that already.
- **Settings panels** are `NoDisplay` `.desktop` files, which is exactly
  why `appProvider` cannot surface them. The two providers partition the
  same list rather than competing over it, so a panel never appears
  twice, and each arrives with its own translated name, description, icon
  and search keywords.

### The action catalogue

`actionRegistry.js` holds every action in one uniform descriptor
(`{id, title, subtitle, iconName, keywords, run, isAvailable}`), in three
families that are one idea from the user's side — type a verb, press
Enter. An action whose `isAvailable()` says no is simply absent from
search rather than shown greyed out.

**System** — delegated to GNOME's own `SystemActions` singleton, so they
honour the same lockdown keys and inhibitors as the system menu and
disappear when the session forbids them:

| Action | Availability |
|---|---|
| Lock Screen | `canLockScreen` |
| Suspend | `canSuspend` |
| Hibernate | logind's `CanHibernate` (see below) |
| Log Out | `canLogout` |
| Power Off | `canPowerOff` |
| Restart | `canRestart` |
| Switch User | `canSwitchUser` |
| Take a Screenshot | always |

**Hibernate is the one exception**: `SystemActions` does not expose it, so
it calls logind's public `org.freedesktop.login1.Manager` D-Bus interface
directly — an external system service with a published interface, not a
shell internal. Availability is queried asynchronously once at enable and
cached, so the action only appears on machines that actually support it,
and `Hibernate(true)` is interactive so logind can raise a polkit prompt
rather than failing silently.

**Shell**:

| Action | Notes |
|---|---|
| Settings | `org.gnome.Settings.desktop`, falling back to `gnome-control-center.desktop` |
| Extensions | `org.gnome.Extensions.desktop` |
| Open Terminal | tries a list of known terminal `.desktop` ids first so the terminal opens as a properly tracked application; falls back to handing `$SHELL` to GIO's `NEEDS_TERMINAL` launcher, which finds whatever terminal the system has; notifies if neither works |
| Restart GNOME Shell | X11 only — `Meta.restart()` cannot restart in place under Wayland, so the action is not offered there at all |

**Tessera** — this is what a general-purpose launcher cannot do. Every
feature the keybindings expose is searchable, which means a capability
needs no shortcut to be reachable:

| Type | Action | Notes |
|---|---|---|
| `tile` | Toggle Automatic Tiling | subtitle reports the current state |
| `stack` | Toggle Stacked Layout | current workspace |
| `float` | Toggle Floating Window | focused window |
| `max` | Toggle Maximize | focused window |
| `full` | Toggle Fullscreen | focused window |
| `border` | Toggle Focus Border | state in subtitle |
| `panel` | Toggle Panel Auto-hide | state in subtitle |
| `menu` | Toggle Quick Menu | state in subtitle |
| `new workspace` | New Workspace | switches to the trailing (empty) one |
| `next` / `previous` | Next / Previous Workspace | |
| `move` | Move Window to the Trailing Workspace | focused window |
| `move` | Move Window to a New Workspace | inserts one to the right |
| `port` | Port Killer | |
| `color` | Color Picker | |
| `pref` | Tessera Preferences | |
| `disable` | Disable Tessera | persistent — rewrites GNOME's `enabled-extensions`, exactly like the Extensions app's switch; deferred one idle turn because it tears down the launcher it is running inside |

The four focused-window actions use `context.targetWindow()` — the window
captured when the popup opened — not live focus. See "Coupling to the
rest of Tessera" above for why.

Plus an argument-taking grammar that no fixed catalogue could express,
because the argument is part of the request:

```
workspace 5      switch to workspace 5      (also: ws 5, w 5)
move 4           move the focused window to workspace 4
move firefox 4   move Firefox's window to workspace 4
```

Every form requires a literal workspace number, so an ordinary search can
never be swallowed by it. `move <app> N` fuzzy-matches the app against
the windows that actually exist and only accepts confident matches
(≥ 0.6, i.e. substring-grade or better), offering each candidate window
rather than guessing when several match. The grammar reaches workspaces
10 and up, which `Super+1..9` cannot address at all.

### Adding a provider

1. Subclass `SearchProvider` in a new file under `lib/launcher/`.
2. Add its id to `ProviderId` and its weight to `PROVIDER_WEIGHT` in
   `constants.js`, plus an entry in `SECTION_ORDER`.
3. Add its section title to `sectionTitle()` in `launcherUI.js` and a
   fallback icon to `PROVIDER_FALLBACK_ICON` in `iconProvider.js`.
4. Construct it in `LauncherManager._activate()`.

Nothing in the controller, the UI, the ranking, the keyboard handling or
the popup changes. If the provider needs to be switchable, add a
`launcher-enable-*` key and a `get enabled()`.

Providers may return a `Promise` from `query()`. The controller renders
the synchronous results immediately and merges the asynchronous ones when
they settle, discarding them if a newer query has started meanwhile
(generation token). That is the seam for future providers that need to do
real I/O — recent files, git repositories, browser bookmarks, SSH hosts,
web search, AI commands — none of which require an architectural change.

---

## Keyboard

| Key | Action |
|---|---|
| `Super+Space` | Open / close (configurable) |
| `Esc` | Close |
| `Enter` | Activate the selected result |
| `Ctrl+Enter` | Alternate action (see the provider table) |
| `Shift+Enter` | Secondary action |
| `Up` / `Down` | Move the selection (wraps) |
| `Ctrl+P` / `Ctrl+N` | Move the selection (readline style) |
| `Page Up` / `Page Down` | Move by a page |
| `Home` / `End` | First / last result |
| `Tab` / `Shift+Tab` | Jump to the next / previous section |
| `Alt+1` … `Alt+9` | Activate the Nth visible result |
| `Ctrl+D` | Pin / unpin the selected result |
| `Ctrl+Shift+Up/Down` | Reorder a pinned result |
| `Ctrl+Delete` | Remove the selected entry (clipboard history) |
| `Ctrl+Backspace` | Clear the query |
| `Left` / `Right`, `Backspace` | Ordinary text editing (never intercepted) |

Two deliberate decisions:

- `Home`/`End` navigate the **list**, not the text. A launcher query is a
  few words long; jumping to the last result is the more valuable
  binding. `Ctrl+A` / `Ctrl+E` still move the text cursor.
- `Tab` cycles **sections** rather than widgets. The popup has exactly
  one focusable widget (the entry), so the usual focus-chain meaning
  would do nothing at all.

**The Super+Space conflict.** GNOME binds `<Super>space` to
`switch-input-source` (and `<Shift><Super>space` to its backward twin).
Tessera handles this the same way it handles its other keybinding
collisions — save the exact current value, clear it, watch it, restore it
on disable — but with one refinement: the input-source keys are cleared
**only while the launcher is enabled and its accelerator genuinely
collides with them**. Rebind the launcher to something else, or leave it
off, and input-source switching is untouched. Changing either setting
rebinds outright rather than patching the difference, so the
save/clear/restore lifecycle stays uniform.

The launcher shortcut is registered with `POPUP` in its action modes, on
top of the usual `NORMAL | OVERVIEW`. That is what lets a second press
close the launcher from under its own modal grab.

Like every other Tessera accelerator it sits behind the
`enable-custom-keybindings` master switch and is individually rebindable
in Preferences.

## Mouse

Hover selects, left click activates, middle click is the alternate
action, right click is the secondary action, scrolling scrolls the list,
and a click outside the card dismisses it. There is no popup context menu
(the two extra buttons cover the same actions, and a menu would have to
fight the launcher's own modal grab for the pointer grab).

**Hover only steers the selection when the pointer actually moves.** A
hover event does not mean "the user pointed at this row" — it means
"this row is now under the pointer", which is equally true when the *row*
moves and the mouse does not. Three things do that: opening the launcher
under a resting cursor, rebuilding the list on every keystroke, and
scrolling. Left ungated, the first stole the preselected first result
whenever the cursor happened to be over the list, and the second kept
re-stealing the selection from under someone who was typing.

The gate is a comparison, not a timer or a motion handler:
`LauncherList` records the pointer position whenever hover is evaluated
and whenever the list is rebuilt, and honours a hover only if the
coordinates have changed since. If they have not, the list moved rather
than the mouse, and the keyboard keeps the selection. Clicking is
unaffected — a click sets the selection explicitly, so any row can still
be clicked whether or not hover ever selected it.

---

## The popup

Behaviour that belongs to the window itself rather than to searching:

- **It opens on the monitor the pointer is on**, and hides the Activities
  overview first if that is up — two full-screen "everything" surfaces
  stacked on each other help nobody.
- **The modal grab can fail**, and that is handled rather than ignored.
  `Main.pushModal()` returns a `Clutter.Grab`; if its seat state is not
  `ALL` (something else already holds a grab, e.g. an open panel menu)
  the popup pops the partial grab and does nothing at all, instead of
  half-opening into an unusable state.
- **The query is cleared on every open.** The launcher always starts from
  the resting view; there is no "resume where you left off".
- **The first row is preselected**, so open-and-Enter is a complete
  gesture. Selection is *drawn*, not focused — the search entry keeps key
  focus for the whole session — and the list scrolls to keep the
  selection visible via GNOME's own `ensureActorVisibleInScrollView()`.
- **The first nine rows carry an `Alt+N` hint** on the right, which both
  advertises the shortcut and matches exactly what that shortcut does.
- **A footer shows the selected result's key hints** — `↵ Open`, plus
  `Ctrl+↵` / `Shift+↵` labelled with what *that* provider does with them,
  `Ctrl+D Pin` when the result is pinnable and `Ctrl+Del Remove` when it
  can be removed, then `Esc Close`. Compact mode hides it.
- **Empty states are distinguished**: an empty query with nothing to show
  reads "Type to search" (a fresh profile), a query with no matches reads
  "No results".
- **Activation closes the popup first, then runs the action.** The
  ordering is load-bearing: popping the modal grab before the action runs
  means window operations act on a normal shell, and anything the action
  opens — a dialog, an overlay, another modal — is not fighting this one
  for the grab. The popup also goes non-reactive the instant the grab is
  released rather than when its fade-out ends, so the closing animation
  cannot swallow a click aimed at whatever was just opened.
- **Mutating the list keeps your place.** Pinning, reordering or removing
  an entry re-runs the search and restores the selected index, instead of
  throwing the cursor back to the top.

---

## Theme system

`theme.js` turns settings plus the live GNOME theme into concrete values.
The split with `stylesheet.css` follows the discipline documented in
[`ARCHITECTURE.md`](ARCHITECTURE.md) ("Settings → rendering"):

- **`stylesheet.css`** carries structure only — spacing, padding, the
  transition duration, the backdrop's dim color.
- **`theme.js`** applies every color, size and radius that must follow a
  setting, the light/dark preference, or the accent color as an inline
  style, always resolved to a literal value.

A color left in a class rule would leak through St's style transitions as
a flash of the wrong theme — a bug this project has already fixed twice
(see ARCHITECTURE.md), so the launcher adopts the discipline from its
first version.

Light/dark follows `org.gnome.desktop.interface color-scheme`, falling
back to the Yaru `-dark` theme-name suffix, and is read from the same
`Gio.Settings` instance `lib/accentColor.js` already owns — the launcher
opens no settings object of its own. With `launcher-follow-theme` off it
stays dark, the look people expect from a Spotlight-style overlay.

The accent tint on the selected row is the system accent (or the user's
custom `active-background-color`), composed to `rgba()` in JS because St
has no color-mix function.

### Placement

The launcher opens on the monitor the pointer is on, at 16% of the
monitor's height from its top edge — high enough that a long result list
still fits below it, low enough not to look pinned to the top.

Both axes are configurable:

- `launcher-position` anchors it horizontally: `center` (the default),
  `left` or `right`.
- `launcher-offset-y` nudges it vertically from that default height, in
  pixels — negative moves it up, positive moves it down.

Three details worth knowing:

- **Placement is resolved against the monitor's work area**, not its full
  rectangle, so an edge-anchored launcher lands beside a dock or side
  panel rather than underneath it, and a negative offset cannot slide the
  card up behind the top panel. With no side struts the horizontal result
  is identical, so the default centered placement is unchanged. The
  `left` and `right` anchors leave an `EDGE_MARGIN` (24px) gap, so an
  edge-anchored launcher still reads as a floating panel rather than as
  something welded to the side of the screen.
- **The vertical anchor is a fraction of the monitor**, because it is a
  proportion of the screen rather than of whatever the panel left over;
  16% already clears the panel comfortably.
- **A downward offset is clamped to keep the card on screen.** The card
  grows downwards as results arrive, so its final height is not known
  when it is placed; rather than guess, the bottom limit keeps at least
  `MIN_VISIBLE_HEIGHT` (the entry plus a row or two) inside the work
  area. An offset beyond that parks it at the limit instead of putting
  the launcher somewhere the user cannot see — which would leave them
  unable to reach the setting that did it.

Placement is applied as part of `applyTheme()`, so changing either
setting moves an already-open popup rather than waiting for the next
open.

### Blur, and why it is off by default

Blur uses `Shell.BlurEffect` in `BACKGROUND` mode on the card, which is
why the card's background carries alpha when it is on.

**It cannot be clipped to the rounded corners, and that is a platform
limit rather than a bug here.** `BACKGROUND` mode captures the
framebuffer under the actor's *allocation*, blurs it, and paints it over
that same **rectangle**; it knows nothing about `border-radius`. St
offers no way to clip an effect, and Clutter's `set_clip()` /
`clip_to_allocation` are rectangular. The one construct that would clip
it — wrapping the blur in a rounding GLSL `Clutter.ShaderEffect` — breaks
`BACKGROUND` blurring outright, because that mode reads the stage
framebuffer behind the actor, which is not what is bound once the actor
is being rendered into an offscreen buffer. So the corner regions the
rounding excludes always receive the effect's output.

Hence the two decisions here:

- **`launcher-blur` defaults to off.** With it off there is no effect on
  the card at all, the background is opaque (`surface`, not
  `surfaceBlurred`), and the rounded corners are perfectly transparent.
- **`BLUR_BRIGHTNESS` is 1.0** — no darkening. The darkening was what
  turned an almost-invisible "slightly blurrier" corner into a visible
  grey square, and the card's own translucent tint already supplies the
  contrast the text needs.

The remaining alternative, should the artifact ever matter more than the
effect does, is to blur a **full-screen layer** behind the backdrop
instead of the card: a rectangle covering the whole stage has no corners
to clip. That trades the Spotlight look (sharp desktop, blur only under
the card) for the overview look (whole desktop blurred), and costs more
GPU time, which is why it is not the default.

Compact mode is a real density change — rows, icons and padding shrink
together, and the hint footer is hidden — rather than just a smaller
font.

---

## Settings

Everything lives in Preferences → Launcher.

| Key | Default | Notes |
|---|---|---|
| `enable-launcher` | `false` | Master switch; nothing exists while off |
| `launcher-toggle` | `<Super>space` | Rebindable; see the conflict note above |
| `launcher-width` | 720 | px |
| `launcher-height` | 420 | px, a ceiling on the result list |
| `launcher-position` | `center` | horizontal anchor: `center` / `left` / `right` |
| `launcher-offset-y` | 0 | px up or down from the default height; negative is up |
| `launcher-max-results` | 30 | total; each section is capped at 8 |
| `launcher-remember-history` | `true` | Frecency ranking |
| `launcher-enable-apps` | `true` | |
| `launcher-enable-windows` | `true` | |
| `launcher-enable-recent` | `true` | Empty-query view |
| `launcher-enable-calculator` | `true` | |
| `launcher-enable-commands` | `true` | `>` / `$` prefixes |
| `launcher-command-in-terminal` | `false` | Ctrl+Enter inverts it per command |
| `launcher-enable-clipboard` | `false` | Opt-in; see Privacy below |
| `launcher-clipboard-size` | 50 | Pinned entries are exempt |
| `launcher-fuzzy` | `true` | Typo tier only |
| `launcher-search-delay` | 0 | ms; 0 searches on the keystroke |
| `launcher-show-icons` | `true` | |
| `launcher-show-descriptions` | `true` | |
| `launcher-compact` | `false` | |
| `launcher-animations` | `true` | Also gated by GNOME's reduce-motion |
| `launcher-blur` | `false` | Leaves square corners; see above |
| `launcher-corner-radius` | 18 | px; row and entry radii derive from it |
| `launcher-font-size` | 12 | pt; everything else is relative |
| `launcher-follow-theme` | `true` | |
| `launcher-follow-accent` | `true` | |
| `launcher-favorites` | `[]` | Pinned keys, in user order |
| `launcher-history` | `{}` | Internal frecency store |
| `launcher-clipboard-history` | `[]` | Recorded clipboard entries, newest first |
| `launcher-clipboard-pinned` | `[]` | Pinned clipboard entries, exempt from the size cap |

Actions, Settings panels and Extensions have no toggle — they are cheap
and always searched.

The preferences page groups these as **General** (enable, shortcut,
maximum results, remember history), **What to Search**, **Clipboard
History**, **Matching**, **Placement**, **Appearance**, and **Stored
Data** — the last holding three one-shot buttons that forget the ranking
history, clear the pins, and clear the clipboard history (both lists)
independently. Everything below the master switch is desensitised while
the launcher is off, the same GET-only binding pattern the tiling page
uses.

The three keys that are not really settings — `launcher-history`,
`launcher-favorites` and the two clipboard lists — are stored in the same
schema deliberately: they survive a shell restart, and clearing them by
hand (`gsettings reset …`) is a supported way to start over.

---

## Security and privacy

**Command execution never involves a shell.** The command line is split
by `GLib.shell_parse_argv()` — which *parses* quoting rules, it does not
execute anything — and the resulting argv is spawned through GNOME's own
`Util.trySpawnCommandLine()`, exactly as the shell's Alt+F2 run dialog
does. `> foo; rm -rf ~` therefore tries to run a program literally named
`foo;` and fails: there is no interpreter to honour the `;`, the
backticks or a `$(...)`. Commands are also never inferred from a bare
query — the `>`/`$` prefix is required, so an ordinary search can never
execute anything.

**The calculator has no `eval()`.** It is a hand-written tokenizer and
recursive-descent parser that rejects any character the grammar does not
define. The test suite asserts that command lines, statement separators,
backticks, command substitution and JavaScript identifiers all evaluate
to "not an expression".

**Clipboard history is opt-in** and off by default, because it is a
plain-text record of everything copied, stored in dconf. Three rules
limit it even when enabled: offers advertising a password-manager mime
type are never recorded, nothing is recorded while the session is locked,
and clipboard results are marked `ephemeral` so their text never enters
the launcher's own ranking history.

**Favorites store keys, not content** (`apps:firefox.desktop`), which is
why clipboard entries are not pinnable through the shared favorites list
and have their own pin list instead.

---

## Performance

Targets from the brief, and how they are met:

- **Opening under 30 ms.** The popup's actor tree is built once, on first
  use, and then kept alive hidden — reopening is a `show()` plus a grab.
  Provider caches are warmed on a low-priority timeout a few seconds
  after enable, so the first open does not pay for reading every
  `.desktop` file either.
- **Search updates under 10 ms.** Every provider is synchronous and works
  over pre-flattened strings. Matching is single-pass per candidate with
  early exits; the typo tier (the only expensive one) runs only for
  candidates that failed every cheaper tier, and abandons as soon as the
  edit distance provably exceeds its budget.
- **Thousands of apps, hundreds of windows.** The app list is enumerated
  once per `installed-changed`, not per keystroke. Windows come straight
  from Mutter's tab list. Results are capped per section and overall
  before any actor work happens.
- **No unnecessary allocations.** Result rows are pooled and re-filled
  rather than constructed per keystroke; themed icons are cached by name;
  the ASCII fast path in `normalizeText` skips per-character work for the
  overwhelming majority of strings.
- **No memory leaks.** Every signal id, timeout and grab is stored and
  released; the row pool is destroyed with the popup; provider caches are
  dropped on `disable()`.

`launcher-search-delay` exists as an escape hatch for pathological
machines, and defaults to 0 because a debounce would only add latency to
a synchronous pipeline.

---

## Lifecycle

`enable()` connects settings watchers and nothing else: the master
switch, each appearance key (`APPEARANCE_KEYS`, applied live to an open
popup), and the two `org.gnome.desktop.interface` keys that drive
light/dark and accent following. While `enable-launcher` is off there are
no providers, no popup, no caches and no other signals — the subsystem's
whole footprint is a constructed object with null fields.

Turning it on builds the action registry, the providers and the
controller, and schedules the warm-up. Turning it off (or `disable()`)
closes and destroys the popup, disables every provider (each disconnects
its own signals), cancels the warm-up timeout, drops the icon cache and
releases the modal grab if one is somehow still held. `KeybindingManager`
separately releases the accelerator and restores the input-source
shortcuts.

Screen lock does not disable Tessera (it declares `unlock-dialog`), but
the launcher is unreachable there: the accelerator is registered with
`NORMAL | OVERVIEW | POPUP`, none of which is the lock screen's action
mode, and the clipboard provider explicitly refuses to record while
`Main.sessionMode.isLocked`.

---

## Testing

`tests/run-tests.sh` runs the GSettings schema check and
`tests/launcher-engine-test.js` — 111 assertions over the fuzzy matcher,
the calculator, the string helpers, and the history/favorites stores
(both driven with a fake settings object). Those modules import no GNOME
namespace, which is exactly why they can be tested at all; the runner
uses `gjs` when available and falls back to `node`.

Everything that touches St, Meta or Shell is covered by the launcher
section of [`../tests/MANUAL_TESTS.md`](../tests/MANUAL_TESTS.md), for
the reason [`DEVELOPMENT.md`](DEVELOPMENT.md) documents: GNOME Shell
offers no supported headless harness for third-party extensions.

---

## Known limitations

- **Blur cannot follow the rounded corners.** `Shell.BlurEffect` fills
  the card's whole rectangle, so turning blur on leaves faintly blurred
  square corners around the rounded card. This is why blur ships off (see
  "Blur, and why it is off by default"); with it off the corners are
  exact.
- **Currency and unit conversion** are not implemented. Live rates need
  network I/O, which does not belong in the compositor process; the
  asynchronous provider seam is the right place for it if it is ever
  added out-of-process.
- **No drag ordering for favorites.** The popup runs under a modal
  pointer/keyboard grab where a drag gesture would have to fight that
  grab, on a surface that is otherwise entirely keyboard-driven.
  Reordering is `Ctrl+Shift+Up/Down`.
- **No popup context menu.** Middle and right click cover the alternate
  and secondary actions instead.
- **Screen-reader support is best-effort.** Rows carry accessible names
  and `LIST_ITEM` roles and the list carries `LIST`, but the selection is
  drawn rather than focused (the entry keeps key focus), so a screen
  reader does not receive a focus change per selection move.
- **`>` with nothing after it** shows no results rather than a hint row.
- **Extension enable/disable is persistent**, matching the Extensions
  app: it rewrites GNOME's `enabled-extensions` / `disabled-extensions`.

---

## Future work

The architecture already accommodates these without restructuring:

- **New providers** (the common case): recent files, git repositories,
  SSH hosts, browser tabs and bookmarks, emoji, unit conversion, package
  manager, Bluetooth/Wi-Fi/volume/brightness, media controls, calendar,
  notifications, notes, AI commands. Each is a new subclass plus four
  registration lines.
- **Asynchronous providers** are already supported end to end
  (`Promise` from `query()`, generation-token staleness handling); no
  provider needs it yet.
- **Window layouts and workspace sessions** — saving and restoring a
  workspace's tiling arrangement — would be an action provider entry plus
  storage, using the `LayoutTree` the tiling subsystem already has.
- **Calculator history** would be a provider over the existing evaluator.
- **Sub-queries** (a result that opens its own scoped search, Raycast
  style) would need one new field on the result record and a mode in the
  popup; nothing in the pipeline would change.
