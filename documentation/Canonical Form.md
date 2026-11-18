# Canonical Form

The publishing logic exists two times: in TypeScript inside the Obsidian plugin, and in Rust inside the command line program (ADR 0009). The parity rule says that both give the same bytes for the same input. This document says what "the same bytes" means. It is the canonical form of TOOL-06 and TOOL-31 of the spec.

A change of a rule here lands in both implementations in the same commit.

## What the parity rule compares

1. The publication plan as data, without its id and its time.
2. The cleaned notes.
3. The manifest.

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
3. The fixture vault holds names in the composed Unicode form (NFC) only. What the tool does with a name in another form is not decided: the slice of the URL contract decides it (URL-02 of the spec).

## The content store

| Path                 | What it holds                                                             |
| -------------------- | ------------------------------------------------------------------------- |
| `configuration.json` | The configuration of the tool: `denyList`, the list of the denied folders |
| `notes/<vault path>` | The cleaned note of a published note, at its vault path                   |
| `manifest/<id>.json` | The manifest entry of a published note, as data in the canonical form     |

The configuration is read strictly. The tool stops, and publishes nothing, in each of these cases:

1. The file exists and cannot be read as UTF-8 text, or is not JSON, or is not an object whose `denyList` is a list of texts.
2. An entry of the deny list is not a vault path in the form of this document: relative, with `/`, with no empty part, no `.` part and no `..` part.
3. An entry of the deny list names no folder of the vault, with exactly that name (GATE-38 of the spec). A folder that was renamed, or an entry with another letter case, would else make its notes candidates.

Only a content store that has no `configuration.json` at all, neither in its last commit nor in the copy, has an empty deny list.

The copy of the content store must be the root of its own git repository. The content store has one branch, `main`: every publication pushes to it. The tool stops (`status`, `plan` and `publish`) when the copy has commits that no branch of the content store has (`git rev-list HEAD --not --remotes=origin`). A copy with no branch of its own that leads to a commit has no commit ahead (see below). Such a commit is a publication that git could not take back, and the next push would send it, also for a note that came under a guard since. A folder of the store that exists and cannot be listed stops the tool too: it is never read as an empty folder. The tool reads the state from the files of the copy, so `configuration.json` and `manifest/` in the copy must be exactly the files of its last commit. The tool stops when `git status` shows any change on them (a file edited, removed, added, ignored or replaced by a folder or a link, also with no index), and when git skips one of them or assumes it unchanged (a sparse checkout, `--skip-worktree`, `--assume-unchanged`), which `git status` does not compare. A file that differs would hide a published note under a guard, or empty the deny list. This comparison converts the line ends as the copy converts them (Git for Windows converts them by default), so a file that differs only in its line ends is the same file. It is the one place where the tool lets git convert line ends. Git status trusts the stat data of a file, and an edit of the same size in the same second can look unchanged to it, so the tool also compares the bytes of each file with the commit by its hash (`git ls-tree` and `git hash-object --no-filters`), with no filter and no attribute of git: a filter could make other bytes look like the commit. A file whose hash differs is still the file of the commit when, with each carriage return and line feed made a line feed, it has the hash of the commit: in a valid JSON text a line end is only white space. When the copy has commits that no branch of the content store has, the message proposes a push only when the push would change `configuration.json` alone and not remove it (`git diff --no-renames --name-status origin/main HEAD`, or every file of the last commit when the content store has no branch yet). The names of the files in the commits do not say it: a commit that removes the configuration would empty the deny list, and a merge commit names no file but can take back a publication of another device. After an edit of the deny list by hand, the author commits `configuration.json` and pushes it before the next run. A copy that is behind the content store reads an older manifest: a note that came under a guard since would stay live, and the push of the copy would be refused. So `plan` and `publish` fetch the branch `main` of the content store first, with the branch named (`git fetch origin +refs/heads/main:refs/remotes/origin/main`, after `git ls-remote origin refs/heads/main`: a content store with no branch yet has nothing to fetch), so that no fetch setting of the copy can leave `origin/main` as it was, and stop when the copy is behind its branch `main` (`git rev-list --count HEAD..origin/main`), with a message that says to pull (`git pull --ff-only origin main`). When the content store cannot be reached, they stop too, and when the content store has no branch `main` but the copy knows one. `status` stays offline and fast: it reads no network, and its key `behind` gives how far the copy is behind at the last fetch. A copy with no branch of its own that leads to a commit (a clone of a content store with no branch yet, or a copy made with `git init`) has no commit ahead, and it is behind every commit of the content store. An orphan branch in a copy with commits is not such a copy, and it stops the tool. Only the copy of a content store with no branch at all has no history to compare. Another device can still push between the fetch and the push of a publication: the push is then refused, and nothing is published. The tool stages and commits only the files that it wrote. Every git command of the tool reads paths as they are written (a note name can hold `[` or `*`) and converts no line end, whatever the settings of the machine say, but for the comparison of the copy with its last commit (see above).

## The notes of the vault

The tool scans the vault to find its notes. Both implementations scan in the same way:

1. The scan starts at the root of the vault and goes into each folder.
2. A name that starts with a dot is not part of the vault: a folder (`.obsidian`, `.trash`) or a file. Obsidian does not show them.
3. A symbolic link is not part of the vault, as a file and as a folder.
4. A name that is not valid Unicode, or that holds the replacement character (U+FFFD), is not part of the vault.
5. A folder of the deny list is not scanned for notes. The tool reads none of its files and writes none. It lists the notes below it by their paths (rules 2, 3, 4 and 6 apply to the names below the folder, not to the entry of the deny list itself), for two reasons: to know that a published note moved into it (see the forced removals of the publication plan), and to know that a link leads to a note under that guard (see the links of a note). It writes none of these paths.
6. A note is a file of the scan whose name ends in `.md`, in small letters.
7. The tool reads every note of the scan. A note that cannot be read, or that is not valid UTF-8, stops the run with a message that names it. A note that cannot be read is never taken for a note without the ignore property.

## The publication queue

The publication queue is what the `status` command writes, as data in the canonical form. It changes nothing in the vault and in the content store.

| Key                | Value                                                                                                           | Order          |
| ------------------ | --------------------------------------------------------------------------------------------------------------- | -------------- |
| `behind`           | The number of commits of the branch `main` of the content store, at the last fetch, that the copy does not have |                |
| `changed`          | The vault paths of the published notes whose content in the vault is not the published content                  | Sorted by path |
| `counts`           | The number of paths of each of the four lists: `changed`, `new`, `toRemove`, `unchanged`                        |                |
| `new`              | The vault paths of the candidates                                                                               | Sorted by path |
| `technicalUpdates` | The paths of `changed` that the author did not edit: only the result of the cleaning step moved                 | Sorted by path |
| `toRemove`         | The vault paths of the published notes that cannot stay published as they are                                   | Sorted by path |
| `unchanged`        | The vault paths of the published notes that are the same in the vault and in the content store                  | Sorted by path |

A published note is a note with a manifest entry whose state is `published`. Each note is in one of the four lists at most:

1. A published note is in `toRemove` when the scan did not find its file (it is missing from this vault, or it is now in a folder of the deny list), or when the ignore property excludes it. Such a note is never updated.
2. Another published note is in `changed` when the hash of its source is not the `sourceHash` of its manifest entry. It is in `changed` and in `technicalUpdates` when the hash is the same and the cleaning step would give another result: the `cleaningVersion` of its entry is not the version of the cleaning step, or the `links` of its entry are not the links that the note has now (a target was made, moved or removed, or a guard now excludes it).
3. Every other published note is in `unchanged`.
4. A note of the scan that is not published is in `new` when the ignore property does not exclude it. A note that was unpublished is a candidate again.
5. A note that is not published and that a guard excludes is in no list.

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
  "new": [],
  "technicalUpdates": [],
  "toRemove": [],
  "unchanged": []
}
```

## The selection

The selection is the intent of the author for one plan. It has three lists of vault paths:

| Key       | Value                                                         |
| --------- | ------------------------------------------------------------- |
| `hold`    | The notes to leave out of this plan: their live version stays |
| `include` | The notes to publish                                          |
| `remove`  | The published notes to unpublish                              |

A selection stops the plan in each of these cases:

1. A path is not a vault path, or it does not end in `.md` (in small letters).
2. A path is in more than one of the three lists.
3. A path of `include` is not in the list `new`, `changed` or `unchanged` of the queue. So a note under a guard, a file that is not a note of the scan and a published note that waits for its removal cannot be included.
4. A path of `hold` is in no list of the queue. A hold that names no note would hold nothing, and the note that the author meant would be published.
5. A path of `remove` is not the path of a published note.
6. A path of `hold` is the path of a forced removal (see the plan). A guard cannot be held (PUB-21 of the spec).

## The publication plan

| Key            | Value                                                                             | Order          |
| -------------- | --------------------------------------------------------------------------------- | -------------- |
| `forcedRemove` | The vault paths of the published notes that a guard excludes: the forced removals | Sorted by path |
| `publish`      | The vault paths of the notes to publish                                           | Sorted by path |
| `remove`       | The vault paths of the published notes to unpublish                               | Sorted by path |
| `update`       | The vault paths of the published notes to update                                  | Sorted by path |

A later slice adds the edits of the configuration.

The plan of a selection:

1. `publish`: the paths of `include` that are in the list `new` of the queue. A new candidate enters a plan only when its path is named.
2. `update`: every path of the list `changed` of the queue that is not in `hold` and not in `remove`. So a plan without paths holds the changed notes only. A path of `include` that is in `changed` or in `unchanged` adds nothing.
3. `forcedRemove`: every path of the list `toRemove` of the queue that a guard excludes. There are three cases. The path is in a folder of the deny list. The ignore property excludes the note. Or the scan did not find the file of the note, and a note with the same name, the letter case ignored, is in a folder of the deny list: the note moved there. The tool compares names only and reads no file of such a folder, so a published note that is missing from this vault is removed too when another note of its name is in a folder of the deny list: the tool fails closed. A note that gets another name when it moves, or that moves into a folder below a deny list folder whose name starts with a dot, is only missing for the tool: the rename journal of a later slice gives the exact move. A published note whose file is only missing, with no note of its name in a folder of the deny list, is not a forced removal. No selection changes this list: every plan holds every forced removal, also a plan without paths (PUB-21 of the spec).
4. `remove`: the paths of `remove` of the selection that are not in `forcedRemove`. A guard wins over an unpublish.

Both implementations sort the four lists when they make a plan (`makePlan`, `PublicationPlan::new`), so no caller can give a plan in another order.

The empty plan. A test compares this block with the output of the code:

<!-- prettier-ignore -->
```json
{
  "forcedRemove": [],
  "publish": [],
  "remove": [],
  "update": []
}
```

A plan is stored on the device as a record: the plan, the selection that gave it, and the state that it was computed from. The record is stored outside the vault and outside the content of the store. The parity rule compares the record.

| Key                   | Value                                                                                                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan`                | The plan                                                                                                                                                                                              |
| `selection.hold`      | The vault paths of the selection to hold, each one time, sorted                                                                                                                                       |
| `selection.include`   | The vault paths of the selection to publish, each one time, sorted                                                                                                                                    |
| `selection.remove`    | The vault paths of the selection to unpublish, each one time, sorted                                                                                                                                  |
| `state.configuration` | `sha256:` and the SHA-256 of the text of `configuration.json`, or `none` when the store has no such file                                                                                              |
| `state.manifest`      | `sha256:` and the SHA-256 of the manifest: for each file of `manifest/`, in the order of the paths, its path in the store, a line feed, the hash of its text in the form of the manifest, a line feed |
| `state.notes`         | A list with, for each note of `publish` and of `update`, its `path`, its `sourceHash`, its `cleanedHash` and its `links` (in the form of the manifest entry), sorted by path                          |

The `cleanedHash` of a note in the record is the hash of the cleaned note that the publication will write. It is what the plan shows of the text (PUB-92 of the spec).

The id of a plan is 16 hexadecimal digits of the SHA-256 of its record. It names the stored file. It is outside the parity rule. The tool accepts no other form of id.

Before a plan is applied, its record is computed again from the selection. When the new record is not the stored one, the plan is stale and nothing is published: a note of the plan was edited, another published note changed and would enter the plan, a published note came under a guard, a link of a note of the plan leads to another note, the configuration changed, another publication changed the manifest, or the version of the cleaning step is another one. A new candidate and an edit of a note that is not published do not make a plan stale.

## A publication

The `publish` command applies exactly one plan. After the check of the record:

1. First, for each note of `forcedRemove`, it removes `notes/<vault path>` and the manifest entry of the note. This is the takedown rule (PUB-84 of the spec): the note leaves the manifest with its former paths, so its URL answers 404 and no older name leads to it. When a forced removal fails, the publication stops: every file is put back as it was, nothing is committed, and the command fails. No note is published while a note under a guard stays live.
2. For each note of `publish` and of `update`, it writes the cleaned note to `notes/<vault path>` and the manifest entry of the note. The cleaned note that it writes is the text whose hash the record holds, and the entry holds the links of the record.
3. For each note of `remove`, it removes `notes/<vault path>` and writes the manifest entry with the state `unpublished`.
4. The two files of a note of step 2 or 3 are one unit. When a write of the unit fails, the files of that note are put back as they were, the note is left out of the publication, and the report names it with the reason. The other notes are published. When the files of the note cannot be put back, the whole publication stops as in rule 6.
5. Every file that it wrote or removed goes into one commit, which is pushed without force. With nothing to commit, there is no commit and no push. The tool gives the paths to git on its standard input, not as arguments: a publication can hold more paths than one command takes. No file holds them, so the folder of the copy can be a relative path, and two publications on one copy share no file. A copy with no commit takes its first publication.
6. When the commit fails or the push is refused, the commit is taken back and every file of the publication is put back as it was. Nothing is published. A file that stayed in the copy would be read as published at the next run. The undo follows these rules:
    - A file is put back with the text that the tool read before it wrote the file, not from a commit: a copy can have no commit, and a file of the copy can be in no commit. A file that did not exist is removed.
    - Only the paths of the publication are unstaged. Other staged work of the copy stays staged.
    - Each step runs, also when one fails (for example when git cannot write its index). The message of the command says what could not be put back.
7. After a push that succeeded, the `public_note` property is corrected (see below).

The message of the commit holds the counts, the device and the face that started the publication (PUB-29 of the spec). The skipped notes are the changed notes of the queue that the plan does not update and does not remove. "forced" counts the forced removals. The message is outside the parity rule, like every text for a person, and both implementations write it in this form:

```text
Publish: 1 new, 2 updated, 0 removed, 0 forced, 1 skipped

Device: garden-shed
Face: command-line
```

The name of the device and the name of the face are inputs, like the time of the run. The name of the device is one line of text: it has no control character, and it is not empty and not only spaces (U+0020). The faces are `plugin`, `command-line` and `mcp-server`.

## The publication report

The result of the `publish` command, as data in the canonical form. Every list of paths is sorted by path.

| Key               | Value                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| `failed`          | The notes of the plan that were left out, each with its `path` and a `reason`                    |
| `forcedRemoved`   | The vault paths of the notes that were removed because a guard excludes them                     |
| `propertyRemoved` | The vault paths of the notes whose `public_note` property was removed                            |
| `propertySet`     | The vault paths of the notes whose `public_note` property was set                                |
| `published`       | The vault paths of the notes that were published for the first time, or again after an unpublish |
| `removed`         | The vault paths of the notes that were unpublished                                               |
| `skipped`         | The vault paths of the changed notes that the plan did not update                                |
| `updated`         | The vault paths of the published notes that were updated                                         |
| `warnings`        | What the author must know and what stopped nothing, each with its `path` and a `message`         |

The parity tests compare the lists of paths. The texts (`reason`, `message`) are outside the rule.

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
4. The ticket that adds a rule to the cleaning step writes it here before the second implementation is written, and raises the version.

No content store was written with version 1 outside the tests, so the tool reads no manifest entry without `links`.

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

The inputs are the link path, the vault path of the note that holds the link, and the notes of the vault: the notes of the scan, and the notes of the folders of the deny list, which the tool knows by their paths alone (rule 5 of the scan). A note under a guard is a candidate like every other note, so that a link which Obsidian leads to it does not lead to another note of the same name. It never gets an item: see the list `links`.

The letter case is ignored: the link path and each vault path are compared in small letters (`toLowerCase` in TypeScript, `to_lowercase` in Rust, on the whole text). The name of a path is its part after the last slash. The folder of a path is its part before the last slash, and the empty text for a note at the root.

1. `r` is the link path in small letters. When `r` ends in `.md`, the candidates are the notes of the scan whose name is the name of `r`. When `r` does not end in `.md`, or there is no such note, `.md` is added to `r`, and the candidates are the notes whose name is the name of the new `r`. Without a candidate, the link path has no target.
2. When `r` holds no slash and there is one candidate, that note is the target.
3. `s` is the folder of the note that holds the link, in small letters. When `r` starts with `./` or `../`, it is made a path from the root. A `./` before a `../` is dropped. For `./`, the `./` is dropped. For `../`, each `../` at the start is dropped, and `s` becomes its own folder each time. Then, when `s` is not empty, a slash is added to the end of `s`, and `r` becomes `s` and then the rest. A candidate whose path is `r` is the target. `s` keeps its new value for step 6.
4. A slash at the start of `r` is dropped. A candidate whose path is `r` is the target.
5. When the link path starts with a slash, it has no target.
6. Else the candidates whose path ends with `r` stay. The ones whose path starts with `s` come first, then the others. Inside each group, the shorter path comes first, counted in UTF-16 units as Obsidian counts, then the order of the code points. The first candidate is the target. Without one, the link path has no target.

Where several candidates fit a step, the first one in the order of the code points of their vault paths is taken. Obsidian takes the one that it loaded first, which no rule can give.

In steps 3 to 6, "starts with" and "ends with" compare texts, not path parts, as Obsidian does.

### The list `links`

1. Each link path of the note that has a target gives one item: `link` is the link path, and `path` is the vault path of the target, as the vault gives it.
2. A target that a guard excludes gives no item: a note in a folder of the deny list, and a note that the ignore property excludes. So the tool writes no path of a note under a guard into the content store. An entry that was written before the guard came holds the path until the next update of its note: that update is a technical update of rule 5, and the author can hold it like every update.
3. Each link path is in the list one time. The list is sorted by `link`, in the order of the code points.
4. The state of the target is not an input: a target that is not published has its item like every other. The build makes a link only when the manifest has a published note at that path, and shows the link text as plain text in every other case (PUB-89, BUILD-05). So a link appears when its target is published, with no change to the note that holds it.
5. The links of a published note are computed again at each scan. When they are not the `links` of its manifest entry, the note is a technical update (see the publication queue).

Left to the slice of the attachments: a link path that names a file of the vault that is not a note. Obsidian looks for such a file first. Until then it has no target, also when a note has the same name with `.md` after it.

## The manifest entry

One file per published note, as data in the canonical form.

| Key               | Value                                                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `attachments`     | The attachments of the note. Empty until the slice of the attachments                                                               |
| `cleanedHash`     | `sha256:` and the SHA-256 of the cleaned note, in small hexadecimal digits                                                          |
| `cleaningVersion` | The version of the cleaning step that made the cleaned note: a whole number from 0                                                  |
| `firstPublished`  | The time of the run of the first publication                                                                                        |
| `formerPaths`     | The vault paths that the note had before, in the order in which they were added                                                     |
| `id`              | The identity of the note: 16 hexadecimal digits of the SHA-256 of its vault path, a line feed and the time of its first publication |
| `lastPublished`   | The time of the run of the last publication                                                                                         |
| `links`           | The links of the note that lead to a note: for each one its `link` and the `path` of its target, sorted by `link` (see below)       |
| `path`            | The vault path of the note                                                                                                          |
| `sourceHash`      | `sha256:` and the SHA-256 of the source of the note                                                                                 |
| `state`           | `published`, or `unpublished` after the note was removed by a publication                                                           |

The entry of a note at a publication:

1. A note that is published for the first time gets a new entry. `firstPublished` and `lastPublished` are the time of the run.
2. A note that was unpublished and is published again keeps its entry: its `id`, its `firstPublished`, its `formerPaths` and its `attachments` stay. Its state is `published` again, and `lastPublished` is the time of the run.
3. An update writes `cleanedHash`, `cleaningVersion`, `links` and `sourceHash`. `lastPublished` is the time of the run when the hash of the source changed. A technical update does not move it (PUB-24 of the spec).
4. An unpublish changes the state only.
5. A forced removal removes the entry.

The manifest is read strictly. The tool stops in each of these cases:

1. A file of `manifest/` cannot be read, or is not an entry with every key of the table.
2. The `id` of an entry is not 16 hexadecimal digits, or the file is not named `manifest/<id>.json`.
3. The `path` of an entry is not a vault path that ends in `.md`. The tool removes `notes/<path>` at an unpublish, so a path in another form could name a file outside the notes.
4. Two entries have the same `path`.
5. An item of `links` is not an object with exactly a text `link` and a `path` that is the vault path of a note.

Both implementations read a JSON file of the store and a stored plan in the same way (`json.ts`, `json.rs`, with the shared cases of the list `json` of `fixtures/canonical/cases.json`). A number is read as the nearest floating point number, as JavaScript reads it, so a whole number can be written in another form (`1.0`, `1e0`, `-0`, `9007199254740991.4`): it is that number. These texts are not JSON for the tool: a text with half of a surrogate pair, a number that is too large to hold, a key that is two times in one object (also when an escape writes it in another way), and data with more than 64 levels (rule 10 of the data). A second key with the same name would else hide a value that only one implementation refuses. A symbolic link in the copy of the content store is not a file of the store, and the tool follows none: a read or a write whose path has a link in one of its parts fails: it stops the run, but for the files of one note of `publish`, `update` or `remove`, where that note is left out (rule 4 of "A publication"), so `configuration.json` as a link, also a link that leads nowhere, is never read as no configuration. The manifest has one level: its files are the files directly in `manifest/`. A folder below it and a link in it are not read.

## The state property after a publication

After a push that succeeded, the tool corrects the `public_note` property in the vault (PUB-13 of the spec):

1. The scope is the notes of the scan, as the publication read them when it checked the plan. A note in a folder of the deny list is not in the scan, so it is never written. The folders of the note templates are on the deny list.
2. A note that is published after the run gets the property with the value `true`. Every other note of the scan loses the property, also a note that the ignore property excludes: it is not published.
3. A note is written only when its text changes.
4. Before a note is written, it is read again. When its text is not the text of the scan, the note is not written and the report has a warning: the property is corrected at the next publication. A write that fails gives a warning too.
5. A note whose properties are in the flow form of YAML is not written, and the report has a warning: the author corrects the property by hand.
6. A write never changes what the ignore property says. In an odd form of the properties, a line of the ignore property can belong to the state property, or the new lines can close properties that were open. When the ignore property would be read in another way after the write, the note is not written and the report has a warning: the author corrects the property by hand. A write of the tool can so never open a guard.
7. Without a push, nothing is corrected: an empty plan, a publication whose every note failed, a refused push. The push is the proof that the copy of the content store followed the content store. Without that proof, a note that another device published could lose its property.

## How it is tested

1. Shared cases: `fixtures/canonical/properties.json` holds notes with the result that each rule for the properties must give. `fixtures/canonical/cases.json` holds values and the text that each must give, values that must be refused, and a list of paths with its order. `fixtures/canonical/links.json` holds texts with the link paths that each must give, and link paths with the target that each must have in a small list of notes. `fixtures/canonical/queue.json` holds scenarios of the publication queue: a small invented vault, the steps of the author (edits, plans, publications), and after each step the queue, the plan, the report and the files that the rules must give. Each expected result is written by hand, with hashes that were computed with another tool. The TypeScript tests (`apps/plugin/src/publishing/canonical.spec.ts`, `frontmatter.spec.ts`, `links.spec.ts`, `queue.spec.ts`) and the Rust tests (`cli/src/canonical.rs`, `cli/src/order.rs`, `cli/src/frontmatter.rs`, `cli/src/links.rs`, `cli/tests/queue.rs`) both read those files. A value that only one language can hold has a test on that side only.
2. Parity tests: `parity/` holds tests that run both implementations on a copy of the fixture vault, with notes in hard forms added (Windows line ends, a byte order mark, no properties, odd forms of the properties), and compare what they leave: the stored plan, every file of the content store and every file of the vault. A second test checks that both refuse the same notes. A third one goes through the publication queue: a first publication, then edits, a technical update, a removal, a forced removal, notes with links of each form and a note that carries the property by mistake, and it compares the queue, the plans, the reports, the content store and the vault after each publication. They are part of `bun run test`, so CI fails when they fail.
3. The tests of each implementation (`apps/plugin/src/publishing/publication.spec.ts` and `queue.spec.ts`, `cli/tests/publication.rs` and `queue.rs`) state the same expected texts, with hashes that were computed with another tool. The Rust tests also run on Windows.
