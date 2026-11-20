# Note page budgets (issue 25, PROTO-07)

Date: measured on 2026-11-20. The page and the runner are on the branch `prototype/note-page-budgets` (`prototypes/note-page-budgets/`), and are not merged. Every note of the measure is invented. The decisions of the author are R57 in `documentation/plans/decisions.md`.

## Question

Which numbers block a release of the default note page (PERF-20), which budgets do the exempt page types get (PERF-21), and how does CI check them (PERF-22, PERF-23)? The budgets must be stricter than the field targets: Largest Contentful Paint (LCP) at most 2.5 s, Interaction to Next Paint at most 200 ms, Cumulative Layout Shift (CLS) at most 0.1, at the 75th percentile.

## Answer

The author accepted every proposed number (R57).

### The default note page

These block a release. CI checks them on the sample notes of each note type (PERF-22).

| Budget                              | Number                                                                     | Measured on the prototype                    |
| ----------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------- |
| HTML of the page                    | at most 30 KB with Brotli                                                  | 12.3 KB (long), 8.5 KB (hub), 5.3 KB (media) |
| Backlinks in the HTML               | at most 50; the rest on their own page                                     | 489 backlinks: 39.2 KB, 1,724 elements       |
| CSS                                 | one file, at most 12 KB with Brotli                                        | one file, 6.5 KB (37 KB raw)                 |
| Script that loads with the page     | at most 10 KB with Brotli, in total                                        | 1.1 KB, inline only (3.4 KB raw)             |
| Fonts                               | one file, preloaded, at most 40 KB                                         | 35.9 KB (Noto Sans, Latin, variable weight)  |
| Requests before the page shows      | at most 3, all on the host of the notes                                    | 3: the HTML, the CSS, the font               |
| Images                              | the first image loads at once with a high priority; the others load lazily | as built by the variant `tuned`              |
| LCP, mobile, a note without a cover | at most 1.2 s                                                              | 0.84 s (long), 0.85 s (hub)                  |
| LCP, mobile, a media note           | at most 2.0 s                                                              | 1.91 s (cover of 142 KB)                     |
| LCP, desktop                        | at most 0.8 s                                                              | 0.29 s to 0.57 s                             |
| CLS, mobile and desktop             | at most 0.02                                                               | 0                                            |
| Total Blocking Time (TBT), mobile   | at most 100 ms                                                             | 0 ms                                         |
| TBT, desktop                        | at most 50 ms                                                              | 0 ms                                         |

The times are Lighthouse lab values, the median of 5 runs. Mobile is the default of Lighthouse: a simulated slow 4G network (150 ms round trip, 1.6 Mbit/s) and a CPU 4 times slower. TBT is the lab measure that stands for Interaction to Next Paint.

### The exempt page types

Each exempt type keeps every budget of the note page. Its extra code and data load only after the page shows, so its LCP and its CLS are those of the note page. The extra budgets, with Brotli:

| Type       | Extra budget                                                                      | Measured                                                                                                        |
| ---------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Music note | the music library at most 160 KB, only on a page with a music block (REN-07)      | `music-notation.publish.min.js`: 148 KB (0.23.1, the version of today), 153 KB (0.26.0)                         |
|            | tabs and scores at most 300 KB more, only on a page with a `tab` or `score` block | `music-notation.tab.min.js` 44 KB and alphaTab 251 KB                                                           |
|            | sound fonts at the first Play, not counted                                        |                                                                                                                 |
| Graph page | the graph library at most 60 KB                                                   | `force-graph` 48 KB                                                                                             |
|            | the graph data at most 600 KB                                                     | 538 KB for 20,734 nodes and 119,440 links with the titles; 307 KB without the titles (positions and links only) |
|            | the view for phones is lighter (GRAPH-03); its numbers are set in its slice       |                                                                                                                 |
| Search     | nothing at page load (SRCH-08); the first search at most 350 KB                   | about 300 KB with Pagefind on 20,735 invented notes (see below)                                                 |

### Notes larger than the budget

29 published notes have more than 100 KB of Markdown, and the largest has 2.37 MB. Their pages are larger than the HTML budget. The build lists each real page above the HTML budget with its size, as a warning, and does not stop (R57). The page stays whole and readable without JavaScript (PAGE-01). The CI sample uses invented notes, so these notes do not stop CI.

### How CI checks the budgets

Byte sizes and request counts give the same result on each run: they block at once. Lighthouse runs 5 times per page; when a time budget fails, CI runs it 5 times again and blocks only when the second median fails too. CLS always blocks (R57). Slice 47 builds the check.

## Method

### The page

The note page of variant B (R49) on the rendering of issue 45: the title band, the outline in a left rail, the author, the cite block and the share row in a right rail on wide screens. The blocks that have no slice yet (in short, part of, properties, related notes, ad, cite, share, local graph, newsletter) keep the invented content of the mockups, so that their weight is in the page. The backlinks are real: the build reads them from the manifest, each with the line of the linking note around the link, at most 50. The prototype replaces the page of `apps/site/src/pages/-/note/[id].astro` on its branch.

Three builds:

1. `capped`: the page as the design base gives it (the font with `font-display: swap` and no preload, every image lazy), 50 backlinks at most.
2. `tuned`: the same, with the Latin font file preloaded, and the first image of the note loaded at once with `fetchpriority="high"` (PERF-25). This is the page that slice 47 must build.
3. `uncapped`: every backlink in the HTML, for the hub note only.

### The notes

The runner writes an invented vault (`vault.ts`, seed 25) and publishes it with the publishing tool into a local content store: 562 notes. Three of them are measured. Their shape follows the published notes of the author at a high percentile. The shape was counted read only on his export (`.cache/published`), numbers only:

| Count on the 20,734 published notes | 50th  | 90th  | 95th   | 99th   | Largest   |
| ----------------------------------- | ----- | ----- | ------ | ------ | --------- |
| Markdown of the body, bytes         | 536   | 4356  | 8790   | 23533  | 2,372,776 |
| Headings                            | 7     | 9     | 12     | 24     | 236       |
| Wikilinks to notes                  | 0     | 12    | 22     | 63     | 10,439    |
| Images in a note                    | 1     | 1     | 1      | 4      | 64        |
| Backlinks (distinct notes)          | 4     | 11    | 16     | 37     | 489       |
| Size of an image file, bytes        | 24506 | 80331 | 156483 | 586235 | 4,596,629 |

121 notes have more than 50 backlinks, 28 more than 100. 153 notes hold a music block, 9 a Mermaid diagram, 7 a math block, 310 a video or a YouTube link.

| Measured note | Shape                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Long note     | 23.1 KB of Markdown, 24 headings, 64 links, 4 images of 80 KB (90th percentile), a callout, a code block, a table, lists, a quote |
| Media note    | a cover of 142 KB (about the 95th percentile) first, my notes, 8 highlights, 3 images of 80 KB, a video of 1.9 MB                 |
| Hub note      | a map of content of 1.8 KB, linked from 489 notes (the largest count), each link inside a sentence                                |

The images are noise photos made by ImageMagick at a target size, the video is made by ffmpeg.

### The host and the runs

The plain local server of the site serves the build, behind a proxy that compresses the text with Brotli (quality 11), as the host does. Lighthouse 13.6.0 in Chrome (headless), category performance, mobile (its default) and desktop (`--preset=desktop`), 5 runs per page and preset, the median. A run starts only when the load of the last minute of the machine is at most 4 (12 cores). The first full run ran during a backup of the machine (load average 24): its blocking times went from 18 ms to 1,700 ms for the same page, and the bytes were the same. The tables hold the second run, on a quiet machine (CPU benchmark index of Lighthouse 1,600 to 2,200).

## Results

### Bytes (Brotli, quality 11)

| Page                   | HTML    | HTML raw | Note text | The rest of the HTML | Elements |
| ---------------------- | ------- | -------- | --------- | -------------------- | -------- |
| Long note              | 12.3 KB | 47.2 KB  | 8.3 KB    | 4.2 KB               | 490      |
| Media note             | 5.3 KB  | 20.0 KB  | 1.6 KB    | 3.7 KB               | 235      |
| Hub note, 50 backlinks | 8.5 KB  | 36.4 KB  | 0.7 KB    | 7.9 KB               | 410      |
| Hub note, 489          | 39.2 KB | 193.1 KB | 0.7 KB    | 38.5 KB              | 1,724    |

Every page: one CSS file of 6.5 KB (37.1 KB raw), one font file of 35.9 KB, no script file, 3.4 KB of inline script (1.1 KB with Brotli: the mode, the switch of the mode, the old anchors). One backlink with its line costs about 300 bytes raw.

### Lighthouse (median of 5)

| Build    | Page       | Preset  | LCP    | First paint | TBT   | CLS   | Transfer |
| -------- | ---------- | ------- | ------ | ----------- | ----- | ----- | -------- |
| capped   | long note  | mobile  | 0.75 s | 0.75 s      | 0 ms  | 0.179 | 137 KB   |
| capped   | long note  | desktop | 0.20 s | 0.20 s      | 0 ms  | 0.102 | 137 KB   |
| capped   | media note | mobile  | 1.17 s | 0.78 s      | 0 ms  | 0.017 | 194 KB   |
| capped   | media note | desktop | 0.32 s | 0.20 s      | 0 ms  | 0.001 | 273 KB   |
| capped   | hub note   | mobile  | 0.80 s | 0.80 s      | 0 ms  | 0.017 | 55 KB    |
| capped   | hub note   | desktop | 0.25 s | 0.25 s      | 0 ms  | 0.002 | 55 KB    |
| tuned    | long note  | mobile  | 0.84 s | 0.84 s      | 0 ms  | 0     | 137 KB   |
| tuned    | long note  | desktop | 0.29 s | 0.29 s      | 0 ms  | 0     | 137 KB   |
| tuned    | media note | mobile  | 1.91 s | 0.86 s      | 0 ms  | 0     | 194 KB   |
| tuned    | media note | desktop | 0.57 s | 0.31 s      | 0 ms  | 0     | 273 KB   |
| tuned    | hub note   | mobile  | 0.85 s | 0.85 s      | 0 ms  | 0     | 55 KB    |
| tuned    | hub note   | desktop | 0.30 s | 0.30 s      | 0 ms  | 0     | 55 KB    |
| uncapped | hub note   | mobile  | 0.97 s | 0.97 s      | 30 ms | 0     | 86 KB    |
| uncapped | hub note   | desktop | 0.30 s | 0.30 s      | 0 ms  | 0.002 | 86 KB    |

The long note loads one image at first (the others are lazy and below the first view), the media note the cover (and one more on desktop). The video sends only its metadata (350 bytes).

The live site of today, for comparison (Obsidian Publish, the home page, Lighthouse mobile, 3 runs): 14.0 MB transferred, LCP 68 s to 70 s, TBT 5.0 s to 6.0 s, CLS 0.002, performance score 35.

### Findings for slice 47

1. The font causes the layout shift. With `font-display: swap` and no preload, the text is drawn first with a fallback font and moves when Noto Sans arrives: CLS 0.18 on mobile and 0.10 on desktop for the long note, above the field target. A preload of the Latin font file removes it (0 on every page). Lighthouse also names the lazy images as a cause, but the images have their width and height, and the shift is gone with the preload alone.
2. The cover of a media note must not be lazy. With `loading="lazy"` the LCP of the media note on mobile varies from 1.2 s to 2.0 s between runs, because the cover sometimes counts and sometimes does not. Loaded at once with a high priority, it is the LCP element every time, at 1.9 s. The cover of 142 KB is most of that time on slow 4G: responsive sizes and a modern format (PERF-25) are the next gain.
3. 50 backlinks cost 3.7 KB with Brotli. All 489 backlinks of the largest hub cost 34 KB (31 KB and 1,300 elements more than 50 backlinks), and give the first blocking time (30 ms on mobile). PAGE-03 holds: at most 50 in the page.
4. The CSS of the design base is small (6.5 KB) and the page sends no script file: the budgets leave room for the properties panel, the palette loader, the analytics script and the newsletter bar.
5. The CPU times of Lighthouse are not stable on a busy machine (finding of the first run). CI must check the bytes first and give a time budget a second chance (R57).

### The exempt types in detail

Music: the files of the CDN of today, compressed here with Brotli: `music-notation.publish.min.js` 0.23.1 is 663,759 bytes raw (the research of 2026-11-17 noted 551 KB), 181 KB with gzip, 148 KB with Brotli; 0.26.0 is 679,795 bytes raw and 153 KB with Brotli; `music-notation.tab.min.js` 0.23.1 is 167 KB raw and 44 KB with Brotli; `alphaTab.min.js` 1.x is 1.21 MB raw and 251 KB with Brotli.

Graph: `force-graph.min.js` 1.x is 173 KB raw and 48 KB with Brotli (the library of an inspiration site, research of 2026-11-17, item 83). The data: a JSON file of the published notes as nodes with a position and a title, and the distinct links between two published notes as pairs of numbers: 2.58 MB raw, 731 KB with gzip, 538 KB with Brotli; without the titles 1.74 MB raw and 307 KB with Brotli. The positions are random numbers with one decimal, as a layout at build time would give. A link here is a wikilink whose file name is the name of a published note, so the count is near the real one, not exact.

Search: Pagefind 1.6.0 on the 20,735 invented notes of `bun run corpus`, one HTML page per note with its text (308,588 words indexed). A first search loads `pagefind.js` (12 KB with Brotli), the WebAssembly file (60 KB), the metadata file (160 KB: it grows with the number of pages), one or two index parts (28 KB each at the median) and one fragment per shown result (1.7 KB at the median). For two index parts and five results: about 300 KB. The invented words are not English, so a real index can differ.

## Not verified

1. A real phone, and a field measure: the times are lab values of one machine.
2. Lighthouse on a CI runner: slice 47 measures there.
3. The real notes of the author on the page: the measure uses invented notes of the same shape.
4. The real size of the music, graph and search pages: their slices measure them against these budgets.
