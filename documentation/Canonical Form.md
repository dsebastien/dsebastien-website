# Canonical Form

The publishing logic exists two times: in TypeScript inside the Obsidian plugin, and in Rust inside the command line program (ADR 0009). The parity rule says that both give the same bytes for the same input. This document says what "the same bytes" means. It is the canonical form of TOOL-06 and TOOL-31 of the spec.

A change of a rule here lands in both implementations in the same commit.

## What the parity rule compares

1. The publication plan as data, without its id and its time.
2. The cleaned notes.
3. The manifest.

Outside the rule (TOOL-30): the view, the order of the writes into the vault, ids (plan id, run id), the time of a run, and the text of logs, reports and error messages.

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

Only a content store that has no `configuration.json` at all has an empty deny list.

The copy of the content store must be the root of its own git repository. The tool stages and commits only the files that it wrote.

## The publication plan

The first shape. Later slices add members (the forced removals, the edits of the configuration).

| Key       | Value                                            | Order          |
| --------- | ------------------------------------------------ | -------------- |
| `publish` | The vault paths of the notes to publish          | Sorted by path |
| `remove`  | The vault paths of the published notes to remove | Sorted by path |
| `update`  | The vault paths of the published notes to update | Sorted by path |

Both implementations sort the three lists when they make a plan (`makePlan`, `PublicationPlan::new`), so no caller can give a plan in another order.

The empty plan. A test compares this block with the output of the code:

<!-- prettier-ignore -->
```json
{
  "publish": [],
  "remove": [],
  "update": []
}
```

A plan is stored on the device as a record: the plan, the selection that gave it, and the state that it was computed from. The parity rule compares the record.

| Key                   | Value                                                                                                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan`                | The plan                                                                                                                                                                                              |
| `selection.include`   | The vault paths that were selected for a publication, each one time, sorted                                                                                                                           |
| `state.configuration` | `sha256:` and the SHA-256 of the text of `configuration.json`, or `none` when the store has no such file                                                                                              |
| `state.manifest`      | `sha256:` and the SHA-256 of the manifest: for each file of `manifest/`, in the order of the paths, its path in the store, a line feed, the hash of its text in the form of the manifest, a line feed |
| `state.notes`         | A list with, for each note of the plan, its `path` and its `sourceHash`, sorted by path                                                                                                               |

The id of a plan is 16 hexadecimal digits of the SHA-256 of its record. It names the stored file. It is outside the parity rule. The tool accepts no other form of id.

Before a plan is applied, its record is computed again from the selection. When the new record is not the stored one, the plan is stale and nothing is published: a note of the plan was edited, the configuration changed, or another publication changed the manifest.

The first slice knows one case: the first publication of the notes of `selection.include`. A selected path stops the plan in each of these cases:

1. It is not a vault path, or it does not end in `.md` (in small letters).
2. The vault has no file with exactly that path. Each part of the path must be a name of the folder listing, with the same letter case and the same Unicode form. A symbolic link is not a file of the vault, and a folder that is a link is not a folder of the vault.
3. The note is not valid UTF-8.
4. A guard excludes the note.
5. The note is already published.

## Notes and their properties

The two implementations read and write the properties of a note as lines of text. They use no YAML library, because two libraries never agree on every byte.

Reading:

1. A byte order mark at the start of a note is not part of its first line.
2. A note has properties when its first line is `---`, with nothing after it but spaces and tabs, and a later line is `---` in the same form. The lines between the two are the properties. A carriage return at the end of a line is not part of the line.
3. A line names a key when it holds, in this order: an optional quote (`"` or `'`), the key, an optional quote, optional spaces and tabs, and a colon. The value is the text after the colon, without the spaces and the tabs around it. No other character is removed.
4. A property of the note itself starts at a line that names its key with no space and no tab before it. It goes on over the next lines that begin with a space, a tab or a hyphen.

The ignore property is read to fail closed. The guard excludes a note when a line names `publish_ignore`, also after spaces and tabs and in any case of its ASCII letters, unless the value of every such line is exactly `false`. So `true`, `yes`, `"true"`, a value on the next line, a comment after the value and a nested key all exclude the note. When the first line opens the properties and no line closes them, every line of the note is read for the guard.

The deny list guard excludes a note when its vault path starts with an entry of the deny list and a slash.

Writing the state property (`public_note`):

5. To remove the property is to remove every property of the note itself that names the key, with its lines.
6. To set the property is to remove it, then to write the line `public_note: true` in the place of the first one that was removed. When there was none, the line becomes the last line of the properties.
7. A note without properties gets the three lines `---`, `public_note: true`, `---` before its text, after its byte order mark when it has one.
8. Every line that is kept keeps its own line end. A new line takes the line end of the first line of the note, and a line feed when the note has no line end.
9. A note whose text would not change is not written.

## Cleaned notes

A cleaned note is Markdown text, in the encoding of this document.

1. The source of a note is its text in the vault, without its byte order mark, with each pair of a carriage return and a line feed replaced by a line feed, and without the `public_note` property. That property is the state in the vault, not content.
2. Version 1 of the cleaning step changes nothing more: the cleaned note is the source.
3. The ticket that adds a rule to the cleaning step writes it here before the second implementation is written, and raises the version.

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
| `path`            | The vault path of the note                                                                                                          |
| `sourceHash`      | `sha256:` and the SHA-256 of the source of the note                                                                                 |
| `state`           | `published`                                                                                                                         |

After the push of a publication, the tool sets `public_note: true` in the vault on each note that it published. It writes a note only when the text changes.

## How it is tested

1. Shared cases: `fixtures/canonical/properties.json` holds notes with the result that each rule for the properties must give. `fixtures/canonical/cases.json` holds values and the text that each must give, values that must be refused, and a list of paths with its order. Each expected result is written by hand. The TypeScript tests (`apps/plugin/src/publishing/canonical.spec.ts`, `frontmatter.spec.ts`) and the Rust tests (`cli/src/canonical.rs`, `cli/src/order.rs`, `cli/src/frontmatter.rs`) both read those files. A value that only one language can hold has a test on that side only.
2. Parity tests: `parity/` holds tests that run both implementations on a copy of the fixture vault, with notes in hard forms added (Windows line ends, a byte order mark, no properties, odd forms of the properties), and compare what they leave: the stored plan, every file of the content store and every file of the vault. A second test checks that both refuse the same notes. They are part of `bun run test`, so CI fails when they fail.
3. The tests of each implementation (`apps/plugin/src/publishing/publication.spec.ts`, `cli/tests/publication.rs`) state the same expected texts, with hashes that were computed with another tool. The Rust tests also run on Windows.
