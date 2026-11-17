# Canonical Form

The publishing logic exists two times: in TypeScript inside the Obsidian plugin, and in Rust inside the command line program (ADR 0009). The parity rule says that both give the same bytes for the same input. This document says what "the same bytes" means. It is the canonical form of TOOL-06 and TOOL-31 of the spec.

A change of a rule here lands in both implementations in the same commit.

## What the parity rule compares

1. The publication plan as data, without its id and its time.
2. The cleaned notes.
3. The manifest.

Outside the rule (TOOL-30): the view, the order of the writes into the vault, ids (plan id, run id), the time of a run, and the text of logs, errors and reports.

## Inputs

1. The same input gives the same output: the state of the vault, the manifest, the configuration of the tool, the selection, and the time of the run.
2. The time of a run is an input. The logic never reads the clock. A face of the tool reads the clock one time and passes the value.
3. The logic uses no random value. An id is made by a face of the tool, outside the logic.
4. The logic does not depend on the system: not on the path separator, not on the locale, not on the time zone, not on the order in which the file system lists files.

## Encoding

1. Every output is UTF-8, without a byte order mark.
2. A line ends with the line feed character (U+000A) alone. No carriage return is written.
3. A data file ends with exactly one line end.

## Data: the plan and the manifest

Data is written as JSON, in this exact form:

1. Two spaces per level. One member or one item per line. A colon and one space between a key and its value. No space at the end of a line.
2. An empty list is `[]` and an empty object is `{}`, on one line.
3. The keys of each object are sorted in the order of their code points. So a capital letter comes before a small letter, and `"10"` comes before `"2"`.
4. A key holds only plain ASCII characters (U+0020 to U+007E). So the order of the code points, of the UTF-8 bytes (Rust) and of the UTF-16 units (TypeScript) is the same order.
5. A value is a text, a whole number, a boolean, a list or an object. There is no `null`: a value that does not exist has no key.
6. A number is a whole number from -9,007,199,254,740,991 to 9,007,199,254,740,991, which both languages hold exactly. No fraction and no exponent.
7. In a text, the quote and the backslash are escaped (`\"`, `\\`). A control character below U+0020 is escaped: `\b`, `\t`, `\n`, `\f`, `\r` where that short form exists, else `\u00` and two small hexadecimal digits. Every other character is written as it is: the slash, the delete character, and every character outside ASCII.
8. A text is valid Unicode. Half of a surrogate pair has no canonical form.
9. A time is a text in UTC with seconds: `2031-03-14T07:30:00Z`.

A value that breaks rule 4, 5, 6 or 8 is refused by both implementations. It is a defect of the logic, never a case to write in another way.

## Lists

1. The canonical writer never sorts a list. The logic gives each list in its order, and that order is part of the output.
2. A list of notes is sorted by vault path, in the order of the code points of the path. Do not use a comparison that follows a locale.
3. A list whose order has a meaning keeps it. The former paths of a note are in the order in which they were added.
4. Each new list states its order in the document of its data, before the second implementation is written.

## Paths

1. A vault path is relative to the root of the vault, with `/` between its parts and no `/` at the start, on every system.
2. A path is in the composed Unicode form (NFC).
3. A path is compared as it is written. Letter case is never ignored in the logic.

## The publication plan

The first shape, set by issue 29. Later slices add members (the forced removals, the edits of the configuration).

| Key       | Value                                            |
| --------- | ------------------------------------------------ |
| `publish` | The vault paths of the notes to publish. Sorted  |
| `remove`  | The vault paths of the published notes to remove |
| `update`  | The vault paths of the published notes to update |

The plan of the skeleton, which finds nothing:

```json
{
    "publish": [],
    "remove": [],
    "update": []
}
```

## Cleaned notes

A cleaned note is Markdown text. The encoding rules above apply. The ticket that writes the cleaning step adds its rules here before the second implementation is written.

## How it is tested

1. Shared cases: `fixtures/canonical/cases.json` holds values and the text that each must give, written by hand. The TypeScript writer (`apps/plugin/src/publishing/canonical.spec.ts`) and the Rust writer (`cli/src/canonical.rs`) both read that file.
2. Parity tests: `parity/` holds tests that run both implementations on the fixture vault and compare the bytes. They are part of `bun run test`, so CI fails when they fail.
3. The Rust tests of the program (`cli/tests/`) state the same expected text, and they also run on Windows.
