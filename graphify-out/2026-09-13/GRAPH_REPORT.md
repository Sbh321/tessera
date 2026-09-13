# Graph Report - tessera  (2026-09-13)

## Corpus Check
- 88 files · ~123,188 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 6 file(s) not represented in the graph (top: (none) 4, .xml 1, .css 1)

## Summary
- 805 nodes · 1473 edges · 54 communities (33 shown, 20 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 23 edges (avg confidence: 0.91)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Launcher Providers and UI
- Favorites and Fuzzy Ranking
- Settings and Preferences
- Tiling Layout Engine
- Extension Lifecycle and Theme
- Focus Border and Styling
- Launcher Extension Manager
- Calculator Parsing
- Keybinding Management
- Clipboard Provider
- Search Controller Pipeline
- Panel Auto Hide
- Preferences UI
- Action Registry
- Application Provider
- Workspace Window Movement
- Fullscreen Management
- Action Search Provider
- Window Search Provider
- Project Architecture Documentation
- Launcher Ranking Design
- Graphify Add Update Workflow
- Tiling Algorithms and Testing
- Gesture Progress Tracking
- Public GNOME Integration
- Palette Provider
- Command Provider
- Semantic Extraction Contracts
- Graph Query Workflows
- Graph Maintenance Policy
- Floating and Visual Styling
- Claude Graphify Skill
- Graph Export Formats
- Repository Merge Workflows
- Graphify Integration Hooks
- Media Transcription
- Codex Graphify Skill
- Stacked Layout Visibility
- Workspace Gesture Indicator
- Lifecycle Cleanup Guarantees
- Graph Navigation Guidance
- Keybinding Conflict Lifecycle
- GNOME Window Movement
- Local Development Reloading
- Nested Shell Development
- Panel Box Mechanics
- Yaru Accent Integration
- Build Script
- Development Session Script
- Symlink Development Script
- Installation Script
- Test Runner Script
- Schema Validation Script

## God Nodes (most connected - your core abstractions)
1. `SettingsManager` - 69 edges
2. `TilingManager` - 40 edges
3. `SearchProvider` - 33 edges
4. `ClipboardProvider` - 23 edges
5. `KeybindingManager` - 20 edges
6. `SearchController` - 20 edges
7. `ActionRegistry` - 19 edges
8. `LauncherTheme` - 19 edges
9. `PanelAutoHideManager` - 19 edges
10. `AppProvider` - 18 edges

## Surprising Connections (you probably didn't know these)
- `Native Unified Launcher` --semantically_similar_to--> `Tessera Launcher Design`  [INFERRED] [semantically similar]
  README.md → docs/LAUNCHER.md
- `Graphify Skill` --semantically_similar_to--> `Graphify Skill`  [INFERRED] [semantically similar]
  .claude/skills/graphify/SKILL.md → .codex/skills/graphify/SKILL.md
- `Incremental Update Workflow` --semantically_similar_to--> `Incremental Update Workflow`  [INFERRED] [semantically similar]
  .claude/skills/graphify/references/update.md → .codex/skills/graphify/references/update.md
- `Graphify Add and Watch` --semantically_similar_to--> `Graphify Add and Watch`  [INFERRED] [semantically similar]
  .claude/skills/graphify/references/add-watch.md → .codex/skills/graphify/references/add-watch.md
- `Graphify Extra Exports` --semantically_similar_to--> `Graphify Extra Exports`  [INFERRED] [semantically similar]
  .claude/skills/graphify/references/exports.md → .codex/skills/graphify/references/exports.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Claude Graphify Pipeline Components** — _claude_skills_graphify_skill_graphify_skill, _claude_skills_graphify_references_extraction_spec_semantic_extraction_contract, _claude_skills_graphify_references_query_existing_graph_query_workflow, _claude_skills_graphify_references_update_incremental_update_workflow, _claude_skills_graphify_references_exports_extra_exports [EXTRACTED 1.00]
- **Codex Graphify Pipeline Components** — _codex_skills_graphify_skill_graphify_skill, _codex_skills_graphify_references_extraction_spec_semantic_extraction_contract, _codex_skills_graphify_references_query_existing_graph_query_workflow, _codex_skills_graphify_references_update_incremental_update_workflow, _codex_skills_graphify_references_exports_extra_exports [EXTRACTED 1.00]
- **Project Graphify Guidance** — _claude_claude_graphify_directive, _claude_skills_graphify_skill_graphify_skill, _codex_skills_graphify_skill_graphify_skill, agents_graphify_project_policy [INFERRED 0.85]
- **Public GNOME Integration Principle** — readme_public_gnome_integration, docs_architecture_public_api_cooperation, docs_gnome_notes_verified_public_tiling_apis, docs_gnome_notes_verified_launcher_apis [INFERRED 0.95]
- **Ground-Truth Self-Healing Pattern** — docs_architecture_ground_truth_recomputation, docs_architecture_reconciled_layout_tree, docs_architecture_debounced_relayout_pipeline, docs_launcher_search_pipeline [INFERRED 0.85]
- **Live Shell Verification Strategy** — docs_development_manual_ui_verification, docs_gnome_notes_installed_source_reverification, tests_manual_tests_live_shell_behavior_suite [INFERRED 0.85]

## Communities (54 total, 20 thin omitted)

### Community 0 - "Launcher Providers and UI"
Cohesion: 0.07
Nodes (41): MOVE_WORDS, WORKSPACE_WORDS, TERMINAL_APP_IDS, SECRET_MIME_TYPES, BACKDROP_OPACITY, BLUR_BRIGHTNESS, BLUR_RADIUS, CLOSE_DURATION_MS (+33 more)

### Community 1 - "Favorites and Fuzzy Ranking"
Cohesion: 0.05
Nodes (34): FRECENCY_HALF_LIFE_MS, MAX_HISTORY_ENTRIES, FavoritesManager, boundedEditDistance(), matchAcronym(), matchFields(), matchSubsequence(), matchText() (+26 more)

### Community 3 - "Tiling Layout Engine"
Cohesion: 0.08
Nodes (13): computeStackGeometry(), insetRect(), LayoutMode, LayoutTree, STACK_TAB_BAR_HEIGHT, StackTabBar, floatingWindows, stackedWorkspaces (+5 more)

### Community 4 - "Extension Lifecycle and Theme"
Cohesion: 0.08
Nodes (12): TesseraExtension, AccentColorTracker, YARU_ACCENT_HEX, ColorPickerOverlay, colorToHex(), pickColor(), toHexComponent(), NativeIndicatorHider (+4 more)

### Community 5 - "Focus Border and Styling"
Cohesion: 0.08
Nodes (17): FocusBorderManager, HIGHLIGHTABLE_TYPES, LauncherTheme, METRICS, PALETTE, hexToRgba(), alphabetLabel(), buildCssDeclarations() (+9 more)

### Community 6 - "Launcher Extension Manager"
Cohesion: 0.09
Nodes (4): ExtensionProvider, LauncherManager, RecentProvider, SettingsProvider

### Community 7 - "Calculator Parsing"
Cohesion: 0.14
Nodes (11): alternateForms(), CONSTANTS, evaluate(), formatValue(), FUNCTIONS, ParseError, Parser, tokenize() (+3 more)

### Community 8 - "Keybinding Management"
Cohesion: 0.16
Nodes (6): DESKTOP_WM_KEYS_TO_CLEAR, INPUT_SOURCE_KEYS, KeybindingManager, lookupOptionalSettings(), MUTTER_KEYS_TO_CLEAR, SHELL_KEYS_TO_CLEAR

### Community 10 - "Search Controller Pipeline"
Cohesion: 0.18
Nodes (3): parseQuery(), SearchController, resultKey()

### Community 11 - "Panel Auto Hide"
Cohesion: 0.19
Nodes (3): opacityDecl(), PANEL_BOX_CHROME_PARAMS, PanelAutoHideManager

### Community 12 - "Preferences UI"
Cohesion: 0.22
Nodes (13): addButtonRow(), addColorEntryRow(), addComboRow(), addPresetRow(), addScaleRow(), addShortcutRow(), addSpinRow(), addStringPresetRow() (+5 more)

### Community 19 - "Project Architecture Documentation"
Cohesion: 0.30
Nodes (12): Tessera Architecture, Isolated Module Composition, Owned Fullscreen State, Tessera Development Guide, GNOME 47 and 48 Porting Checklist, GNOME 46 Integration Notes, Installed Source Reverification, Verified Public Launcher APIs (+4 more)

### Community 20 - "Launcher Ranking Design"
Cohesion: 0.17
Nodes (12): Ground-Truth Recomputation, Adaptive Launcher Ranking, Asynchronous Provider Seam, Clipboard History Privacy, Non-Overlapping Match Tiers, Open Windows Priority, Provider Controller UI Separation, Scope Bar Filtering (+4 more)

### Community 21 - "Graphify Add Update Workflow"
Cohesion: 0.18
Nodes (11): Graphify Add and Watch, Incremental Folder Watcher, URL Ingestion, Cluster-Only Refresh, Code-Only Update Fast Path, Incremental Update Workflow, Semantic Manifest Integrity, Replace on Re-Extract (+3 more)

### Community 22 - "Tiling Algorithms and Testing"
Cohesion: 0.18
Nodes (11): Debounced Relayout Pipeline, Focus-Aware Insertion, Pure Integer Layout Geometry, Reconciled Layout Tree, Two-Tier Window Membership, Workspace-Monitor Layout Buckets, Manual UI Verification, Pure Logic Test Seam (+3 more)

### Community 24 - "Public GNOME Integration"
Cohesion: 0.20
Nodes (10): Cooperate with GNOME Public APIs, Verified Public Tiling APIs, Launcher Action Catalogue, Captured Target Window, Shell-Free Command Execution, GNOME-Owned Behavior Out of Scope, Automatic Dwindle Tiling, Native Unified Launcher (+2 more)

### Community 27 - "Semantic Extraction Contracts"
Cohesion: 0.29
Nodes (8): Extraction Confidence Taxonomy, Deterministic Node Identity, Disk Chunk Output Contract, Semantic Extraction Contract, Extraction Confidence Taxonomy, Deterministic Node Identity, Inline Agent Output Contract, Semantic Extraction Contract

### Community 28 - "Graph Query Workflows"
Cohesion: 0.25
Nodes (8): BFS and DFS Graph Traversal, Constrained Query Expansion, Existing Graph Query Workflow, Query Feedback and Work Memory, BFS and DFS Graph Traversal, Constrained Query Expansion, Existing Graph Query Workflow, Query Feedback and Work Memory

### Community 29 - "Graph Maintenance Policy"
Cohesion: 0.25
Nodes (8): Cluster-Only Refresh, Code-Only Update Fast Path, Incremental Update Workflow, Semantic Manifest Integrity, Replace on Re-Extract, Existing Graph First, Graph Maintenance After Code Changes, Graphify Project Policy

### Community 30 - "Floating and Visual Styling"
Cohesion: 0.25
Nodes (8): Explicit Inline Active Colors, Independent Focus Border, Per-Window Floating Membership Override, Persistent User Layout Choices, Screen-Lock Session Modes, Blur Disabled by Default, Literal Launcher Theme Values, Per-Window Floating

### Community 31 - "Claude Graphify Skill"
Cohesion: 0.33
Nodes (6): Graphify Directive, AST and Semantic Extraction Split, Existing Graph Fast Path, Graph Health Gate, Graphify Skill, Persistent Knowledge Graph

### Community 32 - "Graph Export Formats"
Cohesion: 0.33
Nodes (6): Graphify Extra Exports, MCP Query Server, Optional Export Formats, Graphify Extra Exports, MCP Query Server, Optional Export Formats

### Community 33 - "Repository Merge Workflows"
Cohesion: 0.33
Nodes (6): Cross-Repository Graph Merge, GitHub and Merge Workflow, Monorepo Output Isolation, Cross-Repository Graph Merge, GitHub and Merge Workflow, Monorepo Output Isolation

### Community 34 - "Graphify Integration Hooks"
Cohesion: 0.33
Nodes (6): Graphify Integration Hooks, Native CLAUDE.md Integration, Post-Commit Rebuild Hook, Graphify Integration Hooks, Native CLAUDE.md Integration, Post-Commit Rebuild Hook

### Community 35 - "Media Transcription"
Cohesion: 0.33
Nodes (6): Media Transcription Workflow, Transcript-to-Document Bridge, Whisper Domain Prompt, Media Transcription Workflow, Transcript-to-Document Bridge, Whisper Domain Prompt

### Community 36 - "Codex Graphify Skill"
Cohesion: 0.40
Nodes (5): AST and Semantic Extraction Split, Existing Graph Fast Path, Graph Health Gate, Graphify Skill, Persistent Knowledge Graph

### Community 37 - "Stacked Layout Visibility"
Cohesion: 0.40
Nodes (5): Stacked Group Posture, Tab-Bar Visibility Ownership, Workspace Chrome Layering, trackFullscreen Visibility Ownership, Stacked Tabbed Layout

### Community 38 - "Workspace Gesture Indicator"
Cohesion: 0.50
Nodes (4): Defensive Private API Reach, Absolute Swipe Progress Mapping, Native Workspace Dot Sources, Numbered Workspace Indicator

### Community 39 - "Lifecycle Cleanup Guarantees"
Cohesion: 0.50
Nodes (4): Exact Disable Restoration, Lazy Launcher Lifecycle, Reversible Extension Lifecycle, Cleanup Correctness Verification

### Community 40 - "Graph Navigation Guidance"
Cohesion: 0.67
Nodes (3): Graph-First Codebase Navigation, Graphify Integration Instructions, Incremental Graph Currency

### Community 41 - "Keybinding Conflict Lifecycle"
Cohesion: 0.67
Nodes (3): Keybinding Override Lifecycle, Independent Keybinding Conflict Owners, Persistent Keybinding Backup

### Community 42 - "GNOME Window Movement"
Cohesion: 0.67
Nodes (3): New-Window Workspace Placement, Window Movement Architecture, GNOME Window Movement Primitives

### Community 43 - "Local Development Reloading"
Cohesion: 0.67
Nodes (3): ES Module Reload Constraint, Symlink-Based Local Iteration, Safe Install from Symlink Mode

## Knowledge Gaps
- **85 isolated node(s):** `YARU_ACCENT_HEX`, `HIGHLIGHTABLE_TYPES`, `SHELL_KEYS_TO_CLEAR`, `MUTTER_KEYS_TO_CLEAR`, `DESKTOP_WM_KEYS_TO_CLEAR` (+80 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 281 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **20 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `SettingsManager` connect `Settings and Preferences` to `Extension Lifecycle and Theme`, `Launcher History Recording`?**
  _High betweenness centrality (0.119) - this node is a cross-community bridge._
- **Why does `TilingManager` connect `Tiling Layout Engine` to `Extension Lifecycle and Theme`?**
  _High betweenness centrality (0.067) - this node is a cross-community bridge._
- **Why does `SearchProvider` connect `Launcher Providers and UI` to `Favorites and Fuzzy Ranking`, `Launcher Extension Manager`, `Calculator Parsing`, `Clipboard Provider`, `Application Provider`, `Action Search Provider`, `Window Search Provider`, `Palette Provider`, `Command Provider`?**
  _High betweenness centrality (0.036) - this node is a cross-community bridge._
- **What connects `YARU_ACCENT_HEX`, `HIGHLIGHTABLE_TYPES`, `SHELL_KEYS_TO_CLEAR` to the rest of the system?**
  _85 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Launcher Providers and UI` be split into smaller, more focused modules?**
  _Cohesion score 0.06664198445020363 - nodes in this community are weakly interconnected._
- **Should `Favorites and Fuzzy Ranking` be split into smaller, more focused modules?**
  _Cohesion score 0.05257936507936508 - nodes in this community are weakly interconnected._
- **Should `Settings and Preferences` be split into smaller, more focused modules?**
  _Cohesion score 0.03125 - nodes in this community are weakly interconnected._