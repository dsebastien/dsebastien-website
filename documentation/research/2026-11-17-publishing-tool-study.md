# Publishing tool study (2026-11-17)

- Status: research. Nothing here is approved.
- Question: how does the author publish from Obsidian when Obsidian Publish is gone?
- Trigger: the author decided: "I don't want to rely on Obsidian Publish anymore, not even the panel; I prefer we build our own thing, maybe taking some inspiration from the Ghost Publish plugin for Obsidian I've built." He wants to keep publishing from Obsidian, "easily choosing what to publish, what to skip, what to unpublish". He does not publish from a phone. He also drives Obsidian with AI coding agents and a command line.
- Scope: design only. No production code. No timing and no effort estimates.
- Input: `documentation/plans/spec-v1.md` (sections 3.3, 4, 6, 7, 13) and `documentation/research/2026-11-17-current-state.md` (sections 1.9, 1.10). This study calls them "the spec" and "the research".
- Versions read: Ghost Publish 1.2.1 (commit `54cf970`), plugin template 3.0.0 (commit `4614b72`), Dataview Serializer 3.7.1 (commit `9132db6`), Obsidian typings 1.13.1, the current `TPL Publish` script (private, only its behavior is described here).
- Ids: every finding, option and question has an id (`GP3`, `B12`, `K7`). Section D (state) uses the prefix `ST`, and section F (guards) uses `GU`, because the spec already uses `D` for decisions and `F` for flags. Web sources are `W1` to `W11`, listed in section 21.
- Privacy: this file holds no note content, no vault folder name and no infrastructure detail.

## 1. Result in short

- R1. Shape: one publish core as a library, with two hosts. The Obsidian plugin embeds the core and is the place where the author works. The command line of this repository (`apps/cli`) runs the same core for the build, for tests and for a takedown without Obsidian.
- R2. Automation: the plugin registers native command line handlers (`registerCliHandler`, Obsidian 1.12.2). An agent runs `plan` (a dry run that returns a plan id), shows the plan, then runs `publish plan=<id>`. The view, the handlers and a small API object call one service.
- R3. State: the intent is the `public_note` property. The state is the manifest in the content store. The plugin writes no state into notes. A local cache per device makes the lists fast.
- R4. View: a publication center as a tab in the main area, with six lists, filters, a detail pane and a run log. A virtual list and an index that follows vault events keep it fast with 20,000 notes.
- R5. Skip: an entry that the author leaves unselected stays in its list. Nothing is stored. The history counts skipped entries, so that the need for an explicit hold becomes a number.
- R6. Guards: forced removals that cannot be unselected, confirmation limits, a gate report inside the view, a dry run, a lock, and an opt-in per device.
- R7. First version: five commands, three command line handlers, one view with five lists, one status bar item, six settings. No diff, no history list, no hold. Section 15 has the exact list.
- R8. Ghost Publish stays a separate plugin. It needs two small changes before the switch (section 16.3).

## 2. What the decision of the author changes in spec v1

- C1. Decision D37: route 1 (the bridge through the Publish panel) is out. Route 3 (publication center) moves before the switch, in a reduced form. Route 2 (queue note) is not needed.
- C2. Decision D17: the plugin is no longer "after the switch". The command line and the plugin share the first release.
- C3. Section 11.2, condition 6: the alternative "or the bridge of 6.5 keeps Publish alive" is gone.
- C4. Section 11.3, step 2: the rollback window says that Obsidian Publish "receives every publication until the window ends". Without the panel, nothing sends publications to Obsidian Publish. Decision K18 covers this.
- C5. Section 15.1, risk "The publishing tool delays the switch": its answer was the bridge. The new answer is the size of the first version (section 15 of this study) and a headless first slice (K1).
- C6. Section 15.3, kill criterion 4 ("the bridge route ships the switch") no longer has a fallback. The author must confirm that he accepts this (K18).
- C7. Stories 65 and 66 are "S" in the spec. A reduced publication center and a status indicator become part of the switch gate.
- C8. Section 6.9 says that the Ghost Publish plugin reads the Publish API list. The source does not (finding GP5). The change in that plugin is smaller than the spec states.

## 3. Findings: the Ghost Publish plugin

Repository: `obsidian-ghost-publish` (public). Paths below are relative to `src/app/`.

### 3.1 How it works

- GP1. Model: a note is a candidate, then queued, then synced. Triage actions write flags into the frontmatter (`services/triage-actions.ts`). All state per note lives in the frontmatter. The plugin has no database (`documentation/Domain Model.md`).
- GP2. It uses ten property names that the user can change (`FrontmatterPropertyNames` in `types/plugin-settings.intf.ts`) and five fixed ones (`COSMETIC_FM` in `constants.ts`).
- GP3. Discovery scans the vault at each render. `findCandidates` and `findQueuedNotesForPreset` in `services/candidate-discovery.ts` loop over `app.vault.getMarkdownFiles()` and read `metadataCache.getFileCache(file)`. The "recently published" page does the same scan.
- GP4. Triage filters: a time range on `file.stat.mtime` (`triageRangeToSince`), excluded folders, a tag for maps of content, and an optional eligibility property.
- GP5. The eligibility property is an optional `=== true` test on one frontmatter key. It decides which notes are candidates and which wikilinks become links to the public site. The source holds no call to the Obsidian Publish API. The plugin depends on the property and on the URL form, not on the Publish list.
- GP6. Change detection: SHA-256 of the note body through Web Crypto (`utils/content-hash.fn.ts`). The hash is stored in the note. An unchanged note gets no write at all (rules BR-SYNC-1 and BR-SYNC-4). Commit `53a1702` removed a timestamp write that touched every published note at each run.
- GP7. Orchestration: `publishAllForPreset` in `services/publish-service.ts` runs a sequential loop with a `try` and `catch` per note. Each note gives a `SyncResult` with a status (`created`, `updated`, `recreated`, `unchanged`, `skipped`, `failed`). A `SyncSummary` counts them. An optional `onProgress(current, total, lastResult)` callback exists.
- GP8. Error report: `utils/failure-reasons.fn.ts` groups the failure reasons and counts the notes per reason. The failure notice stays until the user closes it.
- GP9. Listing note: `services/news-feed-writer.ts` rewrites one note with a line per published note. It then sets the ignore flag again, because `vault.modify` replaces the frontmatter (rule BR-PRESET-4).
- GP10. View: `views/ghost-publish-view.ts` is an `ItemView` in the right side bar. It has a tab per preset, three sub-tabs (triage, queue, recently published) and a search box. Each item is a card. There is no virtual list. The "recently published" page shows 30 items at most.
- GP11. View rules that cost a defect before they were written: the header stays outside the area that is rendered again, so that the search box keeps the focus (BR-UI-8). The scroll position is saved and restored (BR-UI-5). A card is removed in place (BR-UI-4). The view refreshes a second time 500 ms after a sync, because `processFrontMatter` resolves before the `changed` events of the metadata cache (BR-UI-6). The sync button acts on the full queue, whatever the filter shows (BR-UI-7).
- GP12. Search: `utils/fuzzy-search.fn.ts` (uFuzzy, weighted fields, no Obsidian import) and `views/pages/note-search.ts`.
- GP13. Note links in the view: `views/pages/open-note-link.ts` follows the click rules of Obsidian (click, modifier click, middle click).
- GP14. Settings: declarative (`getSettingDefinitions()`), with one write path. `updateSettings` in `plugin.ts` queues the writes and changes the memory only after the write to disk succeeded. `loadSettings` tests each field alone.
- GP15. Credentials: `services/admin-key-secret.ts`. The key lives in `SecretStorage`. `data.json` holds the name of the secret only. A device without the secret gets a message that names the secret to set (rules BR-AUTH-3 and BR-AUTH-4).
- GP16. Network: `requestUrl` only (BR-NET-1). `services/canonical-probe.ts` requests a URL several times with growing delays.
- GP17. Commands: two (`open-panel`, `sync-all-presets`). They take no argument and return nothing. The plugin has no command line handler and no API object.
- GP18. Tests: `src/test-setup.ts` replaces the `obsidian` module by a mock. Pure helpers have specs. `plugin.spec.ts` simulates several devices that share one `data.json` and own their secrets. The services that take `App` have thin coverage (`services/sync-note.spec.ts` has 37 lines for a pipeline of 255 lines).
- GP19. URL helper: `utils/vault-path-to-url.fn.ts` writes spaces as `+` and encodes `#`. It does not percent-encode other characters. It differs from rule U1 of the spec for names with `+`, `%`, `&` or `?`.
- GP20. Link resolution: `services/wikilink-resolver.ts` finds wikilinks with a regular expression and resolves them with `getFirstLinkpathDest`. It does not skip code blocks and does not use the link positions of the metadata cache.
- GP21. `openSettingsTab()` in `plugin.ts` uses `app.setting`, which is not in the public typings.

### 3.2 What is a pattern and what is specific to Ghost

| Id   | Part                                                                                                | Pattern to reuse | Specific to Ghost |
| ---- | --------------------------------------------------------------------------------------------------- | ---------------- | ----------------- |
| GP22 | Orchestrator with a result per note, a summary and a progress callback (GP7)                        | Yes              |                   |
| GP23 | Grouped failure reasons (GP8)                                                                       | Yes              |                   |
| GP24 | Hash with Web Crypto, and no write for an unchanged note (GP6)                                      | Yes              |                   |
| GP25 | Secret in `SecretStorage`, name in `data.json`, message per device (GP15)                           | Yes              |                   |
| GP26 | One serialized write path for settings (GP14)                                                       | Yes              |                   |
| GP27 | View skeleton: fixed header, debounced search, scroll restore, empty state with "Open settings"     | Yes              |                   |
| GP28 | Fuzzy search and note link helper (GP12, GP13)                                                      | Yes              |                   |
| GP29 | Device simulation in tests (GP18)                                                                   | Yes              |                   |
| GP30 | Probe with growing delays (GP16)                                                                    | Yes              |                   |
| GP31 | State in the frontmatter of each note (GP1, GP2)                                                    |                  | Yes, see H16      |
| GP32 | Presets, tags, newsletter, the `emailedAt` rule                                                     |                  | Yes               |
| GP33 | Markdown to HTML, footnotes, image upload, embed cards (`build-html.ts`, `footnotes.ts`, `embed-*`) |                  | Yes               |
| GP34 | Triage by time range, with an ignore flag                                                           |                  | Yes               |
| GP35 | Listing note (GP9)                                                                                  |                  | Yes, see H24      |
| GP36 | Vault scan at each render and a card per item (GP3, GP10)                                           |                  | Fits small queues |

## 4. Findings: the plugin template

Repository: `obsidian-plugin-template` (public).

- TP1. Structure: `src/main.ts` (entry only), `src/app/plugin.ts` (lifecycle and settings), `src/app/settings/settings-tab.ts`, `src/app/types/plugin-settings.intf.ts`, empty folders `commands/`, `domain/`, `services/` and `settings/components/`, `src/utils/log.ts`, `src/styles.src.css` (Tailwind 4), `src/test-setup.ts`. Three documentation surfaces: `README.md`, `docs/`, `documentation/`.
- TP2. Settings are declarative (`getSettingDefinitions()`, Obsidian 1.13.0). `AGENTS.md` lists the traps. `settings-guard.spec.ts` enforces three of them. A settings change is accepted only after a look at the settings pane in a real vault.
- TP3. Tests: `bun run test` (the script adds `--isolate`), `.spec.ts` files next to the source, the `obsidian` mock loaded first by `bunfig.toml`. An agent cannot verify the user interface: "You cannot self-verify UI behavior".
- TP4. Catalog rules: the `id` must not contain "obsidian". The `name` must not contain "Obsidian" and must not be all uppercase. The `description` must not contain "Obsidian", must not start with the plugin name, and must end with `.`, `!` or `?`. A command name must not contain the plugin name. The `id` is locked when the catalog accepts the plugin.
- TP5. Review rules that shape the view code: `activeDocument`, `window.setTimeout`, `createEl`, no `console.*`, a `Modal` in place of `window.confirm`, `requestUrl` in place of `fetch`, `FuzzySuggestModal` and `AbstractInputSuggest` for pickers, a typed callback for `processFrontMatter`.
- TP6. A plugin with `isDesktopOnly: true` is exempt from the lint rules against Node modules.
- TP7. `minAppVersion` is 1.13.0. It must never be above the latest public release.
- TP8. Performance rules: light start, lazy work, batched disk access, debounced work on file events.
- TP9. A new plugin runs `bun run init`, then removes `TEMPLATE_USAGE.md` and the init script.
- TP10. The template ships the `whats-new` view and support links. A personal tool does not need them.

## 5. Findings: the Dataview Serializer

Repository: `obsidian-dataview-serializer` (public). File: `src/app/plugin.ts`.

- DS1. Signature:

    ```ts
    async processFile(
        _file: TAbstractFile,
        force = false,
        targetQuery?: string,
        isManualTrigger = false
    ): Promise<FileProcessingResult>

    interface FileProcessingResult {
        filePath: string
        errors: Array<{ message: string; query: string }>
        updated?: boolean
        skipped: SkippedQuery[]
    }
    ```

- DS2. It needs the running application, the Dataview plugin API (`getDataviewApi(this.app)`), the read cache of the vault, and `vault.process` for the write.
- DS3. Flow: ignore tests, `cachedRead`, find the queries (block, inline, and DataviewJS when enabled), serialize each one, compare with the existing block, build `updatedText`. When `updatedText === text`, it returns. If the text differs, it writes inside `vault.process` and refuses the write when the note changed in between (`saveSerializedContent`).
- DS4. It cannot report "stale" without a write. `updated` becomes `true` only after a write. The comparison `updatedText === text` exists, so a dry run is a small change: return a `wouldUpdate` flag before the write step.
- DS5. Five paths give no error and matter for a publication:
    1. It returns an empty result when the plugin is disabled on the device (`isDisabledOnDevice()`).
    2. Without `force`, it skips files in ignored folders and files inside a cooldown window after a recent update.
    3. It always honors the ignore flag in the frontmatter of a note.
    4. It catches every exception, logs it, and returns a result without an error entry.
    5. When a `FROM` source is missing, it keeps the previous output and reports the query in `skipped`.
- DS6. `isManualTrigger = true` runs "manual" queries and runs "once" queries again. `TPL Publish` passes neither `force` nor `isManualTrigger`.
- DS7. `serializeAllFiles(isManualTrigger, onProgress)` processes five files at a time and returns counts, errors and skipped queries.
- DS8. `rename-query-updater.ts` rewrites query references when a note or a folder is renamed. A rename can therefore change other notes.

## 6. Findings: the current publishing script

Only the behavior of `TPL Publish` is recorded here. It adds detail to the research, section 1.9.

- PS1. It reads the published list through the internal Publish plugin (`app.internalPlugins`) and stops when that call fails.
- PS2. It calls `processFile(file)` of the serializer for each published file, one after the other, through `app.plugins.plugins[...]`.
- PS3. It writes `public_note` in both directions, and it sets `created` (when missing) and `updated`.
- PS4. It yields to the event loop by time: after 100 ms of work, not after a count of files. A comment says why: a few heavy files can block the application between yields that are based on a count.
- PS5. A failure in one file never stops the run.
- PS6. It shows progress in one notice, updated every 500 files. It ends with phase timings, counters and the ten slowest serializations.
- PS7. It regenerates two list notes and restores their frontmatter after `vault.modify`.
- PS8. It opens the Publish panel through `app.commands.commands[...]`.
- PS9. `app.internalPlugins` and `app.commands.commands` are not in the public typings. Both calls stop working when Obsidian Publish is cancelled.

## 7. Findings: the Obsidian API

Source: `node_modules/obsidian/obsidian.d.ts`, version 1.13.1, in the plugin template.

### 7.1 Signatures that the tool relies on

```ts
// MetadataCache
getFirstLinkpathDest(linkpath: string, sourcePath: string): TFile | null;
getFileCache(file: TFile): CachedMetadata | null;
resolvedLinks: Record<string, Record<string, number>>;
unresolvedLinks: Record<string, Record<string, number>>;
on(name: 'changed', callback: (file: TFile, data: string, cache: CachedMetadata) => any, ctx?: any): EventRef;
on(name: 'deleted', callback: (file: TFile, prevCache: CachedMetadata | null) => any, ctx?: any): EventRef;
on(name: 'resolved', callback: () => any, ctx?: any): EventRef;

// CachedMetadata (fields used)
links?: LinkCache[];
embeds?: EmbedCache[];
frontmatterLinks?: FrontmatterLinkCache[];
frontmatter?: FrontMatterCache;

// FileManager
processFrontMatter(file: TFile, fn: (frontmatter: any) => void, options?: DataWriteOptions): Promise<void>;

// Vault
on(name: 'modify', callback: (file: TAbstractFile) => any, ctx?: any): EventRef;
on(name: 'delete', callback: (file: TAbstractFile) => any, ctx?: any): EventRef;
on(name: 'rename', callback: (file: TAbstractFile, oldPath: string) => any, ctx?: any): EventRef;
cachedRead(file: TFile): Promise<string>;
getMarkdownFiles(): TFile[];

// FileStats
ctime: number;
mtime: number;
size: number;

// Workspace
on(name: 'file-open', callback: (file: TFile | null) => any, ctx?: any): EventRef;
on(name: 'file-menu', callback: (menu: Menu, file: TAbstractFile, source: string, leaf?: WorkspaceLeaf) => any, ctx?: any): EventRef;
on(name: 'files-menu', callback: (menu: Menu, files: TAbstractFile[], source: string, leaf?: WorkspaceLeaf) => any, ctx?: any): EventRef;
on(name: 'editor-menu', callback: (menu: Menu, editor: Editor, info: MarkdownView | MarkdownFileInfo) => any, ctx?: any): EventRef;
onLayoutReady(callback: () => any): void;

// Plugin
addStatusBarItem(): HTMLElement;
registerView(type: string, viewCreator: ViewCreator): void;
registerCliHandler(command: string, description: string, flags: CliFlags | null, handler: CliHandler): void;
onExternalSettingsChange?(): any;

// Command line types (since 1.12.2)
export type CliHandler = (params: CliData) => string | Promise<string>;
export interface CliData { [key: string]: string | 'true'; }
export interface CliFlag { value?: string; description: string; required?: boolean; }
export type CliFlags = Record<string, CliFlag>;

// ItemView (MarkdownView extends TextFileView, EditableFileView, FileView, ItemView)
addAction(icon: IconName, title: string, callback: (evt: MouseEvent) => any): HTMLElement;

// FuzzySuggestModal<T>
abstract getItems(): T[];
abstract getItemText(item: T): string;
abstract onChooseItem(item: T, evt: MouseEvent | KeyboardEvent): void;

// Network
export function requestUrl(request: RequestUrlParam | string): RequestUrlResponsePromise;
// RequestUrlParam: url, method?, contentType?, body?: string | ArrayBuffer, headers?, throw?

// SecretStorage (since 1.11.4), reached as app.secretStorage
setSecret(id: string, secret: string): void;
getSecret(id: string): string | null;
listSecrets(): string[];

// App (since 1.8.7)
loadLocalStorage(key: string): any | null;
saveLocalStorage(key: string, data: unknown | null): void;

// FileSystemAdapter (desktop)
getBasePath(): string;
```

### 7.2 What the typings say and do not say

- API1. `resolvedLinks` maps each source path to its destination paths with a count. Paths are vault paths. It gives the targets of a note without a parse of the text.
- API2. `CachedMetadata.links`, `embeds` and `frontmatterLinks` give each link with its position and its original text. `getFirstLinkpathDest` resolves one link the way Obsidian does. The export of spec 6.4, step 2 comes from these two.
- API3. The `changed` event of the metadata cache "is not called when a file is renamed for performance reasons. You must hook the vault rename event for those." The index of the plugin must listen to both.
- API4. `registerCliHandler` asks for the form `<plugin-id>` for the default command and `<plugin-id>:<action>` for the others. A handler gets string flags and returns a string or a promise of a string. An agent can therefore pass arguments and read a result, which a palette command cannot do.
- API5. `addStatusBarItem()` is "Not available on mobile". This is not a limit here.
- API6. `SecretStorage` ids are "Lowercase alphanumeric ID with optional dashes". The store is local to the device.
- API7. `loadLocalStorage` and `saveLocalStorage` store a value for this vault on this device. They fit settings that must not synchronize, such as a path on the disk.
- API8. `onExternalSettingsChange` runs when `data.json` changes on the disk outside Obsidian. The plugin must reload its settings there.
- API9. The typings hold no API for a custom widget in the properties panel and no API for a badge in the file explorer. A search for `PropertyWidget` and `registerPropertyWidget` finds nothing.
- API10. `app.plugins` (access to another plugin) and `app.internalPlugins` are not in the typings. The tool needs `app.plugins` for two plugins of the author: the Dataview Serializer and the Obsidian Starter Kit plugin (note types, `recognizeNoteType(path)` in its `PluginApi`). This is the only untyped access that the design accepts.
- API11. Node modules (`child_process`, `fs`) are not part of the Obsidian API. They exist on desktop through Electron. Their use needs `isDesktopOnly: true` (TP6).
- API12. The typings hold no diff function. A diff needs a library (B19).

## 8. Findings: prior art

### 8.1 Obsidian Publish panel

- PA1. The dialog "Publish changes" has three lists: new (not published), changed (modified after the last publication), unchanged (published). The author selects with check boxes and presses "Publish" (W1).
- PA2. Unpublish: select a note in the unchanged list and publish. Removed or renamed notes appear as deletions that the author must select by hand, "for safety" (W1).
- PA3. Other controls: "Add linked" selects the notes and media that the selected notes link to. A filter has included folders and excluded folders. The property `publish: true` selects a note, and `publish: false` hides it from the lists (W1).
- PA4. A change log entry of 2022 describes a context menu on a note that compares the local version with the live version (W2). This study did not check the current dialog.
- PA5. Good: one place, three plain lists, removal is never automatic.
- PA6. Bad at this size: a modal dialog blocks the application. No type or tag filter exists. One report describes more than 30 seconds to open the dialog on a large site. The cause was on the server, and the vendor fixed it (W3). A user of the service cannot fix such a problem.

### 8.2 Quartz Syncer

- PA7. The publication center has four headings: "Unpublished notes", "Changed notes", "Published notes (select to unpublish)" and "Unchanged notes". A click on a file opens a diff viewer (W5). The diff has a split view and a unified view (W4).
- PA8. Selection: a check box property `publish` on the note (W5).
- PA9. Command line: `obsidian quartz-syncer:<command>` with 22 commands, among them `status`, `publish`, `sync`, `delete`, `mark` and `diff`. Flags are bare words (`dry-run`, `force`) or `key=value` (`format=json`). `status` returns counts and file lists. Destructive commands need `force`. Obsidian must run (W4, W6).
- PA10. It prepares changes in the background: "Precompiles changes on vault updates so publishing is instant" (W4).
- PA11. Tokens: `electron.safeStorage` on desktop. Git runs in JavaScript (isomorphic-git) over HTTPS (W4).
- PA12. Guard: a glob or fuzzy unpublish is blocked when it matches more than 80 percent of the published notes (W4).
- PA13. Good: the command line with a dry run and JSON output, the background preparation, the diff per note. This is the closest model for sections 9 and 10.
- PA14. Bad or unknown at this size: the documentation gives no data for a large vault. Notes deleted from the vault have no list of their own. The 80 percent guard is far too loose for 20,000 notes. The center is a modal dialog.

### 8.3 Digital Garden

- PA15. Selection: `dg-publish: true`. Linked notes are not published by themselves (W7).
- PA16. Commands: publish the active note, add the publish flag, quick publish and share, publish all marked notes, copy the URL, open the publication center, export to a local folder (W8).
- PA17. The publication center lists the files that "are published, changed, deleted and not yet published" (W8).
- PA18. Status computation (`PublishStatusManager.getPublishStatus`): it loads the file tree of the remote branch with its hashes, then compiles every marked note and compares the hash of the compiled text with the remote hash (W9).
- PA19. Good: the state comes from the store, not from properties in the notes. The lists need no extra bookkeeping.
- PA20. Bad at this size: every opening of the center compiles all marked notes. The cost grows with the size of the site. The center is a modal dialog.

### 8.4 Enveloppe

- PA21. Selection: `share: true`. Commands: upload the active note, upload all notes, upload unpublished notes, refresh published notes and upload new ones, refresh all published notes, purge unpublished and deleted files, test the connection, check the rate limit (W10).
- PA22. It pushes to a branch and opens a pull request that merges by itself. The documentation warns about merge conflicts when the author pushes too often (W10).
- PA23. Good: each intent is one command. The pull request is a review step. The purge is a separate, explicit act.
- PA24. Bad at this size: no selection list and no diff inside Obsidian. A check of the rate limit of the API is a command, which shows that the limit is a real concern.

### 8.5 What prior art teaches

- PA25. Every tool uses a property as the intent and a list of differences as the review. The design of the spec matches the field.
- PA26. No tool has a privacy gate, forced removals or a guard that fits a large site. These parts are new work.
- PA27. Two tools compute the state when the dialog opens. Only one prepares it in the background. At 20,000 notes, the background index is required.
- PA28. One tool already uses the native command line of Obsidian with `dry-run`, `force` and `format=json`. The same flag names lower the learning cost for agents.

## 9. A: shape of the tool

### 9.1 Options

- A1. Option 1: one plugin that holds all the logic. Simple to install. The build and the tests of this repository cannot use the logic, and the gate "again at each build" needs a second implementation.
- A2. Option 2: a thin plugin over the command line. The plugin exports data and starts `apps/cli` as a process. One code path. It needs a runtime and a checkout of this repository on each publishing machine, a path setting, and a progress protocol between two processes. Two versions must match.
- A3. Option 3: one core library, two hosts. The plugin imports the core and calls it in its own process. `apps/cli` imports the same core.

### 9.2 Recommendation

- A4. Option 3. The reason is the interactive work. The status of the open note, the lists and the diff need the hash, the cleaning and the gate for one note at once. A process start per question is too heavy, and a full export per refresh is wasteful.
- A5. The core has no import from `obsidian` and no import from Node at the top level. It gets its outside world through small interfaces: read a note snapshot, read and write the content store, upload an attachment, hash, clock.
- A6. The input of the core is a note snapshot: path, text, frontmatter, file stats, resolved links and embeds, note type. The plugin builds snapshots from the vault. `apps/cli` reads the same snapshots from a file export. One set of tests with the fixture vault covers both hosts. This matches spec 5.2 ("works on an export from Obsidian").
- A7. The plugin does not start `apps/cli` in the first version. The author uses `apps/cli` for a takedown from a terminal and for the checks of the build.
- A8. The plugin is desktop only. It uses `fs` and the system `git` program through `child_process` for the content store. The author does not publish from a phone.

### 9.3 What runs where

| Id  | Step                                                                           | Inside Obsidian | Core (also in `apps/cli`) |
| --- | ------------------------------------------------------------------------------ | --------------- | ------------------------- |
| A9  | Freeze queries (Dataview API and the serializer, DS2)                          | Yes             |                           |
| A10 | Resolve links and embeds (`resolvedLinks`, `getFirstLinkpathDest`, API1, API2) | Yes             |                           |
| A11 | Note type of each note (Starter Kit plugin API, API10)                         | Yes             |                           |
| A12 | Rename events (`vault.on('rename')`)                                           | Yes             |                           |
| A13 | Read the intent (frontmatter cache), write the intent (`processFrontMatter`)   | Yes             |                           |
| A14 | View, status bar, menus, notices                                               | Yes             |                           |
| A15 | Credentials (`SecretStorage`)                                                  | Yes             |                           |
| A16 | Privacy gate on snapshots                                                      |                 | Yes                       |
| A17 | Cleaning into one artifact, and the hashes                                     |                 | Yes                       |
| A18 | Publication queue: intent compared with the manifest                           |                 | Yes                       |
| A19 | Write of notes and manifest, one commit                                        |                 | Yes                       |
| A20 | Attachment upload (the HTTP function is injected: `requestUrl` in the plugin)  |                 | Yes                       |
| A21 | Takedown                                                                       |                 | Yes                       |
| A22 | URL function of rule U1 (the same function that the site uses)                 |                 | Yes                       |
| A23 | Gate at build, build, deployment                                               |                 | Outside Obsidian          |

### 9.4 How an agent or a command line starts a publication

- A24. Three entry points call one service inside the plugin (`PublicationService`): the view, the command line handlers, and an API object on the plugin instance. No logic lives in a view or in a handler.
- A25. Command line handlers, registered with `registerCliHandler` (API4). The names follow the form `<plugin-id>:<action>`:

    ```text
    obsidian <id>:status [path=<vault path>] [format=json]
    obsidian <id>:plan [paths=<path,path>] [format=json]
    obsidian <id>:publish plan=<plan id> [format=json]
    ```

- A26. `status` without a path returns the counts of each list and the state of the store, the gate and the lock. With a path, it returns the state of one note (states C1 to C9).
- A27. `plan` is the dry run. It runs the freeze test, the gate and the queue, selects entries, and writes nothing. It returns the lists, the forced removals, the guard results and a plan id. The plan id is a hash of the store revision and of the selected entries with their hashes.
- A28. `publish` applies exactly one plan. It computes the plan again. If the vault or the store changed, the id differs and the command stops with "plan is stale". An agent cannot publish something that the plan did not show.
- A29. A plan that passes a confirmation limit (GU4 to GU6) cannot be applied from the command line. Only the author can confirm it, in the view. This implements decision D12 ("never a scheduled job alone") with a technical rule.
- A30. Palette commands remain for the hand: an agent can run them with `obsidian command id=<id>:<command>`, but they take no argument and return nothing.
- A31. The API object (`app.plugins.plugins['<id>'].api`) exposes `status`, `plan` and `publish` for the eval interface. It is the same service. It exists because the author already calls the serializer this way (PS2).
- A32. The handlers return text. With `format=json`, the text is JSON with a stable shape that has a schema in the core.
- A33. Unknown: whether the `obsidian` program waits for a handler that runs for a long time. If it does not, `publish` returns a run id at once, and `status run=<id>` returns the progress. Decision K15 asks for a test.

## 10. B: the publication center

### 10.1 Place and layout

- B1. The center is an `ItemView` that opens as a tab in the main area, not in a side bar and not as a modal. The lists need width, a detail pane needs room, and the author must be able to open a note next to it. Every prior tool uses a modal (PA6, PA14, PA20).
- B2. Main layout:

    ```text
    +-----------------------------------------------------------------------------------------------+
    | Publication center     Store: up to date   Gate: 2 blocked of 20,735   Lock: free  [Refresh] |
    | Live release: 2026-11-16 18:02      Deployment pending: 0 notes                               |
    +-----------------------------------------------------------------------------------------------+
    | [New 12] [Changed 37] [To remove 3] [Blocked 2] [Warnings 58] [Unchanged 20,683]   [History]  |
    +-----------------------------------------------------------------------------------------------+
    | Text [ atom________ ]  Folder [ any v ]  Type [ any v ]  Tag [ any v ]  [Clear]               |
    | Shown 4 of 37    Selected 35 of 37 (32 not shown)    [Select shown] [Unselect shown]  Sort [v] |
    +--------------------------------------------------------+--------------------------------------+
    | [x] Atomic notes                  permanent   +14  -2  | Atomic notes                         |
    |     Knowledge/Permanent notes         changed 2 d ago  | State: live, changes not live        |
    | [x] Atomic habits                 book         +3  -0  | Live URL            [Open] [Copy]    |
    | [ ] Atomicity                     permanent    +1  -1  | First published 2023-04-11           |
    | [x] Atomic design                 article      +9  -4  | [Publish now] [Unpublish] [Take down]|
    |                                                        +--------------------------------------+
    |                                                        | Diff: live version -> this version   |
    |                                                        |   @@ -12,3 +12,5 @@                  |
    |                                                        |     A line that did not change       |
    |                                                        |   - A line that goes away            |
    |                                                        |   + A line that is new               |
    |                                                        | Properties: + description  - rating  |
    +--------------------------------------------------------+--------------------------------------+
    | Forced removals: 1 (cannot be skipped)        Technical updates: 0                            |
    | [Dry run]                 [Publish: 12 new, 35 changed, 1 removal, 1 forced removal]          |
    +-----------------------------------------------------------------------------------------------+
    | Run log: idle. Last run 2026-11-16 18:00: 51 notes, 1 failed.                          [Show] |
    +-----------------------------------------------------------------------------------------------+
    ```

- B3. In a narrow tab, the detail pane moves under the list. The layout uses a container query, so the view also works in a side bar.

### 10.2 Lists and counts

- B4. New: the note has the intent, passes the gate, and is not in the manifest.
- B5. Changed: the note is live, and the author changed what is public (rule ST17).
- B6. To remove, with three groups that differ in their default:

    ```text
    | To remove 3                                                                              |
    | Forced: on the deny list. Part of every publication.                                     |
    | [#] Example note A      moved to a deny-listed folder                  live since 2024   |
    | Intent removed. Selected.                                                                |
    | [x] Example note B      property removed                                                 |
    | Missing from this vault. Not selected.                                                   |
    | [ ] Example note C      file not found: renamed, deleted, or not synchronized   [Pair]   |
    ```

- B7. Blocked: the gate refuses the note. The list is the gate report (GU8 to GU12). A blocked entry has no check box.
- B8. Warnings: notes that can go live with a remark (dropped property, no description, no alternative text, large image, live query block without a frozen form).
- B9. Unchanged: live and equal. This list is the largest. The author unpublishes from here.
- B10. History: past publications (B27).
- B11. Each tab shows its count. The line under the filters shows three numbers: shown, selected, and selected but hidden by the filter. The publish button states exactly what it will do. This is the opposite of rule BR-UI-7 of Ghost Publish (GP11), where the button ignores the filter without saying so.
- B12. A header line shows the state of the store (up to date, behind, not found), of the gate (clean, n blocked, stale, running), of the lock, and of the last deployment.

### 10.3 Filters and selection

- B13. Text filter: fuzzy match on title and path, with the search module of Ghost Publish (GP12). It is debounced, and it renders the list area only.
- B14. Folder filter: a folder picker (`AbstractInputSuggest`) with a prefix match. Type filter: the note types of the Starter Kit registry. Tag filter: the tags of the public notes. Filters combine with "and".
- B15. Bulk selection: "Select shown", "Unselect shown", a range with shift and click, and a check box per group when the list is grouped by folder or by type.
- B16. Default selection (decision K4): new and changed entries are selected. "Intent removed" entries are selected. "Missing from this vault" entries are not selected. Forced removals are locked.
- B17. Sort: path, title, type, date of change, size of the change.

### 10.4 Diff

- B18. The diff compares two cleaned artifacts: the live one, read from the local copy of the content store, and the one that the core computes now. The author sees what the readers will see, with dropped properties and placeholders. A diff of the raw note shows private text that never leaves the vault.
- B19. Library: `diff` (jsdiff), with `structuredPatch` for the hunks and `diffWordsWithSpace` for the words inside a changed line. The Time Machine plugin of the author already has this: `obsidian-time-machine/src/app/services/diff.service.ts`, `ui/components/diff-viewer.ts` and `types/diff.intf.ts`. The renderer writes plain elements with classes. It needs no editor instance.
- B20. Rejected: the merge view of CodeMirror. It needs an editor per diff and a bundle that shares the editor packages of Obsidian. It is heavier than the need.
- B21. The diff is computed only for the entry that the author opens. A long diff shows the first hunks and a "Show all" control.
- B22. Property changes show as one line under the text diff: added, removed and changed allowed properties.

### 10.5 Actions per note

- B23. In the detail pane and in the context menu of a row:
    1. Publish now: a publication with this note only. Forced removals join it.
    2. Skip: clear the check box. Nothing is written (section 13).
    3. Unpublish: remove the intent property with `processFrontMatter`. The entry moves to "To remove".
    4. Take down: the fast removal of spec 6.8, after a typed confirmation.
    5. Open live URL, copy live URL. The URL comes from the URL function of the core (A22).
    6. Open the note, with the click rules of Obsidian (GP13).
    7. Show gate findings for this note.
    8. Pair with a missing note: "this note is the new name of that one" (ST24).

### 10.6 Run log and history

- B24. A publication shows its steps with progress. A failure of one note before the commit excludes that note and reports it. A failure of the commit or of the push stops the run, and nothing is live.

    ```text
    | Run 2026-11-16 18:00                                                     |
    | 1 Freeze queries          340 of 340      2 notes updated                |
    | 2 Privacy gate         20,735 of 20,735   clean                          |
    | 3 Clean notes              52 of 52       1 failed                       |
    | 4 Attachments               3 uploaded                                   |
    | 5 Content store        commit a1b2c3d     pushed                         |
    | 6 Build and deployment  live                                             |
    | Failed: 1   "attachment outside the public folder" (1 note)   [Show]     |
    ```

- B25. Failures are grouped by reason with a count (GP8). Each line opens the note.
- B26. The end report has the live URLs of the published notes and stays until the author closes it (story 56).
- B27. History comes from the log of the content store. Each publication is one commit whose message holds the counts, the device and the number of skipped entries. The plugin stores no second history.

    ```text
    | History                                                                           |
    | 2026-11-16 18:00   12 new   35 changed   3 removed   2 skipped   live    [Open]   |
    | 2026-11-15 09:12    0 new    4 changed   0 removed   0 skipped   live    [Open]   |
    ```

### 10.7 How it stays fast with 20,000 notes

- B28. An index in memory: one record per public or live note (path, id, state, hashes, type, tags, gate result). The view filters and sorts arrays in memory. It never scans the vault at a render, which Ghost Publish does (GP3).
- B29. The index follows events: `changed` and `deleted` of the metadata cache, `rename` and `delete` of the vault (API3). Events are collected and applied in one batch after a short delay, because the serializer and a rename can touch many notes at once (DS8).
- B30. A virtual list: rows have a fixed height, and only the visible rows plus a margin exist in the document. The unchanged list has about 20,000 entries. A card per entry (GP10) does not scale to this.
- B31. Incremental hashes: the cache holds, per note, the modification time, the size, the hashes and the gate result. A note is read and hashed again only when its time or size differs, or when the version of the cleaner or of the gate configuration changes.
- B32. The modification time is a hint, never a proof. A publication always computes the artifact of each selected note again from the text. A command "Verify all" ignores the cache.
- B33. Background work yields to the interface: a queue that works for a short time slice, then yields, as `TPL Publish` does (PS4). Visible rows come first. The status bar shows the progress. The header shows "stale" until the queue is empty.
- B34. The cache lives in IndexedDB on the device, not in `data.json`. It is large, it changes often, and it must not synchronize between machines.
- B35. The manifest index: the plugin reads the manifest files of the local store copy one time. After a fetch, it reads only the files that changed between the two revisions (`git diff --name-only`).
- B36. The freeze step does not run when the view opens. The cache knows which public notes hold a query. Only those notes go to the serializer, and only at a dry run or a publication.
- B37. The diff, the gate detail and the link list of a note are computed when the author opens the entry.
- B38. A worker thread is not part of the first version. It becomes useful only if a measure on the real vault shows that the time slices are not enough (K1).

## 11. C: status per note

### 11.1 States

| Id  | State           | Meaning                                                    | Text in the status bar  | Icon and color  |
| --- | --------------- | ---------------------------------------------------------- | ----------------------- | --------------- |
| C1  | Not public      | No intent, not in the manifest                             | (no item)               | none            |
| C2  | New             | Intent set, gate passed, not in the manifest               | `Public: not live`      | circle, muted   |
| C3  | Live            | In the manifest, deployed, hashes equal                    | `Live`                  | globe, green    |
| C4  | Changed         | Live, and the public content differs                       | `Live: changes pending` | pencil, yellow  |
| C5  | Deploying       | Committed to the store, not in the live release yet        | `Deployment pending`    | clock, muted    |
| C6  | Blocked         | The gate refuses the note. The live version, if any, stays | `Blocked: <check>`      | shield, red     |
| C7  | Removal pending | Live, and the intent is gone                               | `Removal pending`       | minus, yellow   |
| C8  | Removal forced  | Live, and now on the deny list                             | `Removal forced`        | minus, red      |
| C9  | Unknown         | No store on this device, or the index is not ready         | `State unknown`         | question, muted |

- C10. Color never carries a state alone. Each state has an icon and a text.
- C11. An optional tenth state "On hold" exists only if decision K5 adds the hold.

### 11.2 Surfaces

- C12. Status bar item (first version): `addStatusBarItem()`. It updates on `file-open` and on index changes for the open note. A click opens a menu with the actions of B23. It is the cheapest surface, and the API supports it.
- C13. Command "Show publication status" (first version): a `Modal` with the state, the live URL, the dates, the former paths, the gate findings, and the links whose target is not live. The `status path=` handler returns the same data.
- C14. File menu and editor menu (later): `file-menu`, `files-menu` and `editor-menu` add "Publish this note", "Unpublish", "Copy live URL". `files-menu` allows a bulk mark from the file explorer.
- C15. Header icon on the note (later): `addAction` on the Markdown view shows the state as an icon next to the title. The API supports it, because `MarkdownView` extends `ItemView`.
- C16. Properties widget: rejected. No public API exists (API9). The `public_note` check box in the properties panel already is the control for the intent.
- C17. File explorer badge: rejected for now. No public API exists (API9). A badge needs the internal document structure of the explorer, which changes between releases. If the author wants it later, it is optional and off by default.

    ```text
    Status bar, right side:        ... | 412 words | (globe) Live |
    After an edit:                 ... | 415 words | (pencil) Live: changes pending |
    In a deny-listed folder:       ... | 415 words | (minus) Removal forced |
    ```

## 12. D: state

### 12.1 Where each piece lives

| Id   | Piece                                                              | Place                                                    | Synchronizes                    |
| ---- | ------------------------------------------------------------------ | -------------------------------------------------------- | ------------------------------- |
| ST1  | Intent                                                             | `public_note` in the frontmatter of the note             | With the vault                  |
| ST2  | State per note: id, path, former paths, hashes, dates, attachments | Manifest in the content store, one file per note         | With the store (git)            |
| ST3  | What is live                                                       | One deployment record, written by the deployment (ST8)   | With the store, and on the site |
| ST4  | Gate configuration: deny list, allow lists, limits                 | One file in the content store (ST10)                     | With the store (git)            |
| ST5  | Rename journal                                                     | One file per device in the plugin folder (ST20)          | With the vault                  |
| ST6  | Local cache: hashes, gate results, manifest index                  | IndexedDB (B34)                                          | Never                           |
| ST6a | Device settings: path of the store copy, path of `git`, opt-in     | `saveLocalStorage` (API7)                                | Never                           |
| ST6b | Credentials for the attachment store                               | `SecretStorage`, with the secret name in `data.json`     | Never                           |
| ST6c | Credentials for git                                                | The git configuration of the system. The plugin has none | Never                           |
| ST7  | Plugin settings: property name, site URL                           | `data.json`                                              | With the vault                  |

- ST8. Deployment record: the spec gives each manifest entry a `committed` and a `deployed` state. A deployment that rewrites thousands of manifest files is slow and noisy. Proposal: the deployment writes one record (release id, store revision, date). The site also serves this record as a small public file under the reserved prefix. A note is live when the deployed revision contains its last commit. The plugin reads the public file with one `requestUrl` call and needs no credential for it. Decision K12.
- ST9. The plugin writes nothing into a note, except the intent when the author asks for it (B23, item 3). Ghost Publish writes eight properties per note (GP2). With 20,000 notes, state in the notes means noise in the vault history, synchronization load, and conflicts between machines. Spec 6.6, item 5 already says so for the note id.
- ST10. Gate configuration in the content store, not in `data.json`: the build runs the gate again and must read the same lists. The store is private, so it can hold private folder names. Its history shows each change. A synchronized `data.json` is easy to change by accident, by a tool or by an agent. The plugin shows a notice in the confirmation step when the gate configuration changed after the last publication. Decision K7.

### 12.2 Change detection

- ST11. The core computes two hashes per note. The input hash covers what can become public: the body and the allowed properties, before any transformation. The artifact hash covers the cleaned artifact.
- ST12. Hashes use SHA-256 from Web Crypto, which exists in Obsidian and in Bun (GP6).
- ST13. The manifest stores both hashes and the version of the cleaner.
- ST14. Unchanged: both hashes equal the manifest.
- ST15. Invisible edit: the input hash differs and the artifact hash is equal (a comment, a button block, a private property that is not allowed). The note stays in "Unchanged". The next publication updates the input hash without a new date.
- ST16. Technical update: the input hash is equal and the artifact hash differs. The cause is a new cleaner version or a change in the state of a link target. These notes form one line "Technical updates: n notes" with one check box. They do not change the "updated" date of a note (spec 6.7, item 2).
- ST17. Changed: both hashes differ. Only these notes appear in the "Changed" list.
- ST18. Without rule ST16, each change of the cleaner puts thousands of notes into "Changed" and hides the real edits. The cleaner will change often while the site is young.
- ST19. The cost is low: the modification time and the size select the notes to read again (B31). A property that other tools update, such as `updated`, changes the time of the file but not the input hash when it is not an allowed property. Such a note is read again, hashed, and stays unchanged.

### 12.3 Renames

- ST20. The plugin listens to `vault.on('rename', (file, oldPath) => ...)`. When the old path or the new path belongs to a public or live note, it appends a line to the rename journal: old path, new path, time, device.
- ST21. The journal is one append-only file per device in the plugin folder. It synchronizes with the vault. One file per device avoids synchronization conflicts.
- ST22. The journal must travel with the vault. If machine A renames a note and machine B publishes, B never sees a rename event: the synchronization shows a deleted file and a new file. B needs the journal of A.
- ST23. At a publication, the core applies the journal: the manifest entry keeps its id, gets the new path, and appends the old path to its former paths (rule U5). A chain of renames folds into one. A rename back to the first name leaves no former path.
- ST24. Fallback without an event. A rename with a script, with git, or while Obsidian is closed produces no event. The agents of the author move files this way. Rule: a "missing" entry and a "new" entry with the same artifact hash are paired as one rename, and the pair is shown. For other cases, the author pairs two entries by hand ("Pair" in B6, with a `FuzzySuggestModal`). Similarity search (decision D13 of the spec) comes later.
- ST25. A rename changes links in other notes. With links stored as note ids in the artifact (spec 6.4, step 6), such a note has a new input hash and an equal artifact hash. It is an invisible edit (ST15) and needs no publication. This removes most of the need for decision D55. A prototype of the cleaner must confirm it.
- ST26. To test in a real vault: does a folder rename fire one `rename` event per file inside the folder? The typings do not say (K15).

### 12.4 A second machine, or a vault that is not fully synchronized

- ST27. The state is in the store, so each machine sees the same manifest. Before any queue, the plugin fetches the store. If the local copy has changes of its own, or cannot move forward to the remote revision, the plugin stops and says why.
- ST28. A file that is missing in the vault is never selected for removal by default (B6, B16). A vault that is half synchronized therefore removes nothing by itself.
- ST29. A removal count above the limit needs a typed confirmation (GU4).
- ST30. An older file: the manifest stores the value of the `updated` property of the note at publication. If the note in the vault has an older value, the entry gets the mark "older than the live version" and is not selected. The modification time is not usable for this, because git and some synchronization tools reset it.
- ST31. Publication is an opt-in per device (GU18). A new machine can read the state and cannot publish until the author enables it there.
- ST32. The cache is per device (ST6), and the journals are per device (ST21). Nothing in the plugin folder can conflict, except `data.json`, which holds two values (ST7). The plugin reloads it in `onExternalSettingsChange` (API8).
- ST33. Credentials are per device. A device without them gets a message that names what to set (GP15).
- ST34. Two machines that publish at the same moment: the second push is refused by git, and the second run stops with nothing live (GU15).

## 13. E: the "skip" semantic

- E1. Base model: a skip is the absence of a selection. The entry stays in "New" or "Changed". The live version stays. The plugin stores nothing. The selection lives in the view until the view closes.
- E2. The base model costs one click per held note and per publication. A headless `plan` without paths selects every new and changed entry, so an agent must pass paths to leave one out.
- E3. Option A, hold as a property (for example `public_note_hold: true`): the hold is visible in the note, travels with the vault, and is readable by agents, Bases and the command line. Cost: one more property in the frontmatter and in the note type definitions. It is never an allowed property, so it changes no hash.
- E4. Option B, hold as a list in the plugin: no property. Cost: the hold is invisible outside the plugin, it must follow renames, it synchronizes through plugin data, and an agent needs the command line to see it.
- E5. Option C, sticky selection: the cache remembers a cleared check box for the current artifact hash. The entry stays unselected until the note changes again. Cost: it is local to one device, and it is a hidden state that changes what a headless run does.
- E6. Rule for any hold: it never stops a forced removal, and it never stops an unpublish. It only keeps a new version back.
- E7. Recommendation: the base model (E1) in the first version, and nothing else. Each publication records the number of entries that the author left unselected (B27). When the history holds enough publications, it answers the question that the author cannot answer today. If the same notes are skipped again and again, add option A. Option A is the only one that agents and both machines can see.

## 14. F: guards

### 14.1 Forced removals

- GU1. A live note that is now in a deny-listed folder, or has a deny-listed type, is removed by the next publication of any kind: from the view, a single note, or the command line. Its row has a lock in place of a check box.
- GU2. If the author cancels the publication, the removal stays pending. The status bar and the header of the view show a red count. A button "Remove now" runs a publication with the forced removals only.
- GU3. If a forced removal fails, the whole publication stops. Nothing else goes live before the removal works.

### 14.2 Confirmation limits

- GU4. Removals: more than 25 notes, or more than 1 percent of the live notes, in one publication. The author types the count to confirm.
- GU5. New and changed: more than 500 notes in one publication. The dialog offers the "bulk import" mark of spec 6.7, item 4.
- GU6. Intent flips: more than 100 notes whose property changed after the last publication. This catches a bulk edit by a tool.
- GU7. The numbers are first values. They live in the gate configuration (ST4). The dialog always states the count, the share, the limit, the number of missing files, and the last publication from this device:

    ```text
    +----------------------------------------------------------------+
    | Confirm a large publication                                    |
    | This publication removes 412 notes (2.0 % of the live site).   |
    | The limit is 25 notes or 1 %.                                  |
    | 398 of them are missing from this vault.                       |
    | This device published last on 2026-09-01.                      |
    | Type REMOVE 412 to continue: [______________]                  |
    |                                        [Cancel]   [Publish]    |
    +----------------------------------------------------------------+
    ```

### 14.3 The gate report in the view

- GU8. The gate runs on all public notes before a publication can start (spec 6.4, step 3). The publish button is disabled while the gate is stale or running.
- GU9. The gate result of a note is cached with its inputs: the input hash, the type, the state of each link target, and the version of the gate configuration. A full pass after a small edit therefore reads few notes. A change of the gate configuration clears the cache.
- GU10. The "Blocked" list groups the findings by check, in the order of the table of spec section 7:

    ```text
    | Blocked 2                                        Gate: all public notes, rules version 7 |
    | Secret-like text (1)                                                                     |
    |   Example note A     line 42: token pattern, value hidden      [Open] [Allow on note]    |
    | Frozen query with a private row (1)                                                      |
    |   Example map        row 7 comes from a deny-listed note       [Open]                    |
    ```

- GU11. The report never shows a secret value or the title of a private note. It shows the check, the place and the kind.
- GU12. "Dropped and reported" findings (a property that is not on the allow list) go to "Warnings", grouped by property name with a count. This is how the author sees a new property that needs a decision.

### 14.4 Dry run

- GU13. `plan` and the "Dry run" button compute everything and write nothing: no note, no store, no upload.
- GU14. The freeze step is the one part that cannot run dry today (DS4). Until the serializer has a dry mode, a dry run reports "n notes with queries, not tested". Decision K13 asks for the change in the serializer.

### 14.5 Lock

- GU15. Between machines: the publication is one commit on top of the fetched revision, pushed without force. If another machine pushed first, git refuses the push, and the run stops clean. Attachments that were uploaded before are addressed by hash and do no harm. Git gives this for free, and no separate lock service is needed.
- GU16. On one machine: a mutex in the plugin (one run at a time, for the view, the handlers and the API), and a lock file in the local store copy with the process id and the start time. The lock file also stops `apps/cli` and the plugin from running together.
- GU17. A lock that is older than its process can be removed with a confirmed "Break lock" action.

### 14.6 Other guards

- GU18. Device opt-in: "Allow publication from this device" is off by default and is stored on the device (ST6a). The serializer has a similar switch per device.
- GU19. Preconditions that the plugin tests before a run: the link index of Obsidian is complete (the `resolved` event), Dataview and the serializer are loaded and enabled on this device (DS5, item 1), the store copy is clean and on the expected branch, and the remote address of the store copy matches the configured one.
- GU20. The plugin calls the serializer with `force = true`, so that the cooldown and the ignored folders cannot skip a public note in silence (DS5, item 2). A public note that the serializer skips or cannot process is reported, and its live query blocks are dropped with a warning, as the gate table states.
- GU21. After the freeze step, the plugin waits for the metadata events of the written files before it computes the queue. Ghost Publish uses a fixed delay of 500 ms for the same problem (GP11). An event is exact, and a delay is a guess.
- GU22. Nothing publishes on a vault event, on a timer or at start. A publication always starts from an explicit act (spec 6.1, item 4).
- GU23. The first publication is special: the manifest is empty, and every public note is "new". The limits GU4 to GU6 do not apply to an empty manifest. One confirmation shows the total and the gate report. The dates come from `created` (spec 6.7, item 1).
- GU24. The old reconciliation in `TPL Publish` must be off before the first run. If both run, the script removes each new mark (spec 6.2, item 2). The plugin cannot detect the script. The switch plan must hold this step.

## 15. G: smallest first version

The switch of the domain waits for this list. The core (gate, cleaning, queue, store write) is in `packages/publish-core` and is a precondition, not part of the list.

### 15.1 Commands (palette)

- V1. Open publication center.
- V2. Check for changes: fetch the store, update the index, run the gate.
- V3. Publish current note.
- V4. Show publication status (current note).
- V5. Copy live URL (current note).

### 15.2 Command line handlers

- V6. `<id>:status`, with `path=` and `format=json`.
- V7. `<id>:plan`, with `paths=` and `format=json`. This is the dry run.
- V8. `<id>:publish plan=<id>`, with `format=json`.

### 15.3 Views and interface parts

- V9. One view, the publication center (B1), with five lists: New, Changed, To remove (three groups, B6), Blocked (gate report, GU10), Unchanged.
- V10. Counts on each tab, and the line "shown, selected, selected but not shown" (B11).
- V11. Two filters: text and folder.
- V12. Selection: a check box per row, "Select shown", "Unselect shown", and the defaults of B16.
- V13. One line "Technical updates: n notes" with one check box (ST16).
- V14. Buttons: "Dry run", "Publish", "Refresh". The publish button states what it does.
- V15. Row actions: open the note, open the live URL, copy the live URL, unpublish, pair with a missing note.
- V16. The run log of the current run, and the end report with live URLs, grouped failures and warning counts (B24 to B26).
- V17. One confirmation dialog for the limits (GU7) and for the first publication (GU23).
- V18. One status bar item with the states C1 to C9, and one status dialog (C13).
- V19. A virtual list and the index with events (B28 to B31). These are part of the first version, because the unchanged list has 20,000 rows on the first day.

### 15.4 Settings

- V20. Name of the intent property (default `public_note`).
- V21. Base URL of the site.
- V22. Path of the local copy of the content store (this device).
- V23. Path of the `git` program (this device, optional).
- V24. Allow publication from this device (this device, off by default).
- V25. Name of the secret for the attachment store, with a `SecretComponent` row.

### 15.5 Behavior that the first version must have

- V26. Freeze step for public notes with queries, with `force = true` and a report of skipped and failed notes (GU20).
- V27. Rename journal and the exact-hash pairing (ST20 to ST24).
- V28. Forced removals (GU1 to GU3), limits (GU4 to GU7), lock (GU15, GU16), device opt-in (GU18), preconditions (GU19).
- V29. First publication as one confirmed import (GU23).
- V30. Deployment state from the public deployment record (ST8), with a probe that repeats with growing delays (GP16).
- V31. The gate configuration is read from the content store. The first version has no editor for it. The author changes the file, and the confirmation step shows that it changed (ST10).

### 15.6 Left for later

- L1. Diff per note (B18 to B22). It is the first item after the switch. The code exists in Time Machine.
- L2. History list in the view (B27). The git log holds the data from the first day.
- L3. Warnings list (B8). The end report shows the counts until then.
- L4. Type and tag filters, grouping, sorting (B14, B15, B17).
- L5. Explicit hold (E3), only if the history shows the need.
- L6. Take down from the plugin (B23, item 4). `apps/cli takedown` covers story 57 at the switch.
- L7. File menu, editor menu and bulk mark from the file explorer (C14).
- L8. Header icon on the note (C15).
- L9. Editor for the gate configuration in the settings.
- L10. Rename suggestions by similarity (ST24).
- L11. A dry mode for the freeze step (GU14), after the change in the serializer.
- L12. "Select linked": select the public notes that the selected notes link to and that are not live. This is the "Add linked" of Obsidian Publish (PA3).
- L13. Bulk import mark (GU5) and the "significant update" mark of spec 6.7.
- L14. Preview of the cleaned note, and the local site preview of story 55.
- L15. Revert of one publication from the history.
- L16. A worker thread for hashing and cleaning (B38).
- L17. The blog section (I10).
- L18. Ideas of the backlog that build on the center: readiness score (94), unlinked mentions (95), review panel (99).
- L19. Publication from a phone, scheduling (stories 71 and 72).

## 16. H: reuse from the Ghost Publish plugin

Paths are relative to `obsidian-ghost-publish/src/app/`.

### 16.1 Take as it is, or with small changes

- H1. `utils/fuzzy-search.fn.ts` and `views/pages/note-search.ts`, with their specs: the text filter (B13).
- H2. `views/pages/open-note-link.ts`, with its spec: note links in rows.
- H3. `settings/confirm-modal.ts`: the base of the confirmation dialog. Add the typed confirmation of GU7.
- H4. `utils/content-hash.fn.ts`: SHA-256 with Web Crypto. It moves into the core.
- H5. `utils/failure-reasons.fn.ts`, with its spec: grouped failures in the end report.
- H6. `services/admin-key-secret.ts`: `readSecret`, the `SecretStore` type for tests, and the message for a missing secret (`missingAdminKeyLabel` in `services/publish-service.ts`). Leave out the migration of the old plain-text key.
- H7. `plugin.ts`: `updateSettings` with its write queue. The template has the same code.
- H8. `views/ghost-publish-view.ts`: the skeleton. Header outside the rendered area, `scheduleSearchRender` with `SEARCH_RENDER_DEBOUNCE_MS`, `snapshotScroll` and `restoreScroll`, the tab row.
- H9. `views/pages/empty-state-page.ts`: the empty state with an "Open settings" button, for a device without a store copy.
- H10. `services/publish-service.ts` and `types/sync-result.intf.ts`: the shape of the orchestrator. A result per note, a status union, a summary, a progress callback, a `try` and `catch` per note.
- H11. `services/canonical-probe.ts`: the probe with growing delays, for the wait on the deployment (V30).
- H12. `src/test-setup.ts` and the device simulation in `plugin.spec.ts`: the base for tests of two machines (ST27 to ST34).
- H13. The business rules as lessons: BR-SYNC-4 (no write for an unchanged note), BR-UI-5 (scroll restore), BR-UI-8 (search keeps the focus), BR-AUTH-3 and BR-AUTH-4 (secrets per device), BR-NET-1 (`requestUrl` only).
- H14. From Time Machine, not from Ghost Publish: the diff service and the diff viewer (B19).
- H15. From `TPL Publish`: the yield by time (PS4), the isolation of a failing file (PS5), and the list of the slowest serializations in the report (PS6).

### 16.2 Do differently, and why

- H16. State in the manifest, not in the notes (GP1, GP31). Reason: ST9.
- H17. An index with events, not a vault scan per render (GP3). Reason: B28.
- H18. A virtual list, not a card per item (GP10). Reason: B30.
- H19. One commit for all selected notes, not one push per note (GP7). Reason: the site must never show half of a publication, and git refuses a late push (GU15).
- H20. Selection with check boxes on a difference, not triage actions that write flags (GP1). Reason: a skip must write nothing (E1).
- H21. Removal is a first-class result. In Ghost Publish, "remove from queue" leaves the post live, and a deleted preset leaves its posts (rule BR-PRESET-3). On the site, a missing intent must remove the page.
- H22. Links from the metadata cache (`links`, `embeds`, `frontmatterLinks`), not from a regular expression (GP20). Reason: code blocks, embeds, headings and block references must resolve as in Obsidian.
- H23. The URL function comes from the core (A22), not from `utils/vault-path-to-url.fn.ts` (GP19).
- H24. No listing note (GP9). The site generates its lists (spec 6.9), and the history is in the store.
- H25. The button says what it acts on (B11). Rule BR-UI-7 fits a sync that is safe to repeat. It does not fit a publication with removals.
- H26. An event after the freeze step, not a fixed delay (GU21).
- H27. Fail closed. Ghost Publish writes a link that it cannot resolve as bold text and drops other embeds in silence (rules BR-PROC-3 and BR-PROC-4). The site tool reports each case through the gate.
- H28. A core without `App`. In Ghost Publish, `syncNote` takes `app` and mixes reading, transformation and network. This is why its spec is thin (GP18). In the new tool, the plugin adapters are thin and the core is tested with the fixture vault.
- H29. Command line handlers and an API object from the first version (GP17).
- H30. A tab in the main area with two panes, not a side bar with cards (B1).
- H31. Settings load through a schema (the rule of this repository), not a test per field (GP14).
- H32. No `app.setting` (GP21). The empty state names the settings tab in its text.

### 16.3 Changes that Ghost Publish itself needs

- H33. After the switch, `public_note` is an intent, not a state. The eligibility test of Ghost Publish (GP5) then accepts a note that is not live. The plugin must ask "is this note live". The site plugin can answer through its API object (A31), or Ghost Publish can read the public deployment record.
- H34. The canonical probe (GP16) becomes meaningful after the switch. Today the notes site answers 200 for pages that do not exist (problem 2 of the spec), so the probe cannot fail. The new site answers 404.
- H35. The URL helper must follow rule U1 (GP19). Notes with `+`, `%`, `&` or `?` in their name get a wrong canonical URL today.
- H36. The spec lists "the Ghost Publish plugin no longer needs the Publish API" as a switch condition (11.2, item 6). The source shows that the condition is already true (GP5). H33 and H35 replace it.

## 17. I: one plugin with "publish targets" later

### 17.1 For

- I1. One place for every publication. Story 69 asks for an article "without a second tool", and story 70 asks for the newsletter "from the same flow".
- I2. Shared parts: the list view, the index, the search, the status of a note, the secret handling.
- I3. The blog section will build from the same content store. An article is then a note with a section, and it goes through the same gate.

### 17.2 Against

- I4. Ghost Publish is a released community plugin with a locked id (rule BR-META-1), users, and defaults that fit any Ghost site (rule BR-DEF-1). The site tool is personal (decision D18) and tied to one content store and one gate.
- I5. The two models differ. Ghost: one API call per note, state in the note, no removal, no gate. Site: one commit per publication, a manifest, removals, a gate. A common "target" interface must hide these differences or leak them.
- I6. A mix puts a privacy-critical personal tool and a public plugin in one release cycle. A defect in the generic part reaches both.
- I7. The author already tried a generic tool: `obsidian-publisher`, with several targets, is unfinished (research, section 4).
- I8. Ghost will shrink. Decision D1 + D5 keeps Ghost for members and email until the blog phase, where it is replaced or reduced. A target abstraction built now serves a target that is on its way out.

### 17.3 Recommendation

- I9. No merge. Two plugins. Shared code is copied (section 16.1), because the shared parts are small and stable.
- I10. The site plugin gets "sections" (notes, then blog), not "targets". A publication entry carries its section from the first version. The cost is one field.
- I11. At the blog phase, Ghost Publish becomes the tool that sends the newsletter, or it retires. The decision belongs to the blog spec (D1 + D5).
- I12. Review this recommendation one time: when the blog section goes live and the remaining role of Ghost is known.

## 18. J: naming

Rules: TP4. The id is also the prefix of the command line handlers (API4), so a short id helps. The id `publish` belongs to the core plugin of Obsidian and must be avoided.

| Id  | Name               | Plugin id            | Remark                                                                                      |
| --- | ------------------ | -------------------- | ------------------------------------------------------------------------------------------- |
| J1  | Knowii Publish     | `knowii-publish`     | Uses the brand of the site. The backlog already uses this name (idea 149). Recommended      |
| J2  | Site Publisher     | `site-publisher`     | Plain and exact. Generic, so a name clash in the catalog is more likely                     |
| J3  | Garden Press       | `garden-press`       | Short id. Says "digital garden", which fits the notes section and not the blog or the store |
| J4  | Static Publish     | `static-publish`     | Names the output. Close to the name of the core plugin in a command list                    |
| J5  | Publication Center | `publication-center` | Names the view. Two other plugins use the same words for their dialog (PA7, PA17)           |

- J6. Example description that passes the rules: "Review, select and publish notes to a static site through a private content store."
- J7. Command names carry no plugin name: "Open publication center", not "Knowii Publish: open".
- J8. Not verified: whether a plugin with one of these names exists in the community catalog. This matters only if decision D18 becomes "yes". The id can change until the catalog accepts the plugin.

## 19. K: risks and decisions for the author

### 19.1 Risks

- KR1. The tool is on the path to the switch, and the bridge is gone (C5, C6). Answer: the size of section 15, and the headless slice of K1 first.
- KR2. The gate, the hashes and the cleaning of 20,000 notes run in the interface thread of Obsidian. Answer: cache, time slices, and a measure on the real vault before the view is built (K1).
- KR3. A rename without an event loses the old URL (ST24). Answer: pairing by hash, pairing by hand, and a test that counts unpaired "missing" entries before each publication.
- KR4. A vault that is not fully synchronized removes or rolls back notes (ST27 to ST31). Answer: no default selection for missing files, limits, the "older than live" mark, the device opt-in.
- KR5. The serializer hides failures (DS5). Answer: K13.
- KR6. The old script and the new tool both write the intent (GU24). Answer: one explicit step in the switch plan.
- KR7. The gate blocks many notes for a pattern that is harmless (a sample token in a note about security). Answer: the explicit mark on a note that the gate table of the spec allows, and a full gate report before the switch.
- KR8. `requestUrl` holds a whole file in memory and reports no progress. A large video can fail. Answer: a test with the largest attachment, and Node streams for large files if needed (desktop only).
- KR9. Obsidian starts with a different program path than a terminal, so `git` is not found. Answer: setting V23.
- KR10. Two untyped accesses remain (API10). A release of Obsidian can change them. Answer: one small adapter per plugin, with a clear error when the other plugin is missing.
- KR11. The first publication holds 20,735 notes in one commit and one upload run (GU23). Answer: it is repeatable, and a dry run on the real vault comes first.

### 19.2 Decisions, with a recommended answer

- K1. First slice: headless or view? Recommended: headless. Build `status` and `plan` first and run them on the real vault. They give the numbers for KR2 and a full gate report, and they need no interface.
- K2. Where does the plugin code live? Decision D17 says its own repository. The core and the plugin will change together until the switch. Recommended: start the plugin from the template inside this repository as a workspace package, and move it to its own repository when decision D18 becomes "yes" or when the core is stable. The alternative needs a published core package and an exception to the three-day rule for new versions.
- K3. Does the author accept that `public_note` becomes the intent, and that the reconciliation in `TPL Publish` stops on the day of the first run (flag F12 of the spec, GU24)? Recommended: yes.
- K4. Default selection (B16): new and changed selected, "intent removed" selected, "missing from this vault" not selected. Recommended: yes. The alternative "nothing selected" is safer and costs a click per publication.
- K5. Skip model: Recommended: no stored hold in the first version, a skip count in the history, and a review of option E3 when the count exists.
- K6. Limits: 25 notes or 1 percent for removals, 500 for new and changed, 100 for intent flips (GU4 to GU6). Recommended: start there and change them when the history shows how often they trigger.
- K7. Place of the gate configuration: the content store (ST10) or the plugin settings? Recommended: the content store, with no editor in the first version.
- K8. Can an agent apply a plan? Recommended: yes for a plan under the limits, never for a plan above them (A29). This refines decision D12.
- K9. Publishing devices: Recommended: opt-in per device, off by default (GU18).
- K10. Forced removal: which answer does the URL give? Rule U9 gives 410 for an unpublished note and 404 without former paths for a takedown. Recommended: a forced removal follows the takedown rule, because the reason is privacy.
- K11. A blocked note that is live: does the live version stay? Recommended: yes for every check except the deny list. The author sees state C6 and decides.
- K12. Deployment state: one record and a public file (ST8), or a state per manifest entry as the spec says? Recommended: one record.
- K13. Changes in the Dataview Serializer: a dry mode that returns `wouldUpdate` (DS4), an error entry in place of the silent `catch` (DS5, item 4), and a result that says "disabled on this device" (DS5, item 1). Recommended: make them before the first version of the plugin. The author owns that plugin.
- K14. Does a publication pass `isManualTrigger = true` to the serializer (DS6)? With `true`, "manual" queries are refreshed and "once" queries run again. Recommended: `false`, which is what `TPL Publish` does today. A publication must not change a result that the author froze on purpose.
- K15. Three facts to test in a real vault before the design is final: does the `obsidian` program wait for a long handler (A33), does a folder rename fire an event per file (ST26), and does the REST and MCP server plugin expose handlers that another plugin registered?
- K16. Git engine: the system `git` program, a git library in JavaScript, or the API of the git host? Recommended: the system program. The author uses it every day, it uses the credentials that exist, and the plugin stores none.
- K17. Attachments in the first version: upload from the plugin with a credential in `SecretStorage` (V25)? Recommended: yes, through the core with an injected HTTP function. The alternative is an upload step in `apps/cli` that the author runs by hand, which breaks the "one act" requirement.
- K18. Rollback window (C4, C6). Without the panel, Obsidian Publish gets no update after the switch. Options: (1) freeze Obsidian Publish on the day of the switch and accept that a revert shows that day, or (2) use the panel during the window only. Recommended: option 1, with a window that the author ends by decision. It matches "not even the panel".
- K19. Diff in the first version? Recommended: no (L1). The review step of the switch is the lists and the gate report, which is what the Publish panel gives today.
- K20. Name (section 18). Recommended: J1.
- K21. One plugin with Ghost later (section 17). Recommended: no, with one review at the blog phase.
- K22. Ghost Publish changes H33 and H35: before the switch or before the cancellation of Obsidian Publish? Recommended: before the switch, because the property changes its meaning on that day.
- K23. "Technical updates" as one line (ST16): accept two hashes in the manifest from the first publication? Recommended: yes. The second hash is cheap, and it is hard to add after 20,735 entries exist with dates.

## 20. The One Thing

Build the headless `plan` handler on the real vault first (K1): it proves the core inside Obsidian, measures the load of 20,000 notes, and gives the first full gate report before any view exists.

## 21. Sources

Local sources (public repositories of the author, read on 2026-11-17):

- `obsidian-ghost-publish`: `README.md`, `docs/usage.md`, `docs/tips.md`, `documentation/Architecture.md`, `documentation/Business Rules.md`, `documentation/Domain Model.md`, `documentation/Configuration.md`, `src/`.
- `obsidian-plugin-template`: `AGENTS.md`, `manifest.json`, `src/`, `node_modules/obsidian/obsidian.d.ts` (1.13.1).
- `obsidian-dataview-serializer`: `src/app/plugin.ts`.
- `obsidian-time-machine`: `src/app/services/diff.service.ts`, `src/app/ui/components/diff-viewer.ts`.
- `obsidian-starter-kit-plugin`: `src/api/plugin-api.ts` (method names only).
- `obsidian-cli-rest`: `README.md`.

Web sources (read on 2026-11-17):

- W1. Obsidian Help, "Publish your content": https://obsidian.md/help/publish/publish
- W2. Obsidian change log, desktop 0.14.8 (2022-05-03): https://obsidian.md/changelog/2022-05-03-desktop-v0.14.8/
- W3. Obsidian forum, "Reduce publish friction (>30 second to open the modal on large vault)": https://forum.obsidian.md/t/reduce-publish-friction-30-second-to-open-the-modal-on-large-vault/50860
- W4. Quartz Syncer, repository and README: https://github.com/saberzero1/quartz-syncer
- W5. Quartz Syncer documentation, usage guide: https://saberzero1.github.io/quartz-syncer-docs/usage-guide
- W6. Quartz Syncer documentation, command line guide: https://saberzero1.github.io/quartz-syncer-docs/guides/cli
- W7. Digital Garden plugin, repository and README: https://github.com/oleeskild/obsidian-digital-garden
- W8. Digital Garden documentation, commands: https://docs.forestry.md/getting-started/02-commands/
- W9. Digital Garden source, `PublishStatusManager.ts`: https://raw.githubusercontent.com/oleeskild/obsidian-digital-garden/main/src/publisher/PublishStatusManager.ts
- W10. Enveloppe, repository and README: https://github.com/Enveloppe/obsidian-enveloppe
- W11. Enveloppe documentation: https://enveloppe.ovh/
