# Browser tabs

The launcher can see inside supported browsers. A browser window stays an
ordinary **Open Windows** result, but it carries its tab count, can be
expanded to list its tabs, and every tab is searchable directly — by
title, host and URL — whatever its window happens to be showing.

```
Open Windows

GitHub - Google Chrome                              ▾ 4 tabs
    GitHub — Tessera                   github.com
    Laravel Documentation              laravel.com
    AWS Console                        console.aws.amazon.com
    Grafana                            grafana.example
Terminal
Reddit - Google Chrome                              ▸ 12 tabs
```

Chromium-family browsers (Google Chrome, Chromium, Brave, Edge, Vivaldi)
are supported. Firefox is not; see [Install](#install) for why.

The feature needs the **Tessera Companion** extension in the browser and
the relay registered from Tessera's Preferences — see
[Install](#install). Without them nothing changes: browser windows are
plain windows, as before.

---

## How tabs could be tracked, and what was chosen

There is no desktop-side API for a browser's tabs. Every option was
weighed against the things this feature must get right: exact activation
of one tab (never a neighbour), stable identity through reordering,
moves and restarts, per-window association, Wayland, and running for
days without drifting.

| Approach | Verdict | Why |
|---|---|---|
| **WebExtension + Native Messaging** | **Chosen** | The browser's own tab model: stable per-session tab ids, every change as an event (`tabs.onCreated/onRemoved/onUpdated/onActivated/onMoved/onAttached/onDetached/onReplaced`, `windows.*`), and exact activation by id (`tabs.update(id, {active})`). Local-only, no flags, works with the normal profile. Costs a one-time "load unpacked" step per profile. |
| Chrome DevTools Protocol | Rejected | Needs `--remote-debugging-port/-pipe` at launch, refused for the default profile since Chrome 136, and exposes full browser control on a port. |
| Firefox remote debugging / Marionette / WebDriver BiDi | Rejected | All need a launch flag or a pref plus restart, cannot attach to a running browser, and Marionette marks the session as automated. |
| Session / recovery files (`Sessions/*` SNSS, `recovery.jsonlz4`) | Rejected | Written on a timer (seconds behind reality), undocumented binary formats, no window ↔ compositor link, and above all **no way to activate a tab** except by synthesising keystrokes — the failure mode an earlier draft of this feature had, and the reason it was thrown away. |
| AT-SPI / accessibility tree | Rejected | Enabling accessibility in the browser costs it real performance on every page, tab objects have no stable identity, and gnome-shell cannot be an AT-SPI client directly. |
| GNOME / Mutter metadata | Insufficient alone | A `Meta.Window` offers title, app id and PID — nothing about tabs. Used for the window mapping only. |
| Browser IPC / D-Bus | None exists | Neither browser exposes tabs over D-Bus; Firefox's "remote" protocol only opens URLs. |

The chosen path is the only one that is event-driven, exact, and usable
with a browser the user launched normally on Wayland. It is also the
shape GSConnect has shipped on extensions.gnome.org for years: a store
extension in the browser, a relay inside the shell extension, and a
Preferences switch that registers it.

## Architecture

```
  browser profile (one per profile)
  ┌──────────────────────────────────────────────┐
  │ Tessera Companion: modules/tabs/module.js    │  tabs.* / windows.* events
  │   snapshot + sequenced events, activation    │
  └──────────────┬───────────────────────────────┘
                 │ Native Messaging (stdio, length-prefixed JSON)
  ┌──────────────▼───────────────────────────────┐
  │ native-host/tessera-browser-host (GJS)       │  relay, one per connection,
  │   forwards both ways, interprets nothing     │  registered from Preferences
  └──────────────┬───────────────────────────────┘
                 │ $XDG_RUNTIME_DIR/tessera/browser-tabs-v1.sock  (0600)
                 │ one JSON object per line
  ┌──────────────▼───────────────────────────────┐   gnome-shell
  │ lib/launcher/browserBridge.js                │  socket server, handshake,
  │   ┌──────────────────────────────────────┐   │  activation round trip
  │   │ browserTabStore.js   (pure)          │   │  sessions → windows → tabs
  │   └──────────────────────────────────────┘   │
  │ browserWindowMapper.js  (pure)               │  browser window ↔ Meta.Window
  │ browserTabService.js                         │  owns all three; talks to Mutter
  └──────┬───────────────────────────┬───────────┘
         │ describeWindows()         │ listTabs() / activate()
  windowProvider.js            browserTabsProvider.js
  (badge + children)           (direct tab search, browse)
```

`lib/launcher/browserProtocol.js` defines the messages and is owned by
the shell; `companion/modules/tabs/protocol.js` is a byte-for-byte copy
(a browser extension can only import from its own directory, and the
packaged extension does not ship the companion), and the test runner
fails if the two drift; it has no browser or GNOME dependencies so it runs under node
and gjs alike.

**One state, never persisted.** `BrowserTabStore` is the single copy of
browser state in the shell. The providers derive from it on every
keystroke and keep nothing; the UI keeps nothing but which rows are
expanded. Disable the feature and the store is empty.

## Identity

```
session  = browserType / profileId / sessionId
window   = session + browser windowId
tab      = session + browser tabId
```

- `profileId` is a random UUID the companion stores in that profile's
  `storage.local` — permanent, so two profiles can never collide even
  though both hand out tab id 5.
- `sessionId` is a random UUID in `storage.session`, which survives the
  companion's background context restarting but is cleared when the
  browser exits. **A browser restart is therefore a new session**, and
  every identity from the old one stops resolving. That is the guard
  against reused numeric ids: Chrome's tab ids restart from small numbers
  after a relaunch, and without the session scope a stale row could
  point at a brand-new tab.
- `tabId` / `windowId` are the browser's own, unique within a session.

Tab index, position, title, URL and window title are display data. None
of them is ever used to find a tab.

## Activation: exactly that tab or nothing

Enter on a tab row goes through `BrowserTabService.activate(identity)`:

1. The identity is resolved in the store. Not there — closed, moved into
   limbo between windows, or from a session that has since restarted —
   and nothing happens except a notification.
2. The bridge sends `ACTIVATE_TAB {tabId}` to that tab's own session.
   The companion calls `tabs.get(tabId)` *again* and only then
   `tabs.update(tabId, {active: true})` and `windows.update(windowId,
   {focused: true})`, replying with the window the tab turned out to be
   in. A tab that no longer exists is refused. A tab that moved to
   another window is still that tab and is activated where it now lives.
3. The shell raises the matching `Meta.Window` through
   `Main.activateWindow()` — the browser's own focus request can be
   denied by Wayland focus-stealing prevention, the shell's cannot.

There is no fallback of any kind: no "nearest index", no "same URL", no
synthesised keystrokes. The required cases are covered by
`tests/browser-tab-store-test.js` and `tests/browser-bridge-test.js`:
closing a sibling, reordering, moving between windows, a closed target
followed by a new tab, duplicate titles/URLs, and a browser restart that
reuses ids.

## Mapping browser windows to GNOME windows

This is the one thing neither side can answer directly: a WebExtension's
window ids mean nothing outside the browser, and on Wayland Mutter sees
a toplevel with a title and an app id and nothing else. The mapper
(`browserWindowMapper.js`) infers the pairing from evidence, in strictly
descending order of trust:

1. **Focus (strong).** When the browser reports *window W is now
   focused*, the `Meta.Window` holding keyboard focus at that instant
   *is* W — Mutter grants focus before the client can know about it.
   Checked for family (a Chrome window for a Chrome session) and title
   agreement, so a message that arrives a beat late is harmless.
   Recorded on every snapshot and focus event; overridden only by a
   later focus observation or the window going away. Every window the
   user has touched since the browser connected is confirmed this way.
2. **Exact title.** The window's expected title — the active tab's title
   plus a product suffix (` - Google Chrome`, learned from the
   companion's reported name and from confirmed pairs) — equals exactly
   one shell window's title, and that shell window matches no other
   browser window. Resolved by elimination, so two windows with
   different titles pair before either is focused.
3. **Prefix (weak).** Same, but the shell title merely starts with the
   active tab's title followed by a dash-like separator — for a fork
   whose suffix has not been learned yet.

Anything still ambiguous — two windows both on *New Tab* that nobody has
focused since the browser connected — stays **unbound**: those windows
show no count and no chevron rather than the wrong window's tabs.
Focusing either one resolves both.

The mapping never affects *which tab* is activated, only which
compositor window is raised afterwards. Titles are compared after
collapsing whitespace and stripping bidi marks; comparisons run against
every open window, not just the rows on screen, so elimination sees the
whole pool. No X11 tool is involved; nothing here differs between X11
and Wayland.

## What you see

**Counts.** A mapped browser window's row ends in `N tabs`, from the
store's current state — it updates as tabs open and close, including
while the launcher is open (the service asks the popup to re-run its
query, coalesced to one redraw per 60 ms burst).

**Expand / collapse.** With nothing typed:

| Key | On | Does |
|---|---|---|
| `→` | a collapsed browser window | shows its tabs beneath it |
| `→` | an expanded window | steps to its first tab |
| `←` | a tab | returns to its window |
| `←` | an expanded window | hides its tabs |

`Left`/`Right` normally belong to the search entry, which holds key
focus for the whole session. They can double as expand/collapse
only because the hierarchy exists solely while the query is *empty* —
and an empty entry has no cursor to move. The popup makes that
emptiness check (the same way plain `Backspace` clears the filter only
once there is nothing left to delete); with any text typed the arrows
reach the entry untouched, and modified arrows (`Shift`, `Ctrl`) are
never taken. With the mouse, the chevron just before the tab count at
the right of the row toggles it without activating the window.

Expanded tabs are ordinary rows: `Up`/`Down`, `Page Up/Down`, `Home`/
`End`, `Alt+N` and hover all treat them like anything else. Expansion
is remembered by result key, so it survives the list being rebuilt, and
is reset on every open.

**Enter** on the window focuses the window (unchanged; `Ctrl+Enter`
still brings it to this workspace). **Enter** on a tab activates that
exact tab and raises its window.

**Icons.** A tab row shows the site's favicon with the browser's own
icon as a small mark over its bottom-right corner, so a Chrome tab and
a Brave tab of the same site are told apart at a glance. A tab
without a favicon shows the browser's icon alone. A mapped browser
*window* row gets the same treatment with its active tab's favicon, so
a window and its tabs read as one family; an unmapped or empty window
keeps the plain browser icon. The browser icon is
that of the application behind the mapped window, falling back to the
browser's desktop entry before any window is mapped.

Favicons never involve the shell fetching anything. The companion reads
them from the browser's own favicon cache (`favicon` permission,
Chromium's `_favicon/` endpoint) or decodes a `data:` URL the browser
already reported, and delivers each distinct icon once per connection
as a small PNG in an `ICONS` message — unsequenced side data keyed by a
hash of the icon URL, which every tab of one site shares. The shell
decodes each once into a `Gio.BytesIcon`, keeps them in memory per
session (capped, oldest first), and accepts only raster formats:
SVG is refused outright.

## Search

| Query | Browser windows | Tabs |
|---|---|---|
| empty | hierarchy: badge, chevron, expandable children | only as children |
| empty, filtered to *Browser Tabs* | — | every tab, flat, focused window first |
| non-empty | badge only (window matched on its own title, as before) | searched **directly**, as their own *Browser Tabs* section |

Direct search means: a Chrome window showing *YouTube* that also holds a
*Laravel Documentation* tab answers `laravel` with

```
Browser Tabs
  Laravel Documentation
  laravel.com · Google Chrome
```

whether or not the window is expanded and whatever its title is. Tabs
are matched by the ordinary matcher (title at full weight, host at 0.8)
and, failing that, by every term appearing verbatim in the URL at a
fixed low score — subsequence-matching hundreds of long URLs would make
short queries match every tab. The section is weighted slightly below
windows and applications (`PROVIDER_WEIGHT` 0.96) so it leads when a tab
title genuinely matches best rather than on every near-tie.

## Synchronisation

Event-driven end to end; nothing polls.

- On connect the companion sends `HELLO`, the shell answers
  `SYNC_REQUEST`, and the companion sends a `SNAPSHOT` of every window
  and tab. Listeners are registered before anything else, and events
  are serialised behind the snapshot, so nothing can fall between "read
  the state" and "start listening".
- Every change after that is one event with a strictly increasing
  `sequence`. Tab created/updated/removed/activated/moved/attached/
  detached/replaced, window created/updated/removed/focused. The
  browser only announces the tab that moved or closed, so after any
  structural change the companion also re-reads the affected window's
  tabs and sends them whole (`WINDOW_RECONCILED`) — that is what keeps
  sibling indexes honest.
- A gap in the sequence, an event that does not fit, an API call that
  fails mid-event, an activation that is refused or times out: each
  hides the session (`RESYNCING`) and asks for a fresh snapshot. The
  launcher shows nothing from a session it cannot vouch for, briefly,
  rather than something it guessed.
- Disconnect drops the session outright. The companion reconnects with
  backoff (1 s doubling to 16 s, then a once-a-minute alarm), which is
  also what happens when the launcher is off: one failed relay spawn a
  minute and nothing else. Chrome keeps a service worker alive while a
  native port is connected (Chrome 105+), so there is no idle churn.
- The same profile reconnecting (its background context restarted)
  supersedes its previous connection and starts untrusted until its
  snapshot arrives. Its `sessionId` is unchanged, so rows built before
  the reconnect still resolve once it is back.

## Install

Two halves, both from a normal install of Tessera:

1. **Preferences → Launcher → Browser Integration → "Register the relay
   with Chromium browsers".** Tessera writes one small Native Messaging
   manifest per browser (Chrome and Chromium always; Brave, Edge and
   Vivaldi where they are installed) pointing at the relay *inside the
   extension directory*, and makes the relay executable. Nothing is
   copied anywhere. Turning the switch off removes exactly those files.
   The row reports which browsers are registered, and says so if a
   manifest points at an old location (the extension moved) so you can
   flip it off and on.
2. **Install Tessera Companion in each browser profile** whose tabs
   should appear, from the Chrome Web Store ("Open Store Page" in the
   same group). It is one extension made of modules; the *Launcher tabs*
   module is on by default and can be switched off in the companion's
   options page. The fixed key in `companion/manifest.json` keeps its id
   `dcalnkplbhcblhdidppkmgoooggflphg` identical everywhere, which is
   what the manifests' allow-list relies on.

Until the store listing is live, and for development, load the
companion unpacked: `chrome://extensions` → Developer mode → *Load
unpacked* → the `companion/` folder of a checkout. Preferences shows
this path too.

The relay is a GJS script, so the whole feature depends on nothing the
shell does not already provide. Snap and Flatpak browsers cannot start a
host on the system side and are not supported. Firefox is not supported:
its event pages drop native ports when idle and it lacks the favicon
cache endpoint, so a Firefox module would need a different design; the
shell side is browser-agnostic should one be added.

### The companion's layout

```
companion/
    manifest.json          name, permissions, icons, options page
    background.js          the module host: reads settings, starts modules
    options.html / .js     one row per module: description, switch, status
    modules/
        registry.js        module metadata (shared by host and options page)
        tabs/
            module.js      the Launcher tabs module (owns the native port)
            protocol.js    verbatim copy of lib/launcher/browserProtocol.js
```

A module exports `id`, `setEnabled(bool)` and `status()`, registers its
own browser listeners at import time (a Manifest V3 service worker is
only woken for listeners that already exist) and gates them on the
enabled flag the host hands it. Adding a module is a folder, one
registry entry, and its permissions in the manifest.

## Privacy and security

- Titles and URLs travel from the browser to gnome-shell and nowhere
  else: no network, no files, no D-Bus broadcast. They are held in
  memory and gone when the session disconnects or the feature is off.
- Tab rows are `ephemeral`: never recorded in the launcher's ranking
  history (the key embeds a session token anyway) and never pinnable.
- Favicons are read from the browser's own cache or a reported `data:`
  URL, never fetched by the shell; each is capped at 32 KB, limited to
  raster formats (no SVG), held in memory only, and dropped with the
  session.
- Nothing logs a URL. Warnings name message types, not contents.
- The socket is mode 0600 in a 0700 directory under `$XDG_RUNTIME_DIR`
  — the same boundary as the session bus. Everything arriving is
  validated (`protocol.js`) and unknown fields are dropped; a malformed
  message closes that connection.
- The browser side asks for `tabs`, `nativeMessaging`, `storage` and
  `alarms` — no host permissions, no content scripts, no ability to read
  page contents. The relay is standard-library Python that forwards
  bytes.
- What a malicious local process could do with the socket (inject fake
  rows, receive activation requests) it could already do as your user.

## Performance

- Designed for hundreds of tabs: a 600-tab snapshot plus 400 events
  applies in a few milliseconds (asserted in the store tests). Events
  are map updates; only the affected window is re-read after a
  structural change; full snapshots happen at connection and recovery
  boundaries only.
- Search is the ordinary synchronous provider pass over pre-flattened
  records; the mapping is a handful of set operations over the open
  windows of one browser family.
- Favicons cost one transfer per distinct icon per connection (one to
  three KB each; a few hundred tabs on distinct sites is under a
  megabyte once), one decode per icon per session, and one extra small
  actor per row. Title changes never resend icons.
- Redraws while the popup is open are coalesced (60 ms); the popup keeps
  the selection where it was.

## Testing

`tests/run-tests.sh` covers everything that does not need a browser or a
live shell:

| Test | Runtime | Covers |
|---|---|---|
| `browser-tab-store-test.js` | gjs / node | snapshot, every event, per-window counts, reorder, cross-window moves, duplicate titles, session replacement, stale identities, sequence gaps, favicon keys/validation/caps, 600-tab scale |
| `browser-window-mapper-test.js` | gjs / node | exact/prefix/elimination pairing, ambiguity left unbound, focus overriding, pruning, families and profiles |
| `browser-bridge-test.js` | gjs | the real socket: handshake, protocol version, snapshot, activation round trip, timeout, gap resync, stale activation, duplicate session, malformed input, stop/restart |
| `browser-companion-test.js` | node | the Tabs module against a mocked Chromium API: registry defaults, enable/disable, handshake, snapshot ordering, event filtering, reconciliation, exact and refused activation, favicon delivery from the browser cache and from `data:` URLs |
| `native-host-test.js` | gjs | the relay's framing, and the real executable as a subprocess against the real bridge: HELLO in, SYNC_REQUEST out, clean exit on browser close, exit 1 without Tessera or when Tessera closes |
| `browser-integration-test.js` | gjs | the Preferences installer against a throwaway config root: manifests for installed browsers only, relay made executable, stale-path detection, foreign manifests ignored, uninstall |

Everything that touches a real browser or Mutter is in the *Browser
tabs* section of [`../tests/MANUAL_TESTS.md`](../tests/MANUAL_TESTS.md).

## Limitations

- **Two windows with identical titles that have not been focused since
  the browser connected show no count** until one is focused. This is
  deliberate (see the mapping rules).
- **Chromium's product suffix is inferred.** The companion reports the
  product name from client hints; an unusual fork pairs by the prefix
  rule until its first focus teaches the exact suffix.
- **Raising an unmapped window after activation** relies on its title
  changing to the activated tab's title within ~600 ms; if that never
  matches, the tab is still activated and the browser's own focus
  request stands.
- **Popup-type windows** (a single-tab window opened by a page) are
  tracked and searchable; they carry a `1 tab` badge like any other.
- **Setup is per browser profile** (the companion), plus one switch in
  Preferences. Until the Chrome Web Store listing is live the companion
  has to be loaded unpacked.
