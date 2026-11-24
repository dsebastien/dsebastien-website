# Canonical Form

The publishing logic exists two times: in TypeScript inside the Obsidian plugin, and in Rust inside the command line program (ADR 0009). The parity rule says that both give the same bytes for the same input. This document says what "the same bytes" means. It is the canonical form of TOOL-06 and TOOL-31 of the spec.

A change of a rule here lands in both implementations in the same commit.

## What the parity rule compares

1. The publication plan as data, without its id and its time.
2. The cleaned notes.
3. The manifest.
4. The files of the attachment storage, with their keys.

The parity tests compare two more outputs, so that every face of the tool shows the same thing: the publication queue, and the lists of paths of the publication report.

Outside the rule (TOOL-30): the view, the order of the writes into the vault, ids (plan id, run id), the time of a run, and the text of logs, reports, commit messages and error messages.

## Inputs

1. The same input gives the same output: the state of the vault, the manifest, the configuration of the tool, the selection, and the time of the run.
2. The time of a run is an input. The logic never reads the clock. A face of the tool reads the clock one time, cuts the parts of a second (no rounding), and passes the time as the text of rule 9 of the data. The logic refuses a text that is not a real date and time in that form.
3. The logic uses no random value. An id is made by a face of the tool, outside the logic.
4. The logic does not depend on the system: not on the path separator, not on the locale, not on the time zone, not on the order in which the file system lists files.

## Encoding

1. Every output is UTF-8, without a byte order mark.
2. A line ends with the line feed character (U+000A) alone. Data never holds a carriage return. In a cleaned note, each pair of a carriage return and a line feed becomes a line feed, and a carriage return that stands alone is text of the author and stays.
3. A data file ends with exactly one line end.

## Data: the plan and the manifest

Data is written as JSON, in this exact form:

1. Two spaces per level. One member or one item per line. A colon and one space between a key and its value. No space at the end of a line.
2. An empty list is `[]` and an empty object is `{}`, on one line.
3. The keys of each object are sorted in the order of their code points. So a capital letter comes before a small letter, and `"10"` comes before `"2"`.
4. A key holds only plain ASCII characters (U+0020 to U+007E). So the order of the code points, of the UTF-8 bytes (Rust) and of the UTF-16 units (TypeScript) is the same order. A key can be empty.
5. A value is a text, a whole number, a boolean, a list or an object. There is no `null`: a value that does not exist has no key.
6. A number is a whole number from -9,007,199,254,740,991 to 9,007,199,254,740,991, which both languages hold exactly. No fraction and no exponent.
7. In a text, the quote and the backslash are escaped (`\"`, `\\`). A control character below U+0020 is escaped: `\b`, `\t`, `\n`, `\f`, `\r` where that short form exists, else `\u00` and two small hexadecimal digits. Every other character is written as it is: the slash, the delete character, and every character outside ASCII.
8. A text is valid Unicode. Half of a surrogate pair has no canonical form.
9. A time is a text in UTC, to the second: `2031-03-14T07:30:00Z`.
10. Data has 64 levels at most. A value alone is level 1, and each list or object adds one.

A value that breaks rule 4, 5, 6, 8 or 10 is refused by both implementations. It is a defect of the logic, never a case to write in another way.

Three points differ between the languages, and the logic must stay away from them:

1. In Rust, a number must have a whole number type. A floating point number is refused, also when its value is whole (`1.0`). In TypeScript every number is a floating point number, so `1.0` is the whole number 1.
2. TypeScript has a negative zero, and it is written as `0`. A Rust whole number has none.
3. In TypeScript, only the listed members of a plain object are data. A key that is a symbol and a member that is not listed are left out. A list with a hole, a date, a map and an object of a class are refused.

## Lists

1. The canonical writer never sorts a list. The logic gives each list in its order, and that order is part of the output.
2. A list of notes is sorted by vault path. A path is compared as one text, the slash included, code point by code point. The text that ends first comes first.
3. The usual tools give another order, so each implementation has one function for it:
    - TypeScript: `compareCodePoints` of `apps/plugin/src/publishing/order.ts`. The default `sort()` is wrong: it compares UTF-16 units, so it puts a character above U+FFFF (most emoji) before the characters U+E000 to U+FFFF. A comparison that follows a locale is wrong too.
    - Rust: the order of `String` and `str`, in `cli/src/order.rs`. The order of `Path` and `PathBuf` is wrong: it compares part by part, so `a/z.md` comes before `a b/c.md`.
4. A list whose order has a meaning keeps it. The former paths of a note are in the order in which they were added.
5. Each new list states its order in the document of its data, before the second implementation is written.

## Paths

1. A vault path is relative to the root of the vault, with `/` between its parts and no `/` at the start, on every system.
2. A path is written and compared as the vault gives it. The logic never changes its letter case and never converts it to another Unicode form: a converted path can name no file.
3. The fixture vault holds names in the composed Unicode form (NFC) only. A name in another form is published as the vault writes it, and its canonical URL encodes it so (decision R47). The resolver of the site reads a request in the composed form, so the other forms lead to the note with a redirect (URL-02 of the spec). The tool compares two names in the folded form of "The root names of the site" only to stop a plan, never to name a file.

## Small letters

Where a rule compares texts with the letter case ignored, it compares their small letters. Both implementations, and the resolver of the site, make small letters with one table: `packages/resolver/src/small-letters.json` (issue 73). Neither `toLowerCase` of TypeScript nor `to_lowercase` of Rust is run on such a text: the two languages take their small letters from different versions of Unicode, and the table does not change with them.

1. The table gives, for each code point alone that has small letters, those small letters, as `toLowerCase` of JavaScript gave them when the table was made (`scripts/small-letters.ts`, Bun 1.4.4: 1,488 code points). A code point that the table does not name stays as it is. One code point gives two: U+0130 gives `i` and U+0307.
2. One rule of context, the final sigma of Unicode: a capital sigma (U+03A3) gives a final sigma (U+03C2) when, before it, the first code point that is not case-ignorable is cased, and, after it, the first code point that is not case-ignorable is not cased or there is none; else it gives U+03C3. The table file lists the cased code points (`cased`) and the case-ignorable ones (`caseIgnorable`) as ranges, from the properties `Cased` and `Case_Ignorable` of JavaScript when the table was made. So `ΟΔΟΣ` gives `οδος`, `ΟΔΟΣ.md` gives `οδοσ.md` (the dot is case-ignorable, the `m` is cased), and `ΣΑ` gives `σα`.
3. A change of the table changes the link rule, the folded form of a URL and the guard by file name: it is made on purpose, with shared cases.
4. The guard by file name compares names with a wider fold, so it fails closed: the name in the composed Unicode form (NFC), then in small letters, then in NFC again, then each code point that the list `newer` of the table file names in the small letters of a newer Unicode, then in NFC again (20 code points, where `to_lowercase` of Rust 1.100.0 differed from the table, such as U+A7DD to U+0277). A name that the author moved into a folder of the deny list in the decomposed form (as macOS writes it), with such a letter, or with a capital and a mark that NFC composes only in small letters (`J` and U+030C), is caught.
5. A limit: TypeScript composes with the ICU of its engine and Rust with the crate `unicode-normalization`, which can know a newer Unicode. They differ on code points that are marks only in the newer one (34 code points of Unicode 18, none assigned in Unicode 17). The crate version is pinned, so it moves only on purpose.

The table is the one of Bun, a JavaScript engine (JavaScriptCore). Obsidian runs on Electron (V8 and the ICU of Chromium): on a code point where the two engines know other versions of Unicode, the link rule can differ from Obsidian. None of the published notes of the author has such a name.

## The content store

| Path                 | What it holds                                                             |
| -------------------- | ------------------------------------------------------------------------- |
| `configuration.json` | The configuration of the tool: `denyList`, the list of the denied folders |
| `notes/<vault path>` | The cleaned note of a published note, at its vault path                   |
| `manifest/<id>.json` | The manifest entry of a published note, as data in the canonical form     |
| `renames.json`       | How many lines of each rename journal the publications read (see below)   |
| `edits.json`         | The log of the edits of the guards, and their proposals (see below)       |

The configuration is read strictly. The tool stops, and publishes nothing, in each of these cases:

1. The file exists and cannot be read as UTF-8 text, or is not JSON, or is not an object whose `denyList` is a list of texts.
2. An entry of the deny list is not a vault path in the form of this document: relative, with `/`, with no empty part, no `.` part and no `..` part.
3. An entry of the deny list names no folder of the vault, with exactly that name (GATE-38 of the spec). A folder that was renamed, or an entry with another letter case, would else make its notes candidates. When the rename journals moved that folder, the message names its new path (see "The rename journal").

Only a content store that has no `configuration.json` at all, neither in its last commit nor in the copy, has an empty deny list.

The copy of the content store must be the root of its own git repository. The content store has one branch, `main`: every publication pushes to it. The tool stops (`status`, `plan` and `publish`) when the copy has commits that no branch of the content store has (`git rev-list HEAD --not --remotes=origin`). A copy with no branch of its own that leads to a commit has no commit ahead (see below). Such a commit is a publication that git could not take back, and the next push would send it, also for a note that came under a guard since. A folder of the store that exists and cannot be listed stops the tool too: it is never read as an empty folder. The tool reads the state from the files of the copy, so `configuration.json`, `manifest/`, `renames.json` and `edits.json` in the copy must be exactly the files of its last commit (a `renames.json` that differs would apply old renames again, and an `edits.json` that differs would be committed by the next publication or edit as a log that no run wrote). The tool stops when `git status` shows any change on them (a file edited, removed, added, ignored or replaced by a folder or a link, also with no index), and when git skips one of them or assumes it unchanged (a sparse checkout, `--skip-worktree`, `--assume-unchanged`), which `git status` does not compare. A file that differs would hide a published note under a guard, or empty the deny list. The tool also stops when `git status` shows a file of `notes/` that the last commit has and that the copy removed, edited or replaced (decision R46, after the first review): a forced removal stages only the files that it removes from the copy, so a cleaned note that was already missing from the copy would stay in the content store. A file of `notes/` that the last commit does not have is not checked: the tool never commits it. This comparison converts the line ends as the copy converts them (Git for Windows converts them by default), so a file that differs only in its line ends is the same file. It is the one place where the tool lets git convert line ends. Git status trusts the stat data of a file, and an edit of the same size in the same second can look unchanged to it, so the tool also compares the bytes of each file with the commit by its hash (`git ls-tree` and `git hash-object --no-filters`), with no filter and no attribute of git: a filter could make other bytes look like the commit. A file whose hash differs is still the file of the commit when, with each carriage return and line feed made a line feed, it has the hash of the commit: in a valid JSON text a line end is only white space. When the copy has commits that no branch of the content store has, the message proposes a push only when the push would change `configuration.json` alone and not remove it (`git diff --no-renames --name-status origin/main HEAD`, or every file of the last commit when the content store has no branch yet). The names of the files in the commits do not say it: a commit that removes the configuration would empty the deny list, and a merge commit names no file but can take back a publication of another device. After an edit of the deny list by hand, the author commits `configuration.json` and pushes it before the next run. A copy that is behind the content store reads an older manifest: a note that came under a guard since would stay live, and the push of the copy would be refused. So `plan` and `publish` fetch the branch `main` of the content store first, with the branch named (`git fetch origin +refs/heads/main:refs/remotes/origin/main`, after `git ls-remote origin refs/heads/main`: a content store with no branch yet has nothing to fetch), so that no fetch setting of the copy can leave `origin/main` as it was, and stop when the copy is behind its branch `main` (`git rev-list --count HEAD..origin/main`), with a message that says to pull (`git pull --ff-only origin main`). When the content store has no branch `main` but the copy knows one, they stop too. When the content store cannot be reached (no network), `publish` stops, and `plan` uses the last fetch: its output says `offline: true` (PERF-16 of the spec, decision of the author R46). A plan made offline is safe: its publication fetches, stops when the copy is behind, and computes the record again. `status` stays offline and fast: it reads no network, and its key `behind` gives how far the copy is behind at the last fetch. A copy with no branch of its own that leads to a commit (a clone of a content store with no branch yet, or a copy made with `git init`) has no commit ahead, and it is behind every commit of the content store. An orphan branch in a copy with commits is not such a copy, and it stops the tool. Only the copy of a content store with no branch at all has no history to compare. Another device can still push between the fetch and the push of a publication: the push is then refused, nothing is published, and no property is corrected. The author pulls (`git pull --ff-only origin main`, decision of the author R46: the tool does not pull by itself) and makes a new plan. The tool never forces a push. The tool stages and commits only the files that it wrote. Every git command of the tool reads paths as they are written (a note name can hold `[` or `*`) and converts no line end, whatever the settings of the machine say, but for the comparison of the copy with its last commit (see above).

## The attachment storage

The attachments live apart from the content store, in the attachment storage (STORE-06 of the spec): an object storage on the host, and a folder on a device and in the tests. Its files are the attachments, each one under its key: the 64 small hexadecimal digits of the SHA-256 of its bytes. The bytes are the bytes of the file in the vault, as they are (PUB-39). A file of the storage is complete or does not exist: a write never leaves a part of a file under a key. The storage has no folder, and the tool reads no folder and no symbolic link in it.

1. Only the attachments that published notes use are in the storage. A file of the storage is used when the entry of a published note lists its key in its `attachments`. Every other file goes at the next publication (see "A publication"). A file is not used when its attachment is under a guard now, also when an entry that a plan held still lists it (see rule 8 of "A publication"). A key that is being written (`.<key>.part`) is a file of the storage too, and the cleanup deletes it when it is left. Any other name is not a file of the storage: the tool leaves it and warns, so a folder given by mistake loses no file.
2. The tool writes a key one time: two notes, or two names, with the same bytes share one file.
3. A file of the vault that no published note uses is never uploaded. A file in a folder of the deny list is never uploaded, also when a published note links to it (GATE-42).

## The notes of the vault

The tool scans the vault to find its notes and the other files that a note can link to. Both implementations scan in the same way:

1. The scan starts at the root of the vault and goes into each folder.
2. A name that starts with a dot is not part of the vault: a folder (`.obsidian`, `.trash`) or a file. Obsidian does not show them.
3. A symbolic link is not part of the vault, as a file and as a folder.
4. A name that is not valid Unicode, or that holds the replacement character (U+FFFD), is not part of the vault.
5. A folder of the deny list is not scanned for notes. The tool reads none of its files and writes none. It lists the files below it by their paths (rules 2, 3, 4 and 6 apply to the names below the folder, not to the entry of the deny list itself), for two reasons: to know that a published note or an attachment moved into it (see the forced removals of the publication plan and rule 8 of a publication), and to know that a link leads to a file under that guard (see the links of a note). For the first reason only, it also takes the names below a name that starts with a dot or that is not valid Unicode: a file moved into a hidden folder of a deny list folder is still under the guard. Those files are no candidates of a link, because Obsidian does not show them. It writes none of these paths.
6. A note is a file of the scan whose name ends in `.md`, in small letters. Every other file of the scan is a file that a note can link to: an attachment when a note links to it (see "The attachments of a note").
7. The tool reads every note of the scan. A note that cannot be read, or that is not valid UTF-8, stops the run with a message that names it. A note that cannot be read is never taken for a note without the ignore property.
8. The tool reads a file that is not a note only when a published note, or a note of the plan, links to it. It reads its bytes, as they are, one time per run. A file that cannot be read stops the run with a message that names it.

## The rename journal

Decisions of the author R66 (issue 37, ADR 0007). The URL of a note is its vault path, so a note that moves keeps its old URL as a redirect: the manifest entry keeps its id and its old path becomes a former path. The plugin records each rename that Obsidian reports in the rename journal of its device.

1. The journals are the files of the folder `renames` of the plugin folder, in the vault: `.obsidian/plugins/dsebastien-vault-publish/renames/` (the plugin uses the configuration folder of Obsidian; the command line program takes the option `--renames`, with this folder of `--vault` by default). The folder starts with a dot, so the scan never reads it as notes, and it travels with the vault to the other devices (PUB-60 of the spec).
2. Each device writes one journal: `<16 small hexadecimal digits>.jsonl`, a name that the plugin makes one time per device and keeps in the local storage of Obsidian. Only a name of that form is a journal: another file (a copy that a synchronization made) is never read. A folder that does not exist holds no journal. No implementation of the logic writes a journal: only the plugin appends to it.
3. A journal is read as bytes. A line is the bytes before a line feed. The bytes after the last line feed are a line that is still being written: they are not read and not counted. Before the plugin appends a line, it writes a line feed when the file does not end in one, so a line that was cut stays one line.
4. A line is one object of data on one line, in the canonical form but with no line end and no space: `{"from":"Old.md","kind":"note","time":"2031-05-01T08:00:00Z","to":"New.md"}`. It has exactly the keys `from` and `to` (two different vault paths), `kind` (`note` or `folder`) and `time` (rule 9 of the data). For `note`, both paths end in `.md` (in small letters). The plugin writes a line `note` for each renamed file whose old and new names end in `.md`, and a line `folder` for each renamed folder. A line that is not valid UTF-8, that is not such an object, or that is not read by the strict reader of JSON (`json.ts`, `json.rs`) is counted, not applied, and gives a warning.

`renames.json` in the content store holds, for each journal that a publication read, the number of its lines that were read and the hash of their bytes: `{"<name>": {"hash": "sha256:<SHA-256 of the bytes of those lines, with their line feeds>", "lines": <count>}}`, as data in the canonical form. Every publication writes it with each line that it read, also when a line moved no note. A line is read one time only: a later rename of another note to the same path can never take an old line (decision R66). The lines of a journal after its count are its new lines. A journal with no count has only new lines. When a journal has fewer lines than its count, the vault of this device can be behind: none of its lines is applied, a warning names it, and its count stays, so that no line is applied two times when the vault catches up. When its first lines do not have the hash of the count, it was edited: none of its lines is applied, a warning names it, and its count becomes all its lines. A count of a journal that is no longer in the folder stays. A content store with no `renames.json` has read no line.

The moves. The new lines of all the journals are taken in one order: the first new line of each journal, then the one with the earliest `time`; for the same time, the journal whose name comes first. The lines of one journal keep their order. Then each line moves the notes of the manifest, published and unpublished, from their paths:

1. A line `note` moves the entry whose path is `from` to `to`. A line `folder` moves each entry whose path starts with `from` and a slash: the rest of the path follows `to` and a slash. When another entry is at the new path, that entry does not move, with a warning.
2. A chain of lines folds into one move: the move of an entry is from its path in the manifest to its last path. A note that comes back to its path did not move.

Then, for each entry that moved from the path `from` to the path `to` (an unpublished entry takes rule 1 only, and else does not move: its old address stays gone, and a path that it had only while it was unpublished never becomes a public former path):

1. When `to` is in a folder of the deny list, or the note at `to` has the ignore property, the note moved under a guard: the entry stays at `from`, and it is a forced removal (rule 3 of the plan), also when the vault of this device still has the file at `from` (the guards win). One exception: when the vault still has the file at `from` and the `time` of the last line that moved the entry comes before its `firstPublished`, the line cannot be about this note (a folder line moves every path below the folder, also of a note that another device published later): the entry does not move, with a warning. The journal gives the exact move, also when the note got another name.
2. When `to` is not a path of the vault (a part starts with a dot or holds U+FFFD), or when the note at `to` does not have the source hash of the entry while the scan still has a note at `from` that has it, or a note at `from` and none at `to`, the vault of this device does not show the move (it did not synchronize yet, or the note moved back outside Obsidian): the entry does not move, with a warning. The note can then show as a pairing. In every other case the entry moves; when the note at `to` has another source hash, it is in `movedEdited` of the queue, and its update waits for a tick (decision R67): it can be an edit after the rename, or another note at that path.
3. When the file or the first folder of `to` is a reserved root name (see "The root names of the site"), the entry does not move, with a warning.
4. Else the entry moves: its path is `to`. Its `formerPaths` lose `to` and get `from` at the end when they do not have it.
5. When two entries are at one path after these rules, or two published entries have paths whose texts (without `.md`) have one folded form, each entry of the group that moved does not move, with a warning, and the rules run again until no such group is left. An unpublished entry that a line moved away and that stays at its path (it is not under a guard) does not count at its path for this rule when exactly one other entry is at its path, that entry is published, and the note of the scan at that path has the source hash of that entry (decision R67): the published note is really there.
6. Then such an unpublished entry, when the published entry of rule 5 is at its path, leaves the manifest (issue 105, decision of the author R67): the publication removes its manifest file in its commit, with a warning with its path. A published note moved into the path that the unpublished note left, so the published note takes it: nothing of the unpublished note becomes public, and its other addresses answer 404 instead of 410.

A move needs no selection and cannot be held (decision of the author R66): the published version moves as it is, so a move puts no new text live. The queue, the selection and the plan read the manifest after the moves, so a moved note is a published note at its new path: an edit of it is a change of the queue that the author can hold. The notes whose links lead to the moved note are technical updates or changed notes, so a plan without paths updates them with the move (PUB-23 of the spec).

The pairings. A rename that the plugin did not see (made while Obsidian was closed, by a script or by git) leaves a published note in `missing` and a candidate in `new`. When a source hash of the manifest is the `sourceHash` of exactly one entry of `missing` and the source hash of exactly one candidate that has no manifest entry, the queue proposes them as a pairing (PUB-62 of the spec). A note of `missing` at the new path of a move of the queue is not proposed: the move is published first. The author confirms a pairing, or pairs two notes by hand when the content differs (PUB-96), with the list `pair` of the selection. A pairing moves the entry like a move of the journal, and its note is updated from the vault unless the selection holds it.

A deny list entry that names no folder stops every run (GATE-38). When the lines of the journals, all of them in the order above, move the folder of that entry (a line `folder` whose `from` is the entry or a folder above it) to a folder of the vault, the message proposes that folder for the deny list (PUB-91 of the spec). The tool does not change the deny list: the author does.

## The publication queue

The publication queue is what the `status` command writes, as data in the canonical form. It changes nothing in the vault and in the content store.

| Key                     | Value                                                                                                                                                                                                                                                                                                                                                             | Order                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `behind`                | The number of commits of the branch `main` of the content store, at the last fetch, that the copy does not have                                                                                                                                                                                                                                                   |                         |
| `changed`               | The vault paths of the published notes whose content in the vault is not the published content                                                                                                                                                                                                                                                                    | Sorted by path          |
| `counts`                | The number of paths of each of the four lists: `changed`, `new`, `toRemove`, `unchanged`                                                                                                                                                                                                                                                                          |                         |
| `movedEdited`           | The paths of `changed` whose entry, after the moves, has `updateHeld`: a move of `renamed` whose note at the new path has another source than the entry gives it the mark, and a publication of the move writes it. The tool cannot tell an edit after the rename from another note at that path, so their update waits until `include` names them (decision R67) | Sorted by path          |
| `missing`               | The paths of `toRemove` whose file this device does not have and that no guard excludes: missing from this vault                                                                                                                                                                                                                                                  | Sorted by path          |
| `new`                   | The vault paths of the candidates                                                                                                                                                                                                                                                                                                                                 | Sorted by path          |
| `pairings`              | The pairings to confirm: each with `from`, a path of `missing`, and `to`, a path of `new` with the same source hash (see "The rename journal")                                                                                                                                                                                                                    | Sorted by `from`        |
| `renamed`               | The moves of the new lines of the rename journals that the next publication applies, each with `from` and `to` (see "The rename journal")                                                                                                                                                                                                                         | Sorted by `from`        |
| `technicalUpdates`      | The paths of `changed` that the author did not edit: only the result of the cleaning step moved                                                                                                                                                                                                                                                                   | Sorted by path          |
| `toRemove`              | The vault paths of the published notes that cannot stay published as they are                                                                                                                                                                                                                                                                                     | Sorted by path          |
| `unchanged`             | The vault paths of the published notes that are the same in the vault and in the content store                                                                                                                                                                                                                                                                    | Sorted by path          |
| `proposals`             | The open proposals of `edits.json`: each `proposed` event that no later event confirms or rejects, as the file holds it (see "The edits of the guards"). Apart from the four lists: not counted                                                                                                                                                                   | In the order of the log |
| `unpublishedUnderGuard` | The vault paths of the unpublished notes that a guard excludes: the forced removals of the next plan (rule 3 of the plan, R64). Apart from the four lists: not counted                                                                                                                                                                                            | Sorted by path          |

The queue is computed on the manifest after the moves of the rename journals. A published note is a note with a manifest entry whose state is `published`. Each note is in one of the four lists at most:

1. A published note is in `toRemove` when the scan did not find its file (it is missing from this vault, or it is now in a folder of the deny list), or when the ignore property excludes it. Such a note is never updated. It is also in `missing` when it is not a forced removal (rule 3 of the plan): its file is only missing on this device, for example in a vault that is not fully synchronized. Such a note is never selected by default (PUB-95 of the spec): only a path of `remove` of the selection unpublishes it.
2. Another published note is in `changed` when the hash of its source is not the `sourceHash` of its manifest entry. It is in `changed` and in `technicalUpdates` when the hash is the same and the cleaning step would give another result: the `cleaningVersion` of its entry is not the version of the cleaning step, the `links` of its entry are not the links that the note has now (a target was made, moved or removed, or a guard now excludes it), or the `attachments` of its entry are not the attachments that the note has now (a file was added, changed, moved or removed, or a guard now excludes it), or the `noteType` of its entry is not the note type that the note has now (see "The note type of a note").
3. Every other published note is in `unchanged`.
4. A note of the scan that is not published is in `new` when the ignore property does not exclude it. A note that was unpublished is a candidate again.
5. A note that is not published and that a guard excludes is in none of the four lists. An unpublished note under a guard waits for its forced removal (rule 3 of the plan): it is in `unpublishedUnderGuard`, so that the author sees that the next publication has work to do (R64).

The `public_note` property is not read for the queue. A note that carries it by mistake is a candidate like every other note, and a published note without it stays published.

The empty queue. A test compares this block with the output of the code:

<!-- prettier-ignore -->
```json
{
  "behind": 0,
  "changed": [],
  "counts": {
    "changed": 0,
    "new": 0,
    "toRemove": 0,
    "unchanged": 0
  },
  "missing": [],
  "movedEdited": [],
  "new": [],
  "pairings": [],
  "proposals": [],
  "renamed": [],
  "technicalUpdates": [],
  "toRemove": [],
  "unchanged": [],
  "unpublishedUnderGuard": []
}
```

## The selection

The selection is the intent of the author for one plan. It has three lists of vault paths, and a list of pairings:

| Key       | Value                                                                              |
| --------- | ---------------------------------------------------------------------------------- |
| `hold`    | The notes to leave out of this plan: their live version stays                      |
| `pair`    | The pairings that the author confirms: each with `from` and `to`, sorted by `from` |
| `include` | The notes to publish                                                               |
| `remove`  | The published notes to unpublish                                                   |

A selection stops the plan in each of these cases:

1. A path is not a vault path, or it does not end in `.md` (in small letters).
2. A path is in more than one of the three lists.
3. A path of `include` is not in the list `new`, `changed` or `unchanged` of the queue. So a note under a guard, a file that is not a note of the scan and a published note that waits for its removal cannot be included.
4. A path of `hold` is in none of the four lists of the queue (an unpublished note under a guard: see rule 6). A hold that names no note would hold nothing, and the note that the author meant would be published.
5. A path of `remove` is not the path of a published note.
6. A path of `hold` is the path of a forced removal (see the plan), of a published or an unpublished note. A guard cannot be held (PUB-21 of the spec).
7. An item of `pair` is not an object with exactly `from` and `to`, two vault paths that end in `.md`; its `from` is not in the list `missing` of the queue; its `to` is not in the list `new`, or it is the path of a manifest entry; or a path of a pairing is in another item or in another list of the selection, but for a `to` in `hold`; or two pairings have one `to`; or the `from` of a pairing is the `to` of a move of the list `renamed` of the queue (the move is published first, then the pairing).

## The publication plan

| Key            | Value                                                                                                                                                          | Order                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `forcedRemove` | The vault paths of the notes with a manifest entry that a guard excludes: the forced removals                                                                  | Sorted by path          |
| `move`         | The moves: each with `from`, the path of its manifest entry, and `to`, its new path                                                                            | Sorted by `from`        |
| `publish`      | The vault paths of the notes to publish                                                                                                                        | Sorted by path          |
| `remove`       | The vault paths of the published notes to unpublish                                                                                                            | Sorted by path          |
| `update`       | The vault paths of the published notes to update                                                                                                               | Sorted by path          |
| `edits`        | The events of `edits.json` that no publication showed yet: the events after the first `published` ones, as the file holds them (see "The edits of the guards") | In the order of the log |

So the plan shows the edits of the guards since the last publication (GATE-07, GATE-40), and a new event makes a stored plan stale.

The plan of a selection:

1. `publish`: the paths of `include` that are in the list `new` of the queue. A new candidate enters a plan only when its path is named.
2. `update`: every path of the list `changed` of the queue that is not in `hold` and not in `remove`, and not in `movedEdited` unless `include` names it (decision R67). So a plan without paths holds the changed notes only, without the moved notes whose text changed. Another path of `include` that is in `changed` or in `unchanged` adds nothing.
3. `forcedRemove`: every path of the list `toRemove` of the queue that a guard excludes. There are three cases. The path is in a folder of the deny list. The ignore property excludes the note. Or the scan did not find the file of the note, and a note with the same name, the letter case and the Unicode form ignored (the wider fold of rule 4 of section "Small letters"), is in a folder of the deny list: the note moved there. The tool compares names only and reads no file of such a folder, so a published note that is missing from this vault is removed too when another note of its name is in a folder of the deny list: the tool fails closed. When a line of a rename journal moves the note, the move gives the exact path (see "The rename journal"): a note that moved to a path under a guard is a forced removal, also with another name, and a note that moved elsewhere is not one, also when a note of its name is in a folder of the deny list. Without a line, a note that gets another name when it moves, or that moves into a folder below a deny list folder whose name starts with a dot, is only missing for the tool. A published note whose file is only missing, with no note of its name in a folder of the deny list, is not a forced removal. A note that was unpublished (its entry has the state `unpublished`) is a forced removal too when a guard excludes it in one of the same three cases (for the third: the scan did not find its file): its entry leaves the manifest, so its addresses answer 404 as after a takedown, and no more 410 (URL-28, decision R64). Such a note is in none of the four lists of the queue: it is in `unpublishedUnderGuard` (rule 5 of the queue), and a hold of it is refused like a hold of a published note under a guard. No selection changes this list: every plan holds every forced removal, also a plan without paths (PUB-21 of the spec).
4. `remove`: the paths of `remove` of the selection that are not in `forcedRemove`. A guard wins over an unpublish.
5. `move`: every move of the list `renamed` of the queue, and every pairing of `pair` of the selection. No selection holds a move of the journal. The `to` of a pairing is in `update` unless it is in `hold`. A pairing whose `to` breaks the rules of "The root names of the site" stops the plan, as a new note does.

Both implementations sort the four lists when they make a plan (`makePlan`, `PublicationPlan::new`), so no caller can give a plan in another order.

The empty plan. A test compares this block with the output of the code:

<!-- prettier-ignore -->
```json
{
  "edits": [],
  "forcedRemove": [],
  "move": [],
  "publish": [],
  "remove": [],
  "update": []
}
```

A plan is stored on the device as a record: the plan, the selection that gave it, and the state that it was computed from. The record is stored outside the vault and outside the content of the store. The parity rule compares the record.

| Key                   | Value                                                                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `plan`                | The plan                                                                                                                                                                                                                       |
| `selection.hold`      | The vault paths of the selection to hold, each one time, sorted                                                                                                                                                                |
| `selection.include`   | The vault paths of the selection to publish, each one time, sorted                                                                                                                                                             |
| `selection.pair`      | The pairings of the selection, each one time, sorted by `from`                                                                                                                                                                 |
| `selection.remove`    | The vault paths of the selection to unpublish, each one time, sorted                                                                                                                                                           |
| `state.journals`      | `sha256:` and the SHA-256 of the journals: for each journal, in the order of the names, its name, a line feed, the SHA-256 of the bytes of its lines (`sha256:` and small hexadecimal digits), a line feed                     |
| `state.renames`       | `sha256:` and the SHA-256 of the text of `renames.json`, or `none` when the store has no such file                                                                                                                             |
| `state.configuration` | `sha256:` and the SHA-256 of the text of `configuration.json`, or `none` when the store has no such file                                                                                                                       |
| `state.manifest`      | `sha256:` and the SHA-256 of the manifest: for each file of `manifest/`, in the order of the paths, its path in the store, a line feed, the hash of its text in the form of the manifest, a line feed                          |
| `state.notes`         | A list with, for each note of `publish` and of `update`, its `path`, its `sourceHash`, its `cleanedHash`, its `aliases`, its `links`, its `attachments` and its `noteType` (in the form of the manifest entry), sorted by path |

The `cleanedHash` of a note in the record is the hash of the cleaned note that the publication will write. It is what the plan shows of the text (PUB-92 of the spec).

The `plan` command gives the id, the plan, and `offline`: `true` when the content store could not be reached and the plan uses the last fetch, else `false`. `offline` is not a part of the record, so the same plan made later with a network has the same id.

The id of a plan is 16 hexadecimal digits of the SHA-256 of its record. It names the stored file. It is outside the parity rule. The tool accepts no other form of id.

Before a plan is applied, its record is computed again from the selection. When the new record is not the stored one, the plan is stale and nothing is published: a note of the plan was edited, another published note changed and would enter the plan, a published note came under a guard, a link of a note of the plan leads to another note, an attachment of a note of the plan changed, the note type of a note of the plan changed, the configuration changed, a journal has another line, another publication changed the manifest or `renames.json`, or the version of the cleaning step is another one. The run still cleans the attachment storage first (rule 8 of a publication), and when that cleanup gives warnings, the message of the refusal ends with them (issue 77): a line `The cleanup of the attachment storage gave these warnings:`, then one line per warning in the order of the cleanup, `- <path>: <message>`, or `- <message>` when the warning has no path. A line break of a path is written `\n`. The texts are the ones of the report, outside the parity rule: a warning that carries an error of the system (a storage that cannot be listed, a deletion or an upload that failed) has the text of the system of each implementation. A new candidate and an edit of a note that is not published do not make a plan stale. A plan that would stop on the rules of "The root names of the site" is refused at its computation, so no record of it is stored.

## A publication

The `publish` command applies exactly one plan. It takes the lock of the device first, and puts back what a publication that stopped halfway left (see "Failure cases"). After the check of the record, and before its first write into the copy, it writes its run journal (see "Failure cases"). Then:

1. First, the moves of `move`, in three phases, so that a move into a path that another move leaves, and a swap, lose no text: it reads the text of `notes/<from>` of each published note in the copy, then removes each `notes/<from>` that no move writes again, then writes the manifest entry of each move with its new path and its former paths (see "The rename journal") and `notes/<to>` with the text that it read, unless `to` is in `remove` or in `forcedRemove`: a forced removal can take the new path of a move. When a move fails, the publication stops, as when a forced removal fails. Then, for each note of `forcedRemove`, it removes `notes/<vault path>` (an unpublished note has no such file) and the manifest entry of the note. This is the takedown rule (PUB-84 of the spec): the note leaves the manifest with its former paths, so its URL answers 404 and no older name leads to it. When a forced removal fails, the publication stops: every file is put back as it was, nothing is committed, and the command fails. No note is published while a note under a guard stays live. The next steps read the manifest after the moves and the forced removals. After the notes of steps 2 and 3, the publication writes `renames.json` with the count of each journal that the plan read, in the same commit. When the plan has `edits`, it also writes `edits.json` in the same commit, with `published` raised by the number of events of `edits`: the next plan shows only the newer events. A publication never makes `edits.json`.
2. For each note of `publish` and of `update`, it first uploads each attachment of the note whose key the attachment storage does not have yet (PUB-39): it reads the file from the vault again, and uploads its bytes under its key. A file whose bytes no longer have the hash of the record is not uploaded, and the note is left out (rule 4): the file changed since the plan. The storage is listed one time, just before the first upload, and a key that this run uploaded is not uploaded again. A publication with no upload never lists it, so a takedown never waits for the storage. Then it writes the cleaned note to `notes/<vault path>` and the manifest entry of the note. The cleaned note that it writes is the text whose hash the record holds, and the entry holds the links and the attachments of the record.
3. For each note of `remove`, it removes `notes/<vault path>` and writes the manifest entry with the state `unpublished`.
4. The uploads and the two files of a note of step 2 or 3 are one unit, but for the `to` of a move: when its update fails, the publication stops as in rule 6, because the move already changed its files. When an upload or a write of the unit fails, the files of that note are put back as they were, the note is left out of the publication, and the report names it with the reason. The other notes are published. When the files of the note cannot be put back, the whole publication stops as in rule 6. An upload of a note that was left out stays in the storage until the cleanup of rule 8.
5. Every file that it wrote or removed goes into one commit, which is pushed without force. A write of a file that already has the text (Windows line ends aside) is no change. With nothing to commit, there is no commit and no push. Before the push, the commit is checked: its only parent is the commit of the copy before the run (or it has no parent, on a copy with no commit), and it changes exactly the paths that the run changed. Else another run changed the copy during the publication (after an `unlock`), the commit can miss a forced removal, and nothing is pushed: the commit is taken back. The push sends that commit by its hash (`git push origin <hash>:refs/heads/main`), not the branch of the copy, which another run can have moved. The undo moves the branch back only while it is still at that commit. The tool gives the paths to git on its standard input, not as arguments: a publication can hold more paths than one command takes. No file holds them, so the folder of the copy can be a relative path, and two publications on one copy share no file. A copy with no commit takes its first publication.
6. When the commit fails or the push is refused, the commit is taken back and every file of the publication is put back as it was. Nothing is published. A file that stayed in the copy would be read as published at the next run. The undo follows these rules:
    - A file is put back with the text that the tool read before it wrote the file, not from a commit: a copy can have no commit, and a file of the copy can be in no commit. A file that did not exist is removed. A removal needs no text: a file that cannot be read as text (not valid UTF-8, a link) is still removed, and when the publication fails, it is not put back by the run: the run journal stays, and the next `plan`, `publish` or `takedown` puts it back from git.
    - Only the paths of the publication are unstaged. Other staged work of the copy stays staged.
    - Each step runs, also when one fails (for example when git cannot write its index). The message of the command says what could not be put back.
    - Then every upload of the run whose key no published entry of the manifest lists is deleted from the attachment storage (PUB-93): an attachment never stays public without a manifest entry. A deletion that fails is named in the message, and the cleanup of rule 8 deletes the file at the next publication.

    The same undo runs when a forced removal fails (rule 1).

7. After a push that succeeded, the `public_note` property is corrected (see below). Also after a publication with nothing to commit, when a publication that stopped after its push still owes the correction (see "Failure cases").
8. After a push that succeeded, and after a publication with nothing to commit, the tool cleans the attachment storage: it takes the manifest as the run left it, lists the storage, and deletes every file whose name is not the key of an attachment of a published entry. An attachment whose file is under a guard now counts for no note, whatever the plan held (decision of the author, R45): its path is in a folder of the deny list, or a file with the same name, the letter case and the Unicode form ignored (the wider fold of rule 4 of section "Small letters"), is in a folder of the deny list (hidden names included, see rule 5 of the scan) and the scan has no file at its path with the hash of the entry. The file may have moved there, and another file may have taken its old path: names only, so the tool fails closed. A note that the plan held then shows its old text with a missing image until its next update (the file answers 500 with `no-store`, as a file of the release that is missing: it is never served). This removes the attachments of a forced removal and of an unpublish that no other published note uses (PUB-82, PUB-84), the old file of a changed attachment, the uploads of a note that was left out, and what an earlier cleanup could not delete. It reads no file of the storage. A deletion that fails gives a warning, with the name of the file as its `path`, and the next publication tries again. The copy follows the content store at that moment, because the run fetched it and was not behind. Another device that publishes at the same time can still lose an upload that it made before its push: the image of its note then answers 500 with `no-store` until the next update of the note (URL-33, issue 80). No guard opens. The same cleanup closes it: after the deletions, every key that a published entry uses and that the storage does not have is uploaded again, from the vault path of an attachment with that key, when the vault still has a file there with those bytes (decision of the author R46). The attachments of each published entry are tried in the order of the paths of the notes, then in the order of the list, and the first file with the right bytes is uploaded. Such an upload is in `attachmentsUploaded`, with a warning whose `path` is the vault path of the file. When no file of the vault has those bytes, nothing is uploaded, and a warning with the first of those vault paths says that the note shows the file as missing until its next update. A file under a guard now is never uploaded again: it counts for no note. So after a publication, every file that a published note uses is in the storage, also when another device deleted it, unless its cleanup ran after this one.

The message of the commit holds the counts, the device and the face that started the publication (PUB-29 of the spec). The skipped notes are the changed notes of the queue that the plan does not update and does not remove. "forced" counts the forced removals, and "moved" the moves. The message is outside the parity rule, like every text for a person, and both implementations write it in this form:

```text
Publish: 1 new, 2 updated, 0 removed, 0 forced, 1 skipped, 1 moved

Device: garden-shed
Face: command-line
Plan: 0123456789abcdef
```

The line `Plan:` names the plan of the run. The recovery of a run that stopped halfway finds the commit of that run by it (see "Failure cases").

The name of the device and the name of the face are inputs, like the time of the run. The name of the device is one line of text: it has no control character, and it is not empty and not only spaces (U+0020). The faces are `plugin`, `command-line` and `mcp-server`.

## The publication report

The result of the `publish` command, as data in the canonical form. Every list of paths is sorted by path, and every list of keys in the order of the code points.

| Key                   | Value                                                                                                                                                                                                                                                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `attachmentsDeleted`  | The keys of the files that the cleanup deleted from the attachment storage                                                                                                                                                                                                                                                              |
| `attachmentsUploaded` | The keys of the files that the publication uploaded to the attachment storage                                                                                                                                                                                                                                                           |
| `failed`              | The notes of the plan that were left out, each with its `path` and a `reason`                                                                                                                                                                                                                                                           |
| `forcedRemoved`       | The vault paths of the notes that were removed because a guard excludes them                                                                                                                                                                                                                                                            |
| `propertyRemoved`     | The vault paths of the notes whose `public_note` property was removed                                                                                                                                                                                                                                                                   |
| `propertySet`         | The vault paths of the notes whose `public_note` property was set                                                                                                                                                                                                                                                                       |
| `moved`               | The moves of the publication, each with `from` and `to`, sorted by `from`                                                                                                                                                                                                                                                               |
| `published`           | The vault paths of the notes that were published for the first time, or again after an unpublish                                                                                                                                                                                                                                        |
| `removed`             | The vault paths of the notes that were unpublished                                                                                                                                                                                                                                                                                      |
| `skipped`             | The vault paths of the changed notes that the plan did not update                                                                                                                                                                                                                                                                       |
| `updated`             | The vault paths of the published notes that were updated                                                                                                                                                                                                                                                                                |
| `warnings`            | What the author must know and what stopped nothing, each with its `path` and a `message`. A line of a journal that is not valid, and a journal that was cut or edited, give one with the name of the journal as its `path`; a move that does not happen gives one with the path of its note. A valid line that moves no note gives none |

The parity tests compare the lists of paths and of keys. The texts (`reason`, `message`) are outside the rule. `failed` is sorted by path like the other lists, not in the order of the plan. An upload of a note that was left out is in `attachmentsUploaded`, and in `attachmentsDeleted` when the cleanup deleted it.

## An unpublish

The `unpublish` command removes the named published notes through a normal publication, in one step (PUB-80, decision of the author R65). It makes the plan of the selection whose `remove` is the named paths, whose `hold` is every path of the list `changed` of the queue that is not named, and whose `include` is empty. It takes the lock of the device as `publish` does, puts back a publication that stopped halfway, fetches the content store (it stops without a network), computes the plan from that one scan, stores it as `plan` does, and applies it as `publish` applies a plan, with no second computation: the plan cannot be stale. It writes the publication report. So only the named notes leave, with the forced removals that every plan holds. The rules of the selection apply: a path that is not the path of a published note stops it, and so does a command with no path. A path named twice counts one time.

## A takedown

The `takedown` command removes the named notes from the content store at once, with everything that derives from them (PUB-81 to PUB-84, PUB-99, business rule 16, decisions of the author R65). It needs no plan. Each named path is the path of a manifest entry, published or unpublished: the note leaves the manifest with its former paths, so every address of the note answers 404 after the next build, also the addresses of an unpublished note that answered 410 (URL-28).

1. The command takes vault paths, at least one, the time of the run, the name of the device and the face. A path named twice counts one time. A path that is not a vault path stops it before it does anything. A path of no manifest entry stops it after steps 2 to 4, before its first removal: a mistake in a path must never look like a takedown that worked. The tool finds a note by its exact path only, and never guesses, but the message names the paths of the manifest with the same folded form (composed, small letters, see "The root names of the site"), also with the end `.md` added, because the site gives such an address to the note. It never says that the note is not published.
2. It takes the lock of the device, with `command` (`takedown`), and puts back what a publication that stopped halfway left, as `publish` does (see "Failure cases"). A lock that another run left stops it.
3. It checks the copy and fetches the content store as `publish` does (see "The content store"). When the copy is behind the content store, it stops with the message that says to pull (decision of the author R65: the tool does not pull by itself). Without a network, it stops.
4. It deletes from the attachment storage every file whose name is a key, or a key that is being written, and that no published entry of the manifest lists, as in step 7, before it reads the named paths. A takedown that stopped after its push left the files of its notes in the storage, and its notes have no entry any more, so a new takedown of the same paths stops at step 1, but cleans the storage first. The deletions and the warnings of this step go into the report with the ones of step 7, and a warning that both steps give is written one time. It reads no plan, scans no vault and asks no Starter Kit. A stale plan, a publication that failed, a deny list entry that names no folder, a missing Starter Kit and a note that cannot be read do not stop it (PUB-99).
5. Before its first write into the copy, it writes the run journal, as `publish` does: `paths` holds `notes/<vault path>` and the manifest file of each named note, and `plan` holds the id of the takedown, 16 hexadecimal digits of the SHA-256 of `{"manifest": <state.manifest>, "takedown": <the named paths, sorted>}` in the canonical form (`state.manifest` as in the record of a plan).
6. For each named note, it removes `notes/<vault path>` (an unpublished note has no such file) and its manifest entry. The removals go into one commit, which is checked and pushed as rules 5 and 6 of "A publication" say. When a removal, the commit or the push fails, every file is put back as it was, nothing is committed, and the command fails: nothing is taken down. The message of the commit:

    ```text
    Takedown: 1 note

    Device: garden-shed
    Face: command-line
    Plan: 0123456789abcdef
    ```

    The line `Plan:` names the id of the takedown, so the recovery of a takedown that stopped halfway finds its commit as it finds the commit of a publication.

7. After the push, it writes the journal `{"step": "correct"}`. Then it deletes from the attachment storage every file whose name is a key, or a key that is being written, and that no published entry of the manifest lists any more (PUB-82). It reads no file of the vault for this: a file under a guard that a published entry still lists stays until the cleanup of the next publication, and nothing is uploaded again. A name that is not a key stays, with a warning, as in rule 8 of "A publication". A storage that cannot be listed, and a deletion that fails, give a warning. As in the cleanup of a publication, an upload that another device made before its push can be deleted: that device uploads it again at its next publication (rule 8 of "A publication").
8. Then it removes the `public_note` property of each named note whose file is in the vault at exactly its path, by the rules of the correction of the property (a note in the flow form of YAML, or whose ignore property would read otherwise, is not written and gets a warning). It never reads or writes a file in a folder of the deny list of `configuration.json`. When that file cannot be read, no note is written, with a warning. A note that is not in the vault, or that has no such property, is left as it is.
9. Then it removes the journal, or leaves it `correct` when an earlier publication still owes its correction.

A warning of the attachment storage (steps 4 and 7) means that a file can still be public: it goes into `storageWarnings`, and the command writes its report, then ends with an error. A name that is not a key counts too: the folder can be the wrong one. A warning of the first cleanup about a file that the second one deleted is left out. A warning of the property goes into `warnings`, and the command ends with success. When a named path stops the takedown (step 1), its message says what the first cleanup deleted and the warnings that it gave, 20 of each at most.

A link to the note in another published note stays, as plain text (business rule 5): it is the text of the other note, and the manifest entry of the other note keeps the link path. After a takedown, the note is a candidate again when its file is in the vault (decision of the author R65): only a path of `include` publishes it again, with a new id and a new `firstPublished`. Copies in browser caches and at crawlers cannot be recalled (PUB-86). The text of the note stays in the history of the content store: the removal from the history is issue 103 (decision of the author R65).

The result of the command, as data in the canonical form. Every list of paths is sorted by path, and every list of keys in the order of the code points. The parity tests compare the lists.

| Key                  | Value                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| `attachmentsDeleted` | The keys of the files that the takedown deleted from the attachment storage                             |
| `propertyRemoved`    | The vault paths of the notes whose `public_note` property was removed                                   |
| `storageWarnings`    | What the attachment storage gave, each with its `path` and a `message`: a file that can still be public |
| `takenDown`          | The vault paths of the notes that left the content store                                                |
| `warnings`           | What the author must know about the `public_note` property, each with its `path` and a `message`        |

## The edits of the guards

Issue 42, decisions of the author R69. An agent reads and edits the guards through the command line program and the MCP server (GATE-07, GATE-40 of the spec). An edit that makes the tool stricter applies at once, unless it takes a note off the site. Every other edit is a proposal, which only the author confirms, in the view.

| Action     | Path   | What it does                                                          | Kind     |
| ---------- | ------ | --------------------------------------------------------------------- | -------- |
| `deny`     | Folder | Adds the folder to the deny list of `configuration.json`              | Stricter |
| `allow`    | Folder | Removes the folder from the deny list                                 | Looser   |
| `ignore`   | Note   | Sets the ignore property of the note: the line `publish_ignore: true` | Stricter |
| `unignore` | Note   | Removes the ignore property of the note                               | Looser   |

1. `allow` and `unignore` are always a proposal, whoever asks and whatever the request says (R69, decision 1). The tool cannot know that the author named the edit, and a looser guard plus one include would publish a private note with no person in between.
2. `deny` and `ignore` apply at once when they take no manifest entry away. Else they are a proposal, with the list `removes` (R69, decision 2): a forced removal is an unpublish or a takedown, and those need the author (PUB-54). `removes` is never guessed: the tool scans the vault two times, as it is and with the edit applied (the new deny list, or the note read as excluded by the ignore property), and `removes` is the paths of the forced removals (rule 3 of the plan) of the second scan that are not forced removals of the first one. So a published note that a line of a rename journal moves under the new guard, an unpublished entry whose note has a new name there, and a missing note with a name in the new folder all count, as the next publication would count them (review round 1). Both lists come from one read of the vault, of the journals and of the manifest: the tool computes the forced removals for the two sets of guards from that one read, so a write during the edit cannot make the two scans see other states.
    - A `deny` is also a proposal when it puts under the guard an attachment that a published entry uses (rule 8 of "A publication"): the next publication would delete that file from the attachment storage, and the note would show it as missing. The list `affects` names those published entries that are not in `removes`, sorted by path (decision of the author R69, review round 2). An `ignore` has no `affects`: it guards a note, not a file.
3. An edit stops, and writes nothing, in each of these cases:
    - The path is not a vault path. For `ignore` and `unignore`, it does not end in `.md` (in small letters).
    - `deny`: the path names no folder of the vault, with exactly that name (GATE-38), or it is already an entry of the deny list.
    - `allow`: the path is not an entry of the deny list.
    - `ignore` and `unignore`: the vault has no note at exactly that path, or the note is in a folder of the deny list (the tool never reads or writes a file there).
    - `ignore`: the guard of the ignore property already excludes the note, or its properties are in the flow form of YAML (the tool cannot add a line there). The author sets the property by hand.
    - `unignore`: the guard of the ignore property does not exclude the note, or it would still exclude the note after the removal of the property (rule 5 of the properties, with the key `publish_ignore`): the key is in the value of another property, in the flow form, or in a form that the removal does not touch. The author edits the note by hand.
    - An open proposal has the same action and the same path.
4. An edit reads no network for the reading command `guards`. The other commands take the lock of the device with `command` (`edit`), put back what a run that stopped halfway left, fetch the content store and stop when the copy is behind it, without a network too, as `publish` does. A deny list entry that names no folder does not stop an edit: an edit is how the agent corrects it (PUB-91), and such an entry lists no file.
5. An edit writes its event into `edits.json`, and `configuration.json` for a `deny` that applies, in one commit, which is checked and pushed as rules 5 and 6 of "A publication" say, with the run journal of "Failure cases" (`paths`: `configuration.json` and `edits.json`; `plan`: the id of the event). An edit that stopped after its push is put back as a publication is: the next run finds its commit by the line `Plan:` and leaves the journal `correct`, so the next publication runs a correction of the `public_note` property that has nothing to correct. It changes no note. When the commit or the push fails, the files are put back, and nothing is applied. The message of the commit:

    ```text
    Edit: deny (applied)

    Device: garden-shed
    Face: mcp-server
    Plan: 0123456789abcdef
    ```

6. An `ignore` that applies writes the property into the note first, by rules 5 to 9 of the properties with the key `publish_ignore` and the value `true`, then commits its event. When the commit or the push fails, the property stays in the note (a stricter guard is safe), the log has no event for it, and the message says both.
7. The author confirms or rejects a proposal in the view (the face `plugin`). The command line program and the MCP server cannot. Every confirmation opens a dialog: for a looser edit it says what opens, and for an edit with `removes` or `affects` it names, in full, the entries that would leave the content store and the published notes that would lose an attachment, computed again when the dialog opens. The confirmation checks the rules of rule 3 again, without the last one, and computes `removes` and `affects` again: when a list is not the one that the dialog showed, nothing is applied (as a stale plan), and the author opens the dialog again. A confirmed `deny` and `allow` write `configuration.json` with the event. A confirmed `ignore` writes the property first, as rule 6 says. A confirmed `unignore` commits its event first, then removes the property: when the write of the note fails, the guard stays closed, and the message says to remove the property by hand. A rejection writes its event only.
8. The deny list keeps its order: `deny` adds the folder at its end, and `allow` removes the entry. The tool writes `configuration.json` in the canonical form, with every other key of the file kept. A number with a fraction or an exponent, a negative zero (`-0`), or a whole number outside the range of rule 6 of the data, anywhere in the file, stops every `deny` in both implementations, also one that becomes a proposal, before the check of the open proposals: TypeScript cannot tell `1.0` from `1` or `-0` from `0`, so the two would write other bytes.
9. A write of the ignore property follows rules 3, 4, 5 and 6 of "The state property after a publication": the note is read again first, and it is not written when its text is not the text that the edit checked. When the guard would not exclude the note after the write (`ignore`), or would still exclude it (`unignore`), the note is not written and the edit stops. A write of the tool never leaves a guard in a state that the edit did not state.

`edits.json`, as data in the canonical form:

| Key         | Value                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| `edits`     | The events, in the order in which they were written. An event is never changed and never removed     |
| `published` | How many events of `edits` a publication showed: the plan shows the events after them (see the plan) |

An event:

| Key        | Value                                                                                                                                                                                   |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`   | `deny`, `allow`, `ignore` or `unignore`                                                                                                                                                 |
| `device`   | The name of the device of the run                                                                                                                                                       |
| `face`     | The face of the run: `plugin`, `command-line` or `mcp-server`                                                                                                                           |
| `id`       | 16 small hexadecimal digits of the SHA-256 of the event without `id`, in the canonical form                                                                                             |
| `path`     | The folder or the vault path of the note                                                                                                                                                |
| `proposal` | For `confirmed` and `rejected`: the `id` of the proposal                                                                                                                                |
| `affects`  | For `proposed` and `confirmed` of `deny`, when published entries use an attachment that the edit puts under the guard: their vault paths, sorted by path. No key when the list is empty |
| `removes`  | For `proposed` and `confirmed`, when the edit takes entries away: their vault paths, sorted by path. No key when the list is empty                                                      |
| `state`    | `applied` (a stricter edit that applied at once), `proposed`, `confirmed` or `rejected`                                                                                                 |
| `time`     | The time of the run                                                                                                                                                                     |

A content store without `edits.json` has no event, and `published` is 0. A `confirmed` or `rejected` event must have the face `plugin`. The tool reads the file strictly, as it reads the configuration: a file that is not valid stops every run, with a message that names it. `published` must not be above the number of events, an `id` must be the hash of its event, and a `proposal` must name an earlier `proposed` event that no other event decided.

The command `guards` gives, as data in the canonical form, the deny list (`denyList`), the open proposals (`proposals`, as in the queue) and the events since the last publication (`edits`, as in the plan). It reads the configuration without the check of GATE-38, so the agent can read a deny list that stops every publication. It stops while the lock of the device is taken, as `status` does. An edit command gives its event (`edit`).

What the rules cannot stop: an agent that writes the files itself, with no tool, or that calls the code of the plugin inside Obsidian (for example with `obsidian eval`) in the place of its MCP server. It can edit the property of a note in the vault, or edit `configuration.json` in the copy, commit it and push it. The skill of the tool forbids it. A looser guard still publishes nothing alone: a new note enters a plan only by `include`. A stricter guard written by hand takes notes off the site at the next publication.

## Failure cases

Decisions of the author R46 (issue 36). The lock and the run journal are files of the device, in the git folder of the copy: `.git/vault-publish/lock` and `.git/vault-publish/journal.json`, next to the stored plans. They are never in a commit and never in the vault. They are data in the canonical form, because a run of one implementation can stop and the next run can be the other one. The parity rule does not compare them.

The device opt-in of the spec (TOOL-11, story 96) is dropped by the author: every device with a copy of the content store can publish.

### The lock

One publication at a time on a device, for every face (TOOL-09, PUB-27 of the spec). Between devices, the refused push is the lock.

1. `publish` takes the lock before it reads anything: it makes the file `lock` only when no such file exists (one create, never a test and then a write). The file holds `command` (`publish`, or `takedown` for a takedown, or `edit` for an edit of the guards, which take the lock in the same way), `device`, `face` and `time` of the run, `process`, the id of the process of the run, and `token`, a value that no other run has (two runs of one process in the same second never hold the same text). A `plan` that puts the copy back takes the lock too, with `command` (`plan`), `process` and `token` only. The tool makes the folder `vault-publish` only inside a `.git` folder that exists: a folder that is not a copy gets no file.
2. When the file exists, `publish` stops and changes nothing. `status` and `plan` stop too, with the content of the lock: the files of the copy can be half written. Two plans or two status at the same time are allowed.
3. A run removes the lock at its end, after a success and after every failure that it reports, but only when the file is still its own lock (the same text): it never removes the lock of another run.
4. A run that stops halfway (a crash, a power cut) leaves the lock. The tool never removes a lock by itself: the `unlock` command (`unlock --content-store <folder>`) removes it, and says whether a lock was there. Then the next `plan`, `publish` or `takedown` puts the copy back. The author runs `unlock` only when no publication runs.
5. A publication checks that the lock is still its own before its first write into the copy, before its commit, and after its push. When it is not (the author ran `unlock` while it ran, and another run took the copy), it stops and touches the copy no more: it puts no file back (it would put them back over the work of the other run), deletes no upload, corrects no property, and never removes the journal or the lock of the other run.
6. A check of the lock is a read at one moment, so the commit itself is checked too: see rule 5 of "A publication".
7. The recovery of a run that stopped halfway (by `plan`, `publish` or `takedown`, see "The run journal") checks that the lock is still its own before each step that writes into the copy or its git state (each put back of the paths of the journal, with their removal from the index and the removal of the index of an empty clone; the move of the branch; the fetch of the content store) and before it writes or removes the journal (issue 75). When it is not, it stops with the message of rule 5 and changes nothing more: the journal stays for the next run. A lost lock after the move of the branch leaves the branch moved and the paths as they were; the next run sees the branch at the commit of the journal and puts the paths back.

### The run journal

A publication that stops halfway, between its first write into the copy and the end of its push, gives the same result when it is run again (TEST-15 of the spec).

Before its first write into the copy, `publish` writes the journal:

| Key              | Value                                                                                                                                                                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `correctionOwed` | `true` when an earlier publication stopped after its push and the correction of the property is still owed                                                                                                                                                        |
| `head`           | The commit of the copy before the run. No key when the copy has no commit                                                                                                                                                                                         |
| `paths`          | Every path of the content store that the run can write or remove: `notes/<vault path>` and the manifest file of each note of the plan or of the takedown, `notes/<to>` of each move, and `renames.json` when the plan reads a line, each one time, sorted by path |
| `plan`           | The id of the plan, or of the takedown                                                                                                                                                                                                                            |
| `step`           | `write`                                                                                                                                                                                                                                                           |

After its push succeeded, the publication writes the journal `{"step": "correct"}`. After the correction of the property and the cleanup of the storage, it removes the journal. A publication with nothing to commit writes no journal, and removes a journal `correct` after its correction. After a failure that it reports, the files are put back as rule 6 of "A publication" says, and the journal is removed (or written `correct` again when the correction was owed).

At the start of `plan` and of `publish`, after the check of the lock, the tool reads the journal:

1. No journal: nothing to do.
2. `correct`: the copy is the content store, and nothing is put back. The next `publish` corrects the property after its own work, also with nothing to commit, then removes the journal.
3. `write`, and the commit of the copy is still `head` (or the copy still has no commit): the run stopped before its commit. Each path of the journal gets the bytes that it has in `head`, in the work tree and in the index, and a path that `head` does not have is removed from both. Then the journal is removed, or written `correct` when `correctionOwed` is `true`.
4. `write`, and the copy has another commit, which has `head` in its history (or any commit, when there was no `head`): the author can have pulled since. The commit of the run is the first commit after `head` on the line of first parents up to the commit of the copy, when its message has the line `Plan: <plan>` of the journal and it changes only paths of the journal. When there is no such commit, the run stopped before its commit and other commits came after `head`: each path of the journal gets the bytes that it has in the commit of the copy, as in case 3. When there is one, the tool fetches the content store. When the branch `main` of the content store has that commit, the push arrived: the journal is written `correct`. Else, when it is the commit of the copy, it is taken back (the branch of the copy goes back to `head`, or loses its commit) and the paths are put back as in case 3. Without a network, `plan` and `publish` stop in this case: the tool cannot know if the push arrived.
5. `write`, and `head` is not in the history of the commit of the copy, or the commit of the run did not arrive and other commits are on top of it: the tool stops, and the author corrects the copy by hand.

A commit of another device whose parent is `head` is never taken for the commit of the run: its message has no line `Plan:` of this plan, or it changes other paths. Each path is put back as the last commit has it, so the files of a forced removal are never lost from the copy before the commit that removes them.

`plan` takes the lock while it puts the copy back, so a publication cannot start in the middle. `status` writes nothing: with a journal `write`, it stops and says that the next `plan`, `publish` or `takedown` puts the copy back. With a journal `correct`, it gives the queue.

The tool never pushes an old commit: a commit that did not arrive can be older than a guard that the author added since (PUB-94 of the spec is changed so). The uploads of the stopped run that no published note uses go at the cleanup of the next publication. A publication whose plan is stale runs the cleanup of the storage before it stops (the run fetched, and the copy follows the content store), so a file that came under a guard leaves the storage also then. A publication that stops earlier (no network, a lock, a copy that differs from its commit) cannot clean the storage: the file stays until a later publication.

A crash of git itself can leave `.git/index.lock` in the copy. Git then refuses every command, and the message of the tool gives the message of git: the author removes that file by hand when no git command runs.

## Notes and their properties

The two implementations read and write the properties of a note as lines of text. They use no YAML library, because two libraries never agree on every byte.

Reading:

1. The byte order marks at the start of a note are not part of its first line: one mark, or more. A write keeps them.
2. A note has properties when its first line is `---`, with nothing after it but spaces and tabs, and a later line is `---` in the same form. The lines between the two are the properties. A carriage return at the end of a line is not part of the line.
3. A line names a key when it holds, in this order: an optional quote (`"` or `'`), the key, an optional quote, optional spaces and tabs, and a colon. The value is the text after the colon, without the spaces and the tabs around it. No other character is removed.
4. A property of the note itself starts at a line that names its key with no space and no tab before it. It goes on over the next lines that begin with a space, a tab or a hyphen.

The ignore property is read to fail closed. The guard excludes a note when a line of the properties holds `publish_ignore` anywhere, in any case of its ASCII letters, unless that line names the key (rule 3, also after spaces and tabs) with the value exactly `false`. So `true`, `yes`, `"true"`, a value on the next line, a comment after the value, a nested key, properties in one line of JSON (`{ "publish_ignore": false }` too), a complex key of YAML (`? publish_ignore`), a longer key and the key in the value of another property all exclude the note. When the first line opens the properties and no line closes them, every line of the note is read for the guard. The guard reads the properties two times: with the rule 2 above, and with fence lines that may also end in carriage returns (a line `---` with two carriage returns before its line feed). The key in either reading excludes the note. Obsidian 1.15.1 opens properties only on a first line `---` and one line end (its test `^---(\r?\n)`), so the second reading fails closed and never opens a guard that the first one closes. Not read: a key that YAML spells with escapes (`"publish\x5fignore"`) or folds over two lines in quotes. Obsidian writes no such key.

The deny list guard excludes a note when its vault path starts with an entry of the deny list and a slash.

Writing the state property (`public_note`):

5. To remove the property is to remove every property of the note itself that names the key, with its lines. When the properties then hold no line, the two `---` lines are removed too: the note has no properties any more, as when the last property is removed in Obsidian. The two lines stay when the text below them would then be read as properties (it starts with a `---` line, after byte order marks, and has a later one): a text of the author never becomes properties. A note that does not name the key is not changed.
6. To set the property is to remove it, then to write the line `public_note: true` in the place of the first one that was removed. When there was none, the line becomes the last line of the properties.
7. A note without properties gets the three lines `---`, `public_note: true`, `---` before its text, after its byte order marks when it has them.
8. Every line that is kept keeps its own line end. A new line takes the line end of the first line of the note, and a line feed when the note has no line end.
9. A note whose text would not change is not written.

The properties are in the flow form of YAML when they are closed and a line of them starts with `{` or `[`, after optional spaces and tabs (`{ "tags": ["a"] }`, also `tags:` with `[a, b]` on the next line). A line that the tool adds below such a line is not valid YAML. So the tool never writes the state property into a note in that form (see "The state property after a publication").

## Cleaned notes

A cleaned note is Markdown text, in the encoding of this document.

1. The source of a note is its text in the vault, without the byte order marks at its start, without the `public_note` property, and without properties that hold no line (`---` and `---` with nothing between them, under the exception of rule 5 of the properties). Then each pair of a carriage return and a line feed is replaced by a line feed, and the byte order marks at the start of the result are removed too (the text below removed properties can start with one). The property is removed from the text as the vault has it, before the line ends change, so the source reads the properties as the write reads them. That property is the state in the vault, not content. So the source of a note is the same before and after the tool writes the property, also for a note without properties, and a correction of the property never makes a note "changed" (PUB-14 of the spec). The shared cases check it: each note of the `source` cases has the same source after the property is set.
2. Version 1 of the cleaning step changes nothing more: the cleaned note is the source.
3. Version 2 resolves the links of the note (PUB-87 of the spec). It changes no character of the text: the cleaned note is still the source, and a link stays as the author wrote it, with its link text (PUB-89). The result is the list `links` of the manifest entry, which says to which note each link leads. The section "The links of a note" has the rules.
4. Version 3 also resolves a link to a file that is not a note, and collects the attachments of the note (PUB-37). It still changes no character of the text. The result is the list `attachments` of the manifest entry. The section "The attachments of a note" has the rules.
5. Version 4 also reads the aliases of the note (URL-02 of the spec). It still changes no character of the text. The result is the list `aliases` of the manifest entry. The section "The aliases of a note" has the rules.
6. Version 5 reads comments and blank lines inside the list `aliases` as YAML does (issue 80, decision R48 of the author): an item that is a comment gives no alias, and a comment line or a blank line does not end the list. It still changes no character of the text.
7. The ticket that adds a rule to the cleaning step writes it here before the second implementation is written, and raises the version.

No content store was written with version 1 outside the tests, so the tool reads no manifest entry without `links`. In the same way, no store was written with version 3 or earlier outside the tests, so the tool reads no manifest entry without `aliases`.

## The links of a note

The build never reads the vault, so the tool says to which note each link of a published note leads (PUB-87, TOOL-07 of the spec). The Rust program cannot ask Obsidian. So the rules are written here, and they follow what Obsidian does (its function `getLinkpathDest`, read in November 2026).

### The link paths of a note

A link path is the part of a link that names its target. The tool reads the source of the note line by line, the properties included. It does not read Markdown: a link in a code block, in a comment or in a property is read like every other link. A link path that the page never shows as a link does no harm, because the build asks only for the links that it renders.

1. A wikilink or an embed. The tool looks for the first `]]` of the line, then for the last `[[` before it. The text between the two is the inner text. The search goes on after the `]]`. A `]]` with no `[[` before it gives nothing.
2. The target of the inner text is its part before the first `|`. When a backslash stands just before that `|`, the backslash is not part of the target (a link in a table). Each no-break space (U+00A0) of the target becomes a space (U+0020), as in Obsidian. Then the white space at the two ends of the target is removed. White space is here what `trim` of JavaScript removes, because Obsidian uses it: U+0009 to U+000D, U+0020, U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF. Both implementations hold that list, and no function of a language stands for it.
3. The link path of a wikilink is its target up to the first `#`. No other character is removed.
4. A Markdown link. The tool looks for each `](` of the line. After it and after optional spaces and tabs comes the destination. When the destination starts with `<`, it is the text up to the first `>`, without the spaces and the tabs at its two ends. Without a `>` on the line, the link is not read. Else it ends before the first space, the first tab, or the first `)` that closes no `(` of the destination. When neither comes, it ends with the line.
5. A destination is read only when it is not empty, does not start with `#`, and does not start with a scheme: an ASCII letter, then ASCII letters, digits, `+`, `-` and `.`, then a colon.
6. The destination is decoded as a whole: each run of `%` and two hexadecimal digits is read as bytes of UTF-8. A sequence that gives one of the characters `; / ? : @ & = + $ , #` stays as it is written. When a `%` is not followed by two hexadecimal digits, or the bytes are not valid UTF-8, the destination is not decoded at all. This is what `decodeURI` does.
7. In the decoded destination, each no-break space becomes a space, and the white space of rule 2 at its two ends is removed. The link path of a Markdown link is that text up to the first `#`.
8. An empty link path names the note itself. It is no link to another note and is left out.
9. Not read: a reference link (`[text][name]` with its definition on another line) and a bare URL.
10. Obsidian also converts a link to the composed Unicode form (NFC). The tool does not: a link path is compared as it is written (see "Paths"). The slice of the URL contract decides the Unicode forms.

### The target of a link path

The inputs are the link path, the vault path of the note that holds the link, and the files of the vault: the notes and the other files of the scan, and the files of the folders of the deny list, which the tool knows by their paths alone (rule 5 of the scan). A file under a guard is a candidate like every other file, so that a link which Obsidian leads to it does not lead to another file of the same name. It never gets an item: see the list `links` and the attachments of a note.

The letter case is ignored: the link path and each vault path are compared in small letters (section "Small letters", on the whole text). The name of a path is its part after the last slash. The folder of a path is its part before the last slash, and the empty text for a note at the root.

1. `r` is the link path in small letters. The candidates are the files whose name is the name of `r`, notes and other files alike. Without such a file, `.md` is added to `r`, and the candidates are the files whose name is the name of the new `r`. Without a candidate, the link path has no target. So a file that is not a note comes first, as in Obsidian: `[[plan.png]]` leads to the file `plan.png`, also when a note `plan.png.md` exists.
2. When `r` holds no slash and there is one candidate, that file is the target.
3. `s` is the folder of the note that holds the link, in small letters. When `r` starts with `./` or `../`, it is made a path from the root. A `./` before a `../` is dropped. For `./`, the `./` is dropped. For `../`, each `../` at the start is dropped, and `s` becomes its own folder each time. Then, when `s` is not empty, a slash is added to the end of `s`, and `r` becomes `s` and then the rest. A candidate whose path is `r` is the target. `s` keeps its new value for step 6.
4. A slash at the start of `r` is dropped. A candidate whose path is `r` is the target.
5. When the link path starts with a slash, it has no target.
6. Else the candidates whose path ends with `r` stay. The ones whose path starts with `s` come first, then the others. Inside each group, the shorter path comes first, counted in UTF-16 units as Obsidian counts, then the order of the code points. The first candidate is the target. Without one, the link path has no target.

Where several candidates fit a step, the first one in the order of the code points of their vault paths is taken. Obsidian takes the one that it loaded first, which no rule can give.

In steps 3 to 6, "starts with" and "ends with" compare texts, not path parts, as Obsidian does.

### The list `links`

1. Each link path of the note whose target is a note gives one item: `link` is the link path, and `path` is the vault path of the target, as the vault gives it. A target that is not a note is an attachment (see below), or nothing.
2. A target that a guard excludes gives no item: a file in a folder of the deny list, and a note that the ignore property excludes. So the tool writes no path of a note under a guard into the content store. An entry that was written before the guard came holds the path until the next update of its note: that update is a technical update of rule 5, and the author can hold it like every update.
3. Each link path is in the list one time. The list is sorted by `link`, in the order of the code points.
4. The state of the target is not an input: a target that is not published has its item like every other. The build makes a link only when the manifest has a published note at that path, and shows the link text as plain text in every other case (PUB-89, BUILD-05). So a link appears when its target is published, with no change to the note that holds it.
5. The links of a published note are computed again at each scan. When they are not the `links` of its manifest entry, the note is a technical update (see the publication queue).

## The attachments of a note

An attachment is a file of the vault that is not a note and that a link of a note leads to, with the rules of "The target of a link path" (PUB-37, STORE-06). Every kind of file can be one: an image, a video, a PDF, a canvas, a base. The author selects the note, and the note uses the file (decision R45).

1. Each link path of the note whose target is not a note gives one item of the list `attachments` of the manifest entry, with these keys:

    | Key      | Value                                                                           |
    | -------- | ------------------------------------------------------------------------------- |
    | `hash`   | `sha256:` and the SHA-256 of the bytes of the file, in small hexadecimal digits |
    | `height` | The height of the image in pixels, when rule 5 knows it                         |
    | `link`   | The link path, as in the list `links`                                           |
    | `path`   | The vault path of the file, as the vault gives it                               |
    | `size`   | The number of bytes of the file                                                 |
    | `width`  | The width of the image in pixels, when rule 5 knows it                          |

    The key of the file in the attachment storage is the hash without `sha256:`.

2. A target that a guard excludes gives no item: a file in a folder of the deny list is never an attachment (GATE-42).
3. A target whose name ends in `.md` in another letter case (`Draft.MD`) is not a note and is never an attachment: it gives no item. A note is read for the ignore property, and such a file would pass that guard as an attachment.
4. Each link path is in the list one time. The list is sorted by `link`, in the order of the code points. Two link paths that lead to one file give two items with one hash.
5. The width and the height come from the first bytes of the file, whatever its name says. Both are whole numbers above 0, else the item has neither. The forms (all numbers without a sign, "BE" with the high byte first, "LE" with the low byte first):
    - PNG: the 8 bytes `89 50 4E 47 0D 0A 1A 0A`, then the bytes 12 to 15 are `IHDR`. The width is the 4 bytes BE at 16, and the height the 4 bytes BE at 20.
    - GIF: the 6 bytes `GIF87a` or `GIF89a`. The width is the 2 bytes LE at 6, and the height the 2 bytes LE at 8.
    - WebP: `RIFF` at 0 and `WEBP` at 8. With `VP8 ` at 12 and the 3 bytes `9D 01 2A` at 23, the width is the 2 bytes LE at 26 and the height the 2 bytes LE at 28, each one with its 14 low bits only. With `VP8L` at 12 and the byte `2F` at 20, the 4 bytes LE at 21 hold the width less 1 in their 14 low bits, and the height less 1 in the next 14 bits. With `VP8X` at 12, the width is 1 more than the 3 bytes LE at 24, and the height 1 more than the 3 bytes LE at 27.
    - JPEG: the 2 bytes `FF D8`. Then the segments follow, from byte 2. A segment starts with the byte `FF`. More bytes `FF` can follow it, and the next byte is its marker. A marker `01` or `D0` to `D7` has no length. A marker `D9` or `DA` ends the reading with no size. Every other marker is followed by a length of 2 bytes BE, which counts itself and the data, and is at least 2. The markers `C0` to `CF`, but for `C4`, `C8` and `CC`, hold the size: after the 2 bytes of the length comes 1 byte, then the height in 2 bytes BE, then the width in 2 bytes BE. A byte where a segment must start that is not `FF` ends the reading with no size.
    - The rotation of a JPEG: a segment `E1` before the segment of the size, whose data starts with the 6 bytes `Exif`, `00`, `00`, holds a TIFF block after them. Its first 2 bytes are `II` (numbers LE) or `MM` (numbers BE), then the number 42 in 2 bytes, then the place of the first list of tags in 4 bytes, counted from the start of the block. The list starts with its number of tags in 2 bytes, and each tag has 12 bytes: its number in 2 bytes, its type in 2 bytes, its count in 4 bytes, and its value. The tag `0112` with the type 3 and the count 1 has its value in the 2 bytes at 8 in the tag. A value from 5 to 8 says that the image is turned by a quarter: the width and the height change places. Only the first such segment counts. A block that is cut, or that does not have this form, says nothing of the rotation.
    - Every other file, and a file that is cut before the bytes of its size, has no size. A size that the bytes do not hold is never guessed: an SVG has no size here.
6. The attachments of a published note are computed again at each scan, with the bytes of each file. When they are not the `attachments` of its manifest entry, the note is a technical update (see the publication queue). So a file that the author changes, adds, moves or removes, or that comes under a guard, gives a technical update of each published note that links to it, and the publication writes the new hash and the new size.
7. The state of the attachments is not in the cleaned note: the build reads it from the manifest.

The shared cases are in `fixtures/canonical/links.json` (which file a link leads to) and `fixtures/canonical/images.json` (the bytes of a file and the size that rule 5 gives).

## The aliases of a note

An alias is another name of a note: a URL with the alias leads to the note (URL-02 and URL-24 of the spec). The tool reads the aliases from the source of the note, as lines of text, with the rules of "Notes and their properties".

1. Only closed properties are read (rule 2 of the properties). A note without them has no alias.
2. A property of the note itself (rule 4 of the properties) whose key is exactly `aliases` (rule 3, the letter case as written) holds aliases. No other key is read: not `alias`, not `Aliases`. When two properties name the key, both are read.
3. The value of the property:
    - Empty, or a comment (it starts with `#`, a rule added before any content store outside the tests had version 4): the items are the next lines of the property that start with a hyphen after optional spaces and tabs, and with a space, a tab or nothing after that hyphen. An item is the text after the hyphen. Every other line of the property is skipped. Here a line that is empty, or that starts with `#` at its first character, does not end the property (rule 4 of the properties): it is a comment or a blank line of YAML, and it is skipped (version 5). Only the reader of the aliases reads so: the guard and the write of the state property keep rule 4.
    - Starts with `[` and ends with `]`: a list in the flow form. The text between them is cut at each comma, and each piece is an item. A piece that starts with a quote, after spaces and tabs, goes on to its closing quote first: a comma inside it does not cut. In double quotes, a backslash takes the next character with it. In single quotes, `''` is no closing quote.
    - Any other value: one item.
4. An item, without the spaces and the tabs around it:
    - An item that starts with a quote and has a comment after its closing quote (`"One" # c`): the comment is cut first, as YAML does, and the rules below read what is left (version 5).
    - In double quotes (it starts and ends with `"`, and is at least 2 characters long): the text between them, where `\"` is `"` and `\\` is `\`. An item with another backslash escape gives no alias: YAML would read it in a way that these rules do not write.
    - In single quotes (it starts and ends with `'`, at least 2 characters): the text between them, where `''` is `'`.
    - An item that starts with `#`: a comment, which gives no alias (version 5). YAML reads `- # c` as an empty item.
    - Any other item: the text before the first space or tab that is followed by `#` (a comment), without the spaces and the tabs at its end.
    - An empty result gives no alias.
5. A reserved alias gives no alias: an alias whose first part (the text before its first slash, or the whole alias when it has none) is a reserved root name (see "The root names of the site"). The reserved file of the site always wins over the alias. The publication of the note goes on, and the report has a warning for each reserved alias of each note that it publishes or updates, with the vault path of the note as its `path` (decision of the author, R47).
6. The list `aliases` of the manifest entry holds each alias of the note one time, sorted in the order of the code points. The warnings name each reserved alias one time, in the same order.

These rules are not YAML, and both implementations follow them in the same way. A list in the flow form with a comment after it (`[a, b] # c`) or over two lines gives one plain item, `[a, b]` or `[a,`. Obsidian writes neither, and the published notes of the author have none. Two more cases are not YAML: a block scalar or a text over several lines inside the list (`- |`, or a more indented line after an item) gives one item per line that starts with a hyphen, also after a blank line; and a line that is only a carriage return (from `\r\r\n`) is not blank, so it ends the list, and a carriage return at the end of an item stays in the alias. No published note of the author has any of them (issue 80).

The shared cases are in the list `aliases` of `fixtures/canonical/properties.json`.

## The root names of the site

The site answers some names at its root itself: `robots.txt`, the sitemaps, `llms.txt`, the files of the search engines, `/-/` (URL-08 and URL-09 of the spec). A note must never take one of them.

1. A root name is reserved when, with its ASCII capital letters in small letters, it is `-`, it starts with `.`, or it ends in `.html`, `.ico`, `.json`, `.txt` or `.xml`. That covers the files that the spec names (`robots.txt`, `sitemap.xml`, `sitemap-*.xml`, `llms.txt`, the key file of IndexNow, the files of the search engines, `.well-known/`) and the ones that a later slice adds.
2. The folded form of a text: the text in the composed Unicode form (NFC), then in small letters (section "Small letters"), then in the composed form again (a small letter can make a pair that NFC composes: `J` and U+030C give U+01F0). Two texts that have one folded form are one URL for the resolver, which ignores the letter case and the Unicode form of a request. Before issue 73 the two languages disagreed on 20 code points (among them U+A7DD, U+AB6C, U+AB6D and code points between U+1DF40 and U+1DF7E), which only Rust changed; the table gives both the small letters of JavaScript.
3. A plan that publishes a note (its list `publish` is not empty) stops, with a message that names the note:
    - when the file name of a note of `publish` (without `.md`) or the first folder of its path is a reserved root name;
    - when two different texts among the published notes after the plan have one folded form. The texts are the vault path of each note without `.md`, and each folder of those paths. The published notes after the plan are the published entries of the manifest, without the notes of `forcedRemove` and of `remove`, with the notes of `publish`. A note and a folder with the same text are not two texts: the note wins (URL-16 of the spec).
4. A plan without a new note never stops on these rules, so a plan without paths always applies its forced removals. A plan that includes a new note that breaks a rule stops with its forced removals: the next plan without that note applies them, as with every other refusal of a selection. A published note of a store written with this version passed the rules when it was published, and an update does not change its path. No content store was written with an earlier version outside the tests.
5. Two notes with one file name in two folders are allowed. The URL with the file name alone then leads to no note, and the "not found" page names both (decision of the author, R47).

The shared cases are in `fixtures/canonical/names.json` (`reserved`: a name and whether it is reserved; `folded`: two texts and whether they have one folded form). The queue scenarios hold plans that stop on these rules.

## The note type of a note

Decision of the author R61 (issue 49). The note type of a note is the type that the Obsidian Starter Kit plugin of the vault gives it. The tool does not recognize a type itself. It asks the Starter Kit, which knows its own rules (its mappings, the priority of tags, the more specific type):

1. The TypeScript implementation asks the API of the plugin in Obsidian: `recognizeNoteTypes(paths)` of `app.plugins.plugins['obsidian-starter-kit'].api`. The plugin gives the answer inside its result (`success` and `data`).
2. The Rust implementation runs the command line program of the plugin, `osk-cli recognize --vault <vault>`, with the paths on its standard input, one per line. By default the program is `osk-cli` (`osk-cli-windows-x64.exe` on Windows) in the plugin folder that `osk-cli` itself takes: the folder `.obsidian/plugins/obsidian-starter-kit` when it has a `data.json`, else the first folder by name whose `manifest.json` has the id `obsidian-starter-kit` and that has a `data.json`, else the folder named by the id, else the first folder with that id; the option `--osk-cli` names another one. A program that does not end within 300 seconds, or whose output does not end within them, is stopped, and the run stops with it: `publish` holds the lock of the device while it waits.
3. Both faces give the same answer, as JSON: an object with `noteTypes`, a list of the types that the answer names (each with a text `name`, its canonical name, a text `displayName`, a text `prefix` and a text `suffix`, empty when the type has none, and other keys that the tool ignores), and `notes`, a list with one item per path that the tool asked for, in the order of the question, each with its `path` and its `noteType`: the `name` of a type, or `null` when the note has no type.

The tool asks for the published notes that the scan found (`status`, `plan`, `publish`: a published note gets the type that it has now), then, in `plan` and `publish`, for the notes of `publish` of the plan. It asks one time per question, with the paths in the order of the canonical form, and never for a note that a guard excludes. A path that holds a line feed or a carriage return is never asked, because the program reads one path per line: such a note has no type, in both implementations (issue 49, first review). It reads the answer strictly, and the run stops, with nothing planned and nothing published, in each of these cases (decision R61: every type would else leave the site):

1. The Starter Kit is missing: the plugin is not enabled in Obsidian or has no `recognizeNoteTypes` (it needs a newer version), or the program cannot be started, or it ends with an error. The message says so.
2. The answer is not such an object: `notes` does not hold exactly one item per path of the question, in its order; a `noteType` is not a text and not `null`; a type that a note names is not in `noteTypes`, or is there two times; a `name` is not a canonical name (a small letter, then small letters, digits, `-` and `_`, 64 characters at most); a `displayName` is empty; a `prefix` or a `suffix` is not a text.

The note type of a note, as data, is an object: `name`, `displayName`, and `prefix` and `suffix` only when they are not empty, as the Starter Kit gives them (a token such as `{{date}}` stays as it is). A note with no type has no such object. The manifest entry holds it as `noteType`, and the record of a plan holds it for each note of `state.notes`. A published note whose type is now another one, or whose type has another `displayName`, `prefix` or `suffix`, is a technical update (rule 2 of the queue).

In the tests, a face of the tests answers from a file in place of the Starter Kit (`fixtures/note-types.json` for the fixture vault): an object with `noteTypes`, the list of the types, and `notes`, the `name` of the type of each vault path; a path that the file does not name has no type. The TypeScript face of the tests reads it with `fileNoteTypes()` of `apps/plugin/src/publishing/node/device.ts`. The debug build of the Rust program reads it when the switch `DSEBASTIEN_VAULT_PUBLISH_TEST_NOTE_TYPES` names the file (`none`: no note has a type); the release build has no switch. Both read the file again at each question, so a test can change it between two runs, and a missing file is a missing Starter Kit. When a test names a file for the questions (the second argument of `fileNoteTypes()`, the switch `DSEBASTIEN_VAULT_PUBLISH_TEST_NOTE_TYPES_ASKED`), both add each question to it, as one line of JSON (the list of its paths), before they read the answers, so that a test sees which notes were asked, also of a missing Starter Kit. A queue scenario checks them with a step `asked`: the questions since the last such step, in their order.

The shared cases are in `fixtures/canonical/note-types.json`: answers with the note types that each must give, and answers that must stop the run.

## The manifest entry

One file per published note, as data in the canonical form.

| Key               | Value                                                                                                                                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aliases`         | The aliases of the note that get a URL, each one time, in the order of the code points (see "The aliases of a note")                                                                                     |
| `attachments`     | The attachments of the note: for each link to a file that is not a note, its `link`, `path`, `hash`, `size` and the size of an image, sorted by `link` (see above)                                       |
| `cleanedHash`     | `sha256:` and the SHA-256 of the cleaned note, in small hexadecimal digits                                                                                                                               |
| `cleaningVersion` | The version of the cleaning step that made the cleaned note: a whole number from 0                                                                                                                       |
| `firstPublished`  | The time of the run of the first publication                                                                                                                                                             |
| `formerPaths`     | The vault paths that the note had before, in the order in which they were added                                                                                                                          |
| `id`              | The identity of the note: 16 hexadecimal digits of the SHA-256 of its vault path, a line feed and the time of its first publication                                                                      |
| `lastPublished`   | The time of the run of the last publication                                                                                                                                                              |
| `links`           | The links of the note that lead to a note: for each one its `link` and the `path` of its target, sorted by `link` (see below)                                                                            |
| `noteType`        | The note type of the note (see "The note type of a note"). An entry of a note with no type has no such key                                                                                               |
| `path`            | The vault path of the note                                                                                                                                                                               |
| `sourceHash`      | `sha256:` and the SHA-256 of the source of the note                                                                                                                                                      |
| `state`           | `published`, or `unpublished` after the note was removed by a publication                                                                                                                                |
| `updateHeld`      | `true` when a move of a rename journal put the note at a path whose note had another source: its update waits until a selection includes it (decision R67). An entry with no held update has no such key |

The entry of a note at a publication:

1. A note that is published for the first time gets a new entry. `firstPublished` and `lastPublished` are the time of the run.
2. A note that was unpublished and is published again keeps its entry: its `id`, its `firstPublished` and its `formerPaths` stay. Its state is `published` again, `lastPublished` is the time of the run, and the publication writes `aliases`, `cleanedHash`, `cleaningVersion`, `links`, `attachments`, `noteType` and `sourceHash`.
3. An update writes `aliases`, `cleanedHash`, `cleaningVersion`, `links`, `attachments`, `noteType` and `sourceHash`, and removes `updateHeld`. A publication of a note that was unpublished removes it too. `lastPublished` is the time of the run when the hash of the source changed. A technical update does not move it (PUB-24 of the spec).
4. An unpublish changes the state only. The entry keeps its `attachments`, but an unpublished note uses no file of the attachment storage.
5. A forced removal removes the entry, also the entry of an unpublished note (decision R64).
6. A move writes `path` and `formerPaths` only (see "The rename journal"), and `updateHeld` when the note at the new path has another source than the entry and is not updated. A note that comes back to a former path loses that former path.

The manifest is read strictly. The tool stops in each of these cases:

1. A file of `manifest/` cannot be read, or is not an entry with every key of the table (`noteType` and `updateHeld` aside), or `updateHeld` is not `true`.
2. The `id` of an entry is not 16 hexadecimal digits, or the file is not named `manifest/<id>.json`.
3. The `path` of an entry is not a vault path that ends in `.md`. The tool removes `notes/<path>` at an unpublish, so a path in another form could name a file outside the notes.
4. Two entries have the same `path`.
5. An item of `links` is not an object with exactly a text `link` and a `path` that is the vault path of a note.
6. An item of `attachments` is not an object with a text `link`, a `path` that is a vault path whose name does not end in `.md` in any letter case, a `hash` that is `sha256:` and 64 small hexadecimal digits, and a whole number `size` from 0, with `width` and `height` both whole numbers above 0 or both missing, and no other key. The tool makes the name of a file of the attachment storage from the hash, so a hash in another form could name another file.
7. An item of `aliases` is not a text, or the list is not sorted in the order of the code points with each alias one time.
8. `noteType` is there and is not an object with a `name` that is a canonical name, a `displayName` that is not empty, a `prefix` and a `suffix` that are texts that are not empty when they are there, and no other key.

Both implementations read a JSON file of the store and a stored plan in the same way (`json.ts`, `json.rs`, with the shared cases of the list `json` of `fixtures/canonical/cases.json`). A number is read as the nearest floating point number, as JavaScript reads it, so a whole number can be written in another form (`1.0`, `1e0`, `-0`, `9007199254740991.4`): it is that number. These texts are not JSON for the tool: a text with half of a surrogate pair, a number that is too large to hold, a key that is two times in one object (also when an escape writes it in another way), and data with more than 64 levels (rule 10 of the data). A second key with the same name would else hide a value that only one implementation refuses. A symbolic link in the copy of the content store is not a file of the store, and the tool follows none: a read or a write whose path has a link in one of its parts fails: it stops the run, but for the files of one note of `publish`, `update` or `remove`, where that note is left out (rule 4 of "A publication"), so `configuration.json` as a link, also a link that leads nowhere, is never read as no configuration. The manifest has one level: its files are the files directly in `manifest/`. A folder below it and a link in it are not read.

## The state property after a publication

After a push that succeeded, the tool corrects the `public_note` property in the vault (PUB-13 of the spec):

1. The scope is the notes of the scan, as the publication read them when it checked the plan. A note in a folder of the deny list is not in the scan, so it is never written. The folders of the note templates are on the deny list.
2. A note that is published after the run gets the property with the value `true`. Every other note of the scan loses the property, also a note that the ignore property excludes: it is not published.
3. A note is written only when its text changes.
4. Before a note is written, it is read again. When its text is not the text of the scan, the note is not written and the report has a warning: the property is corrected at the next publication. A write that fails gives a warning too.
5. A note whose properties are in the flow form of YAML is not written, and the report has a warning: the author corrects the property by hand.
6. A write never changes what the ignore property says. In an odd form of the properties, a line of the ignore property can belong to the state property, or the new lines can close properties that were open. When the ignore property would be read in another way after the write, the note is not written and the report has a warning: the author corrects the property by hand. A write of the tool can so never open a guard.
7. Without a push, nothing is corrected: an empty plan, a publication whose every note failed, a refused push. The push is the proof that the copy of the content store followed the content store. Without that proof, a note that another device published could lose its property. One exception: a journal `correct` is the proof of an earlier push (see "Failure cases"), and the next publication corrects the property also with nothing to commit.
8. A note is written in two steps: its new text goes into a hidden file of its folder (`.vault-publish-<process>-<count>.tmp`, one of its own for each write of each process), which is then renamed to the name of the note. A note with no write right for anyone (no write bit of its mode, or the read-only flag on Windows) is refused, with a warning: the rename would replace it. The rename gives the note a new file, so a hard link to it and its extended attributes are not kept. A stop of the process during the write never leaves a note empty or half written. The scan and Obsidian do not see a name that starts with a dot. In Obsidian, the plugin writes with the vault of Obsidian.

## How it is tested

1. Shared cases: `fixtures/canonical/properties.json` holds notes with the result that each rule for the properties must give. `fixtures/canonical/cases.json` holds values and the text that each must give, values that must be refused, and a list of paths with its order. `fixtures/canonical/links.json` holds texts with the link paths that each must give, link paths with the target that each must have in a small list of files, and texts with the links to notes and to attachments that each must give. `fixtures/canonical/images.json` holds the bytes of files with the size of the image that each must give. `fixtures/canonical/queue.json` holds scenarios of the publication queue: a small invented vault, the steps of the author (edits, plans, publications), and after each step the queue, the plan, the report, the files of the vault and of the content store, and the files of the attachment storage that the rules must give. Each expected result is written by hand, with hashes that were computed with another tool. The TypeScript tests (`apps/plugin/src/publishing/canonical.spec.ts`, `frontmatter.spec.ts`, `images.spec.ts`, `links.spec.ts`, `queue.spec.ts`) and the Rust tests (`cli/src/canonical.rs`, `cli/src/order.rs`, `cli/src/frontmatter.rs`, `cli/src/images.rs`, `cli/src/links.rs`, `cli/tests/queue.rs`) both read those files. A value that only one language can hold has a test on that side only.
2. Parity tests: `parity/` holds tests that run both implementations on a copy of the fixture vault, with notes in hard forms added (Windows line ends, a byte order mark, no properties, odd forms of the properties), and compare what they leave: the stored plan, every file of the content store, every file of the vault and every file of the attachment storage. A second test checks that both refuse the same notes. A third one goes through the publication queue: a first publication, then edits, a technical update, a removal, a forced removal, notes with links of each form, a note that carries the property by mistake and an image that two notes use and that the author changes, and it compares the queue, the plans, the reports, the content store, the vault and the attachment storage after each publication. They are part of `bun run test`, so CI fails when they fail.
3. The tests of each implementation (`apps/plugin/src/publishing/publication.spec.ts` and `queue.spec.ts`, `cli/tests/publication.rs`, `attachments.rs` and `queue.rs`) state the same expected texts, with hashes that were computed with another tool. The Rust tests also run on Windows.
