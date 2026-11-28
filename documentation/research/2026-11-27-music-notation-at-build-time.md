# Music notation at build time (issue 28, PROTO-10)

Run on 2026-11-27. The question: can the music blocks of a note become SVG at build time, without a browser, and what is the budget of a music page (REN-07, PERF-21)?

**Answer: all ten languages can become SVG at build time, but the site draws all ten in the browser.** The author wants the player of the library on the pages, not pictures (comment on issue 28): a drawing made at build time has no playback, and the library would draw every block again in the browser to add it. So the build only keeps each block as the library reads it, and the page loads the library when it has a block (decision R105).

Everything ran on the invented note `fixtures/vault/20 Library/20.03 Music/Campfire song.md`, which has one block of each language, with the npm packages `@dsebastien/music-notation` 0.26.0 (the newest version; the current site uses 0.23.1), `@dsebastien/music-notation-sounds` 0.1.1 and `@coderline/alphatab` 1.9.0 (the version that the library names).

## 1. At build time, per language

The eight languages of the main part of the library: `renderBlock()` in Bun, with the DOM of happy-dom (the command `check` of the library uses linkedom the same way). The two languages of alphaTab: `parseTabSource()` of the library, then the score renderer of alphaTab with its SVG engine, in Bun.

| Language      | SVG at build time | Bytes of HTML | Time  | Inline styles                            |
| ------------- | ----------------- | ------------- | ----- | ---------------------------------------- |
| `chord`       | yes               | 2,981         | 13 ms | none                                     |
| `chords`      | yes (HTML chart)  | 975           | 33 ms | none                                     |
| `keyboard`    | yes               | 4,449         | 12 ms | none                                     |
| `fretboard`   | yes               | 6,169         | 8 ms  | none                                     |
| `strum`       | yes               | 4,197         | 3 ms  | none                                     |
| `picking`     | yes               | 17,287        | 8 ms  | none                                     |
| `progression` | yes               | 12,833        | 24 ms | none                                     |
| `circle`      | yes               | 19,708        | 7 ms  | none                                     |
| `tab`         | yes, with limits  | 10,510        | 36 ms | 49 `style` attributes (fonts, baselines) |
| `score`       | yes, with limits  | 5,023         | 4 ms  | 22 `style` attributes                    |

The limits of a tab and a score at build time: a fixed width (alphaTab lays out the systems for one width, so a phone would get the layout of a wide screen), the `style` attributes that REN-06 and the Content Security Policy refuse, the music font that the page must still load, and no player. None of the ten has playback at build time: the bars and the sounds need the browser.

## 2. The choice: the library in the browser, from the site

- The markup keeps each block as `<pre><code class="language-…">` with its source, the form that the library reads (it already did: nothing changes in the markup step).
- A note page whose body (its embeds included) holds a block of one of the ten languages gets one more module script (`components/Music.astro`, 0.6 KB with Brotli). A page without one gets nothing: no script, no style sheet, no file of the music.
- That script links the style sheet of the library and draws each block when it comes within one screen of the view, one block per task; it loads, at the first such block, the part that the blocks need: the diagram part (the main entry of the library and its voicings) or the tab part (alphaTab and the tab entry of the library), or both. A fretboard with `exercise:` draws a tab, so it loads both.
- Before it draws, the source of a block keeps the height of a usual drawing of its language (measured on the fixture note, on a wide screen and on a touch screen), so the page hardly moves when the block draws.
- Everything comes from the site: the packages are pinned in `apps/site/package.json` and the build gives their files with the other files of `_astro/`. The instrument files (GeneralUser GS, 133 files, 15 MB) are copied into `_astro/music-notation-sounds-0.1.1/generaluser/`; a player reads only the files of what it plays, at the first Play.
- The defaults of the current site: playback on, GeneralUser GS first, the light synthesizer when a file cannot be read; the texts of the bars in the language of the page; the empty blocks of a chord, scale or pattern note draw from its properties (a data block of the page, with only the properties that the library reads).
- The colors take the tokens of the theme in both modes (the theme variables of Obsidian, set on the text of the note); on a touch screen each control of a bar is 44 px and each field has a text of 16 px (section 15.1.1 of the spec).

What the Content Security Policy of issue 79 needs (`style-src 'self'`, no `'unsafe-inline'`):

1. No eval: neither the library nor alphaTab uses `eval` or `new Function`.
2. The library adds its style sheet as a `<style>` element unless the page has an element with the id `music-notation-styles`: the site links the file with that id.
3. The SVG of alphaTab holds `style` attributes, which the policy refuses; without them, the text and the numbers of a tab lose their font and their place. alphaTab draws on a canvas instead (its `html5` engine): no style at all.
4. alphaTab adds two `<style>` elements, which the policy refuses (one console error each). It skips the shared one, which a canvas does not need, when the page has an element with the id `alphaTabStyle`: the site adds one before alphaTab starts. The other declares the music font: the build adds the hash of its text to the policy when the site has the font, so no console error is left. An update of alphaTab that changes the text breaks the hash, and the Chrome test of the music page sees the violation.
5. The player of alphaTab synthesizes in a worker, which the build gives as a file of `_astro/` (`worker-src` falls back to `'self'`). Its audio worklet imports the core of alphaTab, so the build cannot give it as a file of its own, and the policy refuses the `data:` address that the build makes of it: the sound goes out through a script processor of the Web Audio API instead.

## 3. The budget of a music page

Measured with Brotli on the fixture site, in Chrome (`apps/site/src/music-page.spec.ts`):

| Part                                                | Measured     | Budget (R57, PERF-21)   |
| --------------------------------------------------- | ------------ | ----------------------- |
| The script with the page (the loader)               | 0.6 KB       | in the 10 KB of PERF-20 |
| The diagram part: code and style sheet              | 134.6 KB     | 160 KB                  |
| The tab part, on top of it: alphaTab and its loader | 293.1 KB     | 300 KB                  |
| The music font of alphaTab (WOFF2), tabs and scores | 313.3 KB     | not counted until now   |
| alphaTab's worker, at the first Play of a tab       | 1.26 MB raw  | at the first Play       |
| One instrument (a guitar), at the first Play        | about 110 KB | at the first Play       |

The proposed budget of a music page:

1. The page itself keeps every budget of PERF-20: the music loads after it shows.
2. The diagram part at most 160 KB with Brotli, as decided.
3. The tab part at most 300 KB more, as decided.
4. The music font of alphaTab at most 320 KB, a budget of its own: the budget of 2026-11-20 counted the scripts only, and a tab cannot draw without the font. It loads only on a page with a tab or a score (9 published notes today). The font has 313,348 bytes, 2% under the budget, which the author accepts: an update of alphaTab with a larger font breaks it, and a subset of the font in the music-notation library (point 1 of the open points) is the way to lower it.
5. Nothing of the sounds before the first Play.

The bytes are a test (`music-page.spec.ts`); the times of Lighthouse are the CI job `budgets`, which measures the music page with the others.

The times of Lighthouse on the music page (`bun run budgets --page 'music note'`, median of 5, behind Brotli), against PERF-20:

| Run                                    | Mobile                                | Desktop                         |
| -------------------------------------- | ------------------------------------- | ------------------------------- |
| Every block drawn at once              | TBT 403 ms (fails), CLS 0.000         | TBT 37 ms, CLS 0.000            |
| Near the screen, one block per task    | TBT 137 ms (fails), CLS 0.072 (fails) | TBT 0 ms, CLS 0.021 (fails)     |
| The same, with the place of each block | LCP 870 ms, TBT 92 ms, CLS 0.001      | LCP 323 ms, TBT 0 ms, CLS 0.003 |

The last row is the code of issue 53. The blocking time on a phone is close to its budget (100 ms): most of it is the first evaluation of the diagram part.

## 4. Open points

1. The music font could be cut to the glyphs that alphaTab uses (Bravura has about 3,000; a tab uses a few dozen), which would make it a few tens of KB. It is a build step of its own, and it changes the font of the library: a question for the library, not for the site.
2. Sound in a real browser with speakers was not heard: the test checks that the first Play reads the instrument files and starts the worker of alphaTab, with no error.
3. Before the switch, a check by hand of the published notes with music blocks on the preview host (the real blocks are not in this repository).

## Sources

- The README and the guide of the library (`docs/publish.md`, `docs/websites-and-apps.md`, `docs/blocks.md`), version 0.26.0.
- alphaTab 1.9.0, `dist/alphaTab.core.mjs` and `dist/alphaTab.mjs` (the style elements, the SVG canvas, the worker and the worklet).
- The measures of the current site: `2026-11-17-current-state.md` (section 1.7) and `2026-11-20-note-page-budgets.md`.

## Blocked time of the music page (2026-11-28)

On a phone, the blocked time of the music note varies between 38 and 121 ms from one run to the next on the same code. The drawing of a chord chart in the library is the main cost. The author set a budget of 150 ms for the music note only (`TIME_BUDGET.mobileMusic`); the other pages keep 100 ms. Issue 164 of the music-notation library tracks a faster drawing.
