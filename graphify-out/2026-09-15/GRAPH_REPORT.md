# Graph Report - tessera  (2026-09-15)

## Corpus Check
- 118 files · ~165,323 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 9 file(s) not represented in the graph (top: (none) 7, .xml 1, .css 1)

## Summary
- 1236 nodes · 2216 edges · 78 communities (53 shown, 24 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 32 edges (avg confidence: 0.89)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `ac8b4e9b`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- constants.js
- launcher-engine-test.js
- SettingsManager
- TilingManager
- extension.js
- LauncherTheme
- BrowserTabStore
- calculatorEngine.js
- KeybindingManager
- ClipboardProvider
- SearchController
- PanelAutoHideManager
- prefs.js
- ActionRegistry
- browserTabService.js
- WindowMover
- BrowserTabService
- ._activate
- fuzzyMatcher.js
- Tessera Architecture
- Launcher Search Pipeline
- Incremental Update Workflow
- Reconciled Layout Tree
- What You Must Do When Invoked
- Tessera Tiling Workspace Manager
- paletteProvider.js
- graphify reference: extra exports and benchmark
- Semantic Extraction Contract
- Existing Graph Query Workflow
- Incremental Update Workflow
- Stacked Tabbed Layout
- Graphify Skill
- Graphify Extra Exports
- GitHub and Merge Workflow
- Graphify Integration Hooks
- Media Transcription Workflow
- Graphify Skill
- module.js
- Numbered Workspace Indicator
- launcher.js
- Graphify Integration Instructions
- Keybinding Override Lifecycle
- Window Movement Architecture
- Symlink-Based Local Iteration
- dev-nested.sh
- Panel Auto-Hide Architecture
- GNOME 46 Ubuntu Reference Environment
- build.sh
- dev-session.sh
- dev-symlink.sh
- install.sh
- run-tests.sh
- schema-validate.sh
- SearchProvider
- graphify reference: query, path, explain
- graphify reference: add a URL and watch a folder
- graphify reference: commit hook and native CLAUDE.md integration
- graphify reference: incremental update and cluster-only
- graphify reference: GitHub clone and cross-repo merge
- graphify reference: transcribe video and audio
- extraction-spec.md
- browser-bridge-test.js
- Browser tabs
- browser-companion-test.js
- HistoryManager
- ActionProvider
- browserIntegration.js
- BrowserTabsProvider
- manifest.json
- launcher/utils.js
- WindowProvider
- FavoritesManager
- native-host-test.js
- AppProvider
- BrowserBridge
- browser-tab-store-test.js
- browserProtocol.js

## God Nodes (most connected - your core abstractions)
1. `SettingsManager` - 70 edges
2. `TilingManager` - 40 edges
3. `SearchProvider` - 35 edges
4. `BrowserTabStore` - 30 edges
5. `ClipboardProvider` - 23 edges
6. `LauncherTheme` - 22 edges
7. `KeybindingManager` - 20 edges
8. `BrowserTabService` - 20 edges
9. `SearchController` - 20 edges
10. `ActionRegistry` - 19 edges

## Surprising Connections (you probably didn't know these)
- `Native Unified Launcher` --semantically_similar_to--> `Tessera Launcher Design`  [INFERRED] [semantically similar]
  README.md → docs/LAUNCHER.md
- `Incremental Update Workflow` --semantically_similar_to--> `Incremental Update Workflow`  [INFERRED] [semantically similar]
  .claude/skills/graphify/references/update.md → .codex/skills/graphify/references/update.md
- `Graphify Skill` --semantically_similar_to--> `Graphify Skill`  [INFERRED] [semantically similar]
  .claude/skills/graphify/SKILL.md → .codex/skills/graphify/SKILL.md
- `Graphify Add and Watch` --semantically_similar_to--> `Graphify Add and Watch`  [INFERRED] [semantically similar]
  .claude/skills/graphify/references/add-watch.md → .codex/skills/graphify/references/add-watch.md
- `Reversible Extension Lifecycle` --semantically_similar_to--> `Exact Disable Restoration`  [INFERRED] [semantically similar]
  README.md → docs/ARCHITECTURE.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Claude Graphify Pipeline Components** — _claude_skills_graphify_skill_graphify_skill, _claude_skills_graphify_references_extraction_spec_semantic_extraction_contract, _claude_skills_graphify_references_query_existing_graph_query_workflow, _claude_skills_graphify_references_update_incremental_update_workflow, _claude_skills_graphify_references_exports_extra_exports [EXTRACTED 1.00]
- **Codex Graphify Pipeline Components** — _codex_skills_graphify_skill_graphify_skill, _codex_skills_graphify_references_extraction_spec_semantic_extraction_contract, _codex_skills_graphify_references_query_existing_graph_query_workflow, _codex_skills_graphify_references_update_incremental_update_workflow, _codex_skills_graphify_references_exports_extra_exports [EXTRACTED 1.00]
- **Ground-Truth Self-Healing Pattern** — docs_architecture_ground_truth_recomputation, docs_architecture_reconciled_layout_tree, docs_architecture_debounced_relayout_pipeline, docs_launcher_search_pipeline [INFERRED 0.85]
- **Live Shell Verification Strategy** — docs_development_manual_ui_verification, docs_gnome_notes_installed_source_reverification, tests_manual_tests_live_shell_behavior_suite [INFERRED 0.85]
- **Project Graphify Guidance** — _claude_claude_graphify_directive, _claude_skills_graphify_skill_graphify_skill, _codex_skills_graphify_skill_graphify_skill, agents_graphify_project_policy [INFERRED 0.85]
- **Public GNOME Integration Principle** — readme_public_gnome_integration, docs_architecture_public_api_cooperation, docs_gnome_notes_verified_public_tiling_apis, docs_gnome_notes_verified_launcher_apis [INFERRED 0.95]

## Communities (78 total, 24 thin omitted)

### Community 0 - "constants.js"
Cohesion: 0.13
Nodes (25): BACKDROP_OPACITY, BLUR_BRIGHTNESS, BLUR_RADIUS, CLOSE_DURATION_MS, COMMAND_PREFIXES, FAVORITE_BOOST, FAVORITES_SECTION, FILTERABLE_SECTIONS (+17 more)

### Community 1 - "launcher-engine-test.js"
Cohesion: 0.12
Nodes (17): FRECENCY_HALF_LIFE_MS, MAX_HISTORY_ENTRIES, decayFactor(), check(), cleared, equal(), favorites, fields (+9 more)

### Community 3 - "TilingManager"
Cohesion: 0.08
Nodes (13): computeStackGeometry(), insetRect(), LayoutMode, LayoutTree, STACK_TAB_BAR_HEIGHT, StackTabBar, floatingWindows, stackedWorkspaces (+5 more)

### Community 4 - "extension.js"
Cohesion: 0.06
Nodes (13): TesseraExtension, AccentColorTracker, YARU_ACCENT_HEX, ColorPickerOverlay, colorToHex(), pickColor(), toHexComponent(), FullscreenManager (+5 more)

### Community 5 - "LauncherTheme"
Cohesion: 0.07
Nodes (18): FocusBorderManager, HIGHLIGHTABLE_TYPES, GestureProgressTracker, LauncherTheme, METRICS, PALETTE, hexToRgba(), alphabetLabel() (+10 more)

### Community 7 - "calculatorEngine.js"
Cohesion: 0.14
Nodes (10): alternateForms(), CONSTANTS, evaluate(), formatValue(), FUNCTIONS, ParseError, Parser, tokenize() (+2 more)

### Community 8 - "KeybindingManager"
Cohesion: 0.16
Nodes (6): DESKTOP_WM_KEYS_TO_CLEAR, INPUT_SOURCE_KEYS, KeybindingManager, lookupOptionalSettings(), MUTTER_KEYS_TO_CLEAR, SHELL_KEYS_TO_CLEAR

### Community 10 - "SearchController"
Cohesion: 0.18
Nodes (3): parseQuery(), SearchController, resultKey()

### Community 11 - "PanelAutoHideManager"
Cohesion: 0.19
Nodes (3): opacityDecl(), PANEL_BOX_CHROME_PARAMS, PanelAutoHideManager

### Community 12 - "prefs.js"
Cohesion: 0.21
Nodes (13): addButtonRow(), addColorEntryRow(), addComboRow(), addPresetRow(), addScaleRow(), addShortcutRow(), addSpinRow(), addStringPresetRow() (+5 more)

### Community 14 - "browserTabService.js"
Cohesion: 0.20
Nodes (9): BrowserEventType, BrowserType, MessageType, PROTOCOL_VERSION, validOpaqueId(), WINDOW_ID_NONE, BROWSER_DESKTOP_IDS, FAMILY_PATTERNS (+1 more)

### Community 16 - "BrowserTabService"
Cohesion: 0.08
Nodes (15): BrowserTabService, defaultSuffixes(), shellKey(), windowClass(), BindingStrength, browserKey(), BrowserWindowMapper, expectedTitles() (+7 more)

### Community 17 - "._activate"
Cohesion: 0.08
Nodes (4): CommandProvider, ExtensionProvider, LauncherManager, SettingsProvider

### Community 18 - "fuzzyMatcher.js"
Cohesion: 0.20
Nodes (14): anchoredSubsequence(), boundedEditDistance(), fieldAllowed(), highlightTarget(), isPrimary(), matchAcronym(), matchFields(), matchSubsequence() (+6 more)

### Community 19 - "Tessera Architecture"
Cohesion: 0.33
Nodes (12): Tessera Architecture, Isolated Module Composition, Owned Fullscreen State, Tessera Development Guide, GNOME 47 and 48 Porting Checklist, GNOME 46 Integration Notes, Installed Source Reverification, Verified Public Launcher APIs (+4 more)

### Community 20 - "Launcher Search Pipeline"
Cohesion: 0.17
Nodes (12): Ground-Truth Recomputation, Adaptive Launcher Ranking, Asynchronous Provider Seam, Clipboard History Privacy, Non-Overlapping Match Tiers, Open Windows Priority, Provider Controller UI Separation, Scope Bar Filtering (+4 more)

### Community 21 - "Incremental Update Workflow"
Cohesion: 0.18
Nodes (11): Graphify Add and Watch, Incremental Folder Watcher, URL Ingestion, Cluster-Only Refresh, Code-Only Update Fast Path, Incremental Update Workflow, Semantic Manifest Integrity, Replace on Re-Extract (+3 more)

### Community 22 - "Reconciled Layout Tree"
Cohesion: 0.15
Nodes (13): Debounced Relayout Pipeline, Focus-Aware Insertion, Pure Integer Layout Geometry, Reconciled Layout Tree, Two-Tier Window Membership, Workspace-Monitor Layout Buckets, Manual UI Verification, Pure Logic Test Seam (+5 more)

### Community 23 - "What You Must Do When Invoked"
Cohesion: 0.08
Nodes (24): For /graphify add and --watch, For /graphify query, For the commit hook and native AGENTS.md integration, For --update and --cluster-only, /graphify, Honesty Rules, Interpreter guard for subcommands, Part A - Structural extraction for code files (+16 more)

### Community 24 - "Tessera Tiling Workspace Manager"
Cohesion: 0.17
Nodes (12): Exact Disable Restoration, Cooperate with GNOME Public APIs, Launcher Action Catalogue, Captured Target Window, Lazy Launcher Lifecycle, Shell-Free Command Execution, GNOME-Owned Behavior Out of Scope, Native Unified Launcher (+4 more)

### Community 25 - "paletteProvider.js"
Cohesion: 0.21
Nodes (6): PALETTE_COMMANDS_SECTION, PALETTE_FILTERS_SECTION, PROVIDER_FALLBACK_ICON, sectionIconName(), hostOf(), PaletteProvider

### Community 26 - "graphify reference: extra exports and benchmark"
Cohesion: 0.22
Nodes (8): graphify reference: extra exports and benchmark, Step 6b - Wiki (only if --wiki flag), Step 7 - Neo4j export (only if --neo4j or --neo4j-push flag), Step 7a - FalkorDB export (only if --falkordb or --falkordb-push flag), Step 7b - SVG export (only if --svg flag), Step 7c - GraphML export (only if --graphml flag), Step 7d - MCP server (only if --mcp flag), Step 8 - Token reduction benchmark (only if total_words > 5000)

### Community 27 - "Semantic Extraction Contract"
Cohesion: 0.29
Nodes (8): Extraction Confidence Taxonomy, Deterministic Node Identity, Disk Chunk Output Contract, Semantic Extraction Contract, Extraction Confidence Taxonomy, Deterministic Node Identity, Inline Agent Output Contract, Semantic Extraction Contract

### Community 28 - "Existing Graph Query Workflow"
Cohesion: 0.25
Nodes (8): BFS and DFS Graph Traversal, Constrained Query Expansion, Existing Graph Query Workflow, Query Feedback and Work Memory, BFS and DFS Graph Traversal, Constrained Query Expansion, Existing Graph Query Workflow, Query Feedback and Work Memory

### Community 29 - "Incremental Update Workflow"
Cohesion: 0.25
Nodes (8): Cluster-Only Refresh, Code-Only Update Fast Path, Incremental Update Workflow, Semantic Manifest Integrity, Replace on Re-Extract, Existing Graph First, Graph Maintenance After Code Changes, Graphify Project Policy

### Community 30 - "Stacked Tabbed Layout"
Cohesion: 0.15
Nodes (13): Explicit Inline Active Colors, Independent Focus Border, Per-Window Floating Membership Override, Persistent User Layout Choices, Stacked Group Posture, Tab-Bar Visibility Ownership, Workspace Chrome Layering, Screen-Lock Session Modes (+5 more)

### Community 31 - "Graphify Skill"
Cohesion: 0.33
Nodes (6): Graphify Directive, AST and Semantic Extraction Split, Existing Graph Fast Path, Graph Health Gate, Graphify Skill, Persistent Knowledge Graph

### Community 32 - "Graphify Extra Exports"
Cohesion: 0.33
Nodes (6): Graphify Extra Exports, MCP Query Server, Optional Export Formats, Graphify Extra Exports, MCP Query Server, Optional Export Formats

### Community 33 - "GitHub and Merge Workflow"
Cohesion: 0.33
Nodes (6): Cross-Repository Graph Merge, GitHub and Merge Workflow, Monorepo Output Isolation, Cross-Repository Graph Merge, GitHub and Merge Workflow, Monorepo Output Isolation

### Community 34 - "Graphify Integration Hooks"
Cohesion: 0.33
Nodes (6): Graphify Integration Hooks, Native CLAUDE.md Integration, Post-Commit Rebuild Hook, Graphify Integration Hooks, Native CLAUDE.md Integration, Post-Commit Rebuild Hook

### Community 35 - "Media Transcription Workflow"
Cohesion: 0.33
Nodes (6): Media Transcription Workflow, Transcript-to-Document Bridge, Whisper Domain Prompt, Media Transcription Workflow, Transcript-to-Document Bridge, Whisper Domain Prompt

### Community 36 - "Graphify Skill"
Cohesion: 0.40
Nodes (5): AST and Semantic Extraction Split, Existing Graph Fast Path, Graph Health Gate, Graphify Skill, Persistent Knowledge Graph

### Community 37 - "module.js"
Cohesion: 0.06
Nodes (63): applySettings(), IMPLEMENTATIONS, MODULES, resolveSettings(), SETTINGS_KEY, activateTab(), clearReconnect(), connectNative() (+55 more)

### Community 38 - "Numbered Workspace Indicator"
Cohesion: 0.50
Nodes (4): Defensive Private API Reach, Absolute Swipe Progress Mapping, Native Workspace Dot Sources, Numbered Workspace Indicator

### Community 39 - "launcher.js"
Cohesion: 0.19
Nodes (9): MOVE_WORDS, WORKSPACE_WORDS, TERMINAL_APP_IDS, SECRET_MIME_TYPES, ProviderId, APPEARANCE_KEYS, LauncherPopup, ActivationMode (+1 more)

### Community 40 - "Graphify Integration Instructions"
Cohesion: 0.67
Nodes (3): Graph-First Codebase Navigation, Graphify Integration Instructions, Incremental Graph Currency

### Community 41 - "Keybinding Override Lifecycle"
Cohesion: 0.67
Nodes (3): Keybinding Override Lifecycle, Independent Keybinding Conflict Owners, Persistent Keybinding Backup

### Community 42 - "Window Movement Architecture"
Cohesion: 0.67
Nodes (3): New-Window Workspace Placement, Window Movement Architecture, GNOME Window Movement Primitives

### Community 43 - "Symlink-Based Local Iteration"
Cohesion: 0.67
Nodes (3): ES Module Reload Constraint, Symlink-Based Local Iteration, Safe Install from Symlink Mode

### Community 55 - "graphify reference: query, path, explain"
Cohesion: 0.33
Nodes (5): For /graphify explain, For /graphify path, graphify reference: query, path, explain, Step 0 — Constrained query expansion (REQUIRED before traversal), Step 1 — Traversal

### Community 56 - "graphify reference: add a URL and watch a folder"
Cohesion: 0.50
Nodes (3): For /graphify add, For --watch, graphify reference: add a URL and watch a folder

### Community 57 - "graphify reference: commit hook and native CLAUDE.md integration"
Cohesion: 0.50
Nodes (3): For git commit hook, For native CLAUDE.md integration, graphify reference: commit hook and native CLAUDE.md integration

### Community 58 - "graphify reference: incremental update and cluster-only"
Cohesion: 0.50
Nodes (3): For --cluster-only, For --update (incremental re-extraction), graphify reference: incremental update and cluster-only

### Community 62 - "browser-bridge-test.js"
Cohesion: 0.12
Nodes (14): activation, applied, badIcon, bridge, companion, connect(), hello, identity (+6 more)

### Community 63 - "Browser tabs"
Cohesion: 0.13
Nodes (15): Activation: exactly that tab or nothing, Architecture, Browser tabs, How tabs could be tracked, and what was chosen, Identity, Install, Limitations, Mapping browser windows to GNOME windows (+7 more)

### Community 64 - "browser-companion-test.js"
Cohesion: 0.06
Nodes (23): cachedIcon, dataIcon, delivered, events, FakeEvent, FakePort, fetched, focusCalls (+15 more)

### Community 67 - "browserIntegration.js"
Cohesion: 0.11
Nodes (20): BROWSERS, COMPANION_EXTENSION_ID, COMPANION_STORE_URL, HOST_NAME, install(), manifestPath(), readManifest(), RELAY_RELATIVE_PATH (+12 more)

### Community 68 - "BrowserTabsProvider"
Cohesion: 0.27
Nodes (3): BrowserTabsProvider, hostOf(), urlContainsEveryTerm()

### Community 69 - "manifest.json"
Cohesion: 0.11
Nodes (18): background, service_worker, type, description, icons, 128, 16, 32 (+10 more)

### Community 70 - "launcher/utils.js"
Cohesion: 0.23
Nodes (8): CURRENT_WORKSPACE_BOOST, ResultRow, collapseWhitespace(), escapeMarkup(), foldChar(), markupWithHighlights(), normalizeText(), WORD_SEPARATORS

### Community 73 - "native-host-test.js"
Cohesion: 0.11
Nodes (26): decodeLength(), decoder, encodeNativeMessage(), encoder, MAX_INCOMING_BYTES, MAX_OUTGOING_BYTES, parseMessage(), ProtocolError (+18 more)

### Community 76 - "browser-tab-store-test.js"
Cohesion: 0.31
Nodes (7): iconKeyFor(), check(), equal(), hello(), readyStore(), tab(), window()

### Community 78 - "browserProtocol.js"
Cohesion: 0.18
Nodes (18): boundedString(), ICON_MIME_TYPES, MAX_ICON_BYTES, MAX_ICONS_PER_MESSAGE, NATIVE_HOST_NAME, normalizeIcon(), normalizeTab(), normalizeWindow() (+10 more)

## Knowledge Gaps
- **239 isolated node(s):** `IMPLEMENTATIONS`, `manifest_version`, `name`, `version`, `description` (+234 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 487 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **24 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `SettingsManager` connect `SettingsManager` to `extension.js`, `._pushHistory`?**
  _High betweenness centrality (0.085) - this node is a cross-community bridge._
- **Why does `SearchController` connect `SearchController` to `constants.js`, `._activate`, `launcher.js`?**
  _High betweenness centrality (0.048) - this node is a cross-community bridge._
- **Why does `TilingManager` connect `TilingManager` to `extension.js`?**
  _High betweenness centrality (0.039) - this node is a cross-community bridge._
- **What connects `IMPLEMENTATIONS`, `manifest_version`, `name` to the rest of the system?**
  _239 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `constants.js` be split into smaller, more focused modules?**
  _Cohesion score 0.13118279569892474 - nodes in this community are weakly interconnected._
- **Should `launcher-engine-test.js` be split into smaller, more focused modules?**
  _Cohesion score 0.11904761904761904 - nodes in this community are weakly interconnected._
- **Should `SettingsManager` be split into smaller, more focused modules?**
  _Cohesion score 0.03076923076923077 - nodes in this community are weakly interconnected._