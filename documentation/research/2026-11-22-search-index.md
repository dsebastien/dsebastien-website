# Search index sizes (issue 51)

Measured on 2026-11-22 for the search slice (SRCH-01, SRCH-02, SRCH-04), against the budget of R57: a page loads nothing of the search, and a first search loads at most 350 KB. A KB is 1,000 bytes. "With Brotli" means quality 11.

Two vaults were measured. The invented corpus of `bun run corpus` (20,735 notes, seed 1). The export of the published notes of the author (`bun run corpus:published`, 20,734 notes), read only, numbers only: no name and no word of a note left the machine.

## 1. The title index as one file

The display titles (the `title` property, else the file name) and the aliases of every note, as one JSON file with columns (research of 2026-11-17, item 156).

| Vault     | Notes  | Aliases | Folders | Raw      | With Brotli |
| --------- | ------ | ------- | ------- | -------- | ----------- |
| Corpus    | 20,735 | 5,505   | 12      | 636 KB   | 218 KB      |
| Published | 20,734 | 13,743  | 1,847   | 2,121 KB | 394 KB      |

On the published notes, the titles are 254 KB with Brotli and the aliases 177 KB (161 KB without an alias that says its title again). One file is above the budget before the full text loads.

## 2. Pagefind 1.6.0

Pagefind indexed the 20,734 published notes (custom records of their text, one language) in 43 s on a machine with a load of 4.4. Its output: `pagefind.js` (47 KB raw), the WebAssembly file (60 KB, compressed already), the metadata file (142 KB, compressed already, it grows with the number of pages), 460 index parts (33 KB at the median) and 20,732 fragments (one per page). The output adds about 21,200 files to the site (the hosting research counts about 44,500 without it, of a limit of 100,000).

A search for one common word in Bun, with the files of the index on disk, fetched 281 KB: the script, the WebAssembly file, the metadata file, the index parts of the word and five fragments.

Behaviours that the slice relies on, checked on small indexes:

1. A page with a `data-pagefind-body` element indexes that element only; a page without one is skipped once any page has one.
2. `data-pagefind-meta` is read anywhere on the page.
3. The URL of a result is the URL that the build gives, joined to the option `baseUrl` of the page. Without `baseUrl: '/'`, the page puts the folder of the index in front of it.
4. An excerpt escapes `<` and `>`, not `&`, and marks the words of the query with `<mark>`. So a note that writes `&lt;` as text shows `<` in its excerpt: the two cannot be told apart.
5. A word that is not in the index finds the notes of a shorter start of it (a search for a name that no note holds found a note with "se").
6. Accents fold: "tome" finds "Tomé".

## 3. The title index in parts

The title index of the slice (`apps/site/src/search/titles.ts`): a part per key, where a key is the first two letters of a word of a title or an alias. A part above 96,000 characters of JSON is split by one more letter, up to 8 letters, and keeps its 200 best rows for a query of its key alone.

| Vault     | Parts | Split parts  | Largest part, with Brotli | 99th percentile | All parts    | Keys file, with Brotli | Build time   |
| --------- | ----- | ------------ | ------------------------- | --------------- | ------------ | ---------------------- | ------------ |
| Corpus    | 111   | not measured | 18.6 KB                   | not measured    | not measured | 0.2 KB                 | not measured |
| Published | 1,748 | 103          | 18.7 KB                   | 15.3 KB         | 3.2 MB       | 2.1 KB                 | 1 s          |

A query loads the keys file and one part: a complete part of one of its words first, else the deepest part. As the reader types, the titles answer at each key, so each prefix of a word loads its part until a complete part answers (`co`, then `com` when `co` is split). A part at 8 letters has no child: a longer word is answered by its best rows. The parts add about 1,750 files to the site.

## 4. The first search at full size

`bun run budgets:search` builds both indexes of a vault, writes the files of the title index as the build does, and measures, for the 12 most frequent words of the vault and 6 pairs of them, each in a process of its own. It runs the code of the search page (`createSearch` and `createSession`) over those files and counts what the page reads: a file that is compressed already as it is, any other with Brotli. The records of the full text carry a type label, as the fragments of real note pages do.

1. One search, the budget of R57 as the author decided after round 1 of the review (R63): the reader types the query, the titles answer at each key (the keys file and each part that a letter loads), and the full text answers the query: its first 10 results that the titles do not show, with a second batch when the titles show some of the first 10.
2. A typing session, reported and not a gate: the same, but the reader stops after each letter, so each prefix of two characters or more runs the full text too.

| Vault     | One search, median | One search, worst | Session, median | Session, worst | Sessions above 350 KB |
| --------- | ------------------ | ----------------- | --------------- | -------------- | --------------------- |
| Corpus    | 203 KB             | 245 KB            | 276 KB          | 388 KB         | 2 of 18               |
| Published | 174 KB             | 215 KB            | 246 KB          | 589 KB         | 4 of 18               |

A session costs most for two words: each stop inside the second word loads new index parts and new fragments. The full text from three characters in place of two does not change that (523 KB at worst on the published notes, with an earlier version of the measure). Two earlier versions of the measure copied the page instead of running it (the last query and one part: 220 KB and 265 KB at worst; then every part of the letters: 245 KB and 253 KB); their numbers are not comparable with the table.

The measure of the corpus takes about 4 minutes on a machine with a load of 5. The CI job `budgets` runs it on the corpus after `bun run corpus`, also when a time budget of the note page failed.
