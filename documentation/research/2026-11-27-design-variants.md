# Design variants and the link color (issue 116)

Date: 2026-11-27. Branch: `spike/116-design-variants`. Every page of the prototype shows notes of the fixture vault only.

## The question

The author finds the site flat and dull, and the links do not read as the Knowii brand: in the dark mode a link has the color of the text with a pink underline (DES-05). Which look becomes the new default theme? The author picks from the variants below. This file records his choice once he made it.

## How to see the variants

1. Build and serve the fixture site: `bun run site:fixture --sample` (with `--port <port>` when 4322 is taken).
2. Open any page. The header has a select, "Today", "Signal", "Marker", "Aurora", left of the switch of the mode. A change shows the variant at once and keeps it for the next pages (local storage, key `design`). The switch of the mode works in each variant.
3. A link can name a variant: `?design=signal` on any address shows it and stores it. `?design=knowii` goes back to the look of today.

The pages to compare: the home page, a note page with links, backlinks and properties (`/10+Garden/Compost+basics`; open the properties panel), a list page (`/-/types/permanent-notes`), and the search page (`/-/search`). The outline shows on `/95+Budget+sample/Long+note`.

## The variants

Each variant is a theme: one file of token values in `apps/site/src/styles/themes/`, with a dark and a light mode, and no component of its own (DES-02). The corners of chips, pills and badges stay small in every variant: 4 to 6 px, never a full pill radius.

### 0. Today (`knowii`)

The look of today, value for value. It stays as a theme of its own, whatever the choice.

- Link: the text color with a 2 px pink underline (dark), magenta text with a magenta underline (light).
- Surfaces: flat fills with a thin border, no shadow at rest.

### 1. Signal (`signal`)

The Knowii magenta up front, on a deeper slate.

- Link: brand pink text (`#ff6fb5` dark, `#b8005f` light), medium weight, a thin pink underline that thickens under the pointer. The same style in the text of a note, in the lists of the home page and in the backlinks.
- Color: magenta type badges, a magenta strip under the header, a magenta bar before each section title, pink section titles set in a mono font, a magenta glow in the corner of the hero and of the title band.
- Surfaces and depth: cards with a light top edge and a dark shadow at rest; under the pointer the edge turns magenta and the card casts a magenta glow.
- Type: heavy titles (800) with tight letter spacing.
- Motion: quick (120 ms), a soft ease.

### 2. Marker (`marker`)

A notebook with ink and a highlighter: the most playful variant.

- Link: the text color with a thick magenta marker stroke under the words; under the pointer, the marker fills the whole word (a deep magenta band in the dark mode, a pale pink band in the light mode), drawn as an inner shadow, so the hover changes only a shadow.
- Color: warm plum (dark) or paper cream (light), yellow type badges, pink section titles with a small magenta square.
- Surfaces and depth: crisp corners (4 to 6 px) and hard offset shadows, like cut paper; under the pointer the shadow turns magenta and grows. A dot grid on the page, thin diagonal ruling in the title band.
- Type: serif titles from the fonts of the system (Iowan Old Style, Palatino, Noto Serif, Georgia): no font file, so no extra request.
- Motion: the marker fades in (260 ms).

### 3. Aurora (`aurora`)

Layers of light: the deepest variant.

- Link: soft pink text (`#f9a8d4` dark, `#b0005f` light), no underline, a 2 px magenta to violet gradient line under it; under the pointer the text turns white (dark) or violet (light) and a thicker violet line replaces the gradient.
- Color: deep indigo (dark) or lilac white (light), glows of magenta and violet at the top of the page, violet type badges, lavender section titles with a magenta bar, violet nodes in the network of the hero.
- Surfaces and depth: large rounded cards (18 px) with a light gradient and long soft shadows; under the pointer a violet glow and a thin magenta ring. The title band fades from the surface to the page.
- Type: the heaviest titles (800) with the tightest letter spacing.
- Motion: a magenta to violet strip under the header that drifts slowly (14 s); slower, smoother transitions (200 to 320 ms).

## Screenshots

Taken with the browser seam of the repository (`launchChrome()` of `packages/testing`) on the fixture site, full page, for each variant, each mode and each width (390 and 1440 px): the home page, the note page with its properties panel open, a list page and the search page. They are not in the repository (64 files, 12 MB). On the machine of the spike they are in the scratch folder of the session, named `<variant>-<mode>-<width>-<page>.png` (`home`, `Compost+basics`, `permanent-notes`, `search`). To make them again: serve the fixture site and open the pages with `?design=<variant>`.

## Contrast (WCAG AA)

`apps/site/src/design.spec.ts` checks every theme file in both modes. Text, muted text, links, links under the pointer, the hover text of the outline and the section titles reach 4.5:1 on the background, the surfaces, the well and the glow (the color of the decoration of a band and of the page). Focus rings and the lines under links reach 3:1 on the same fills. The text of a badge reaches 4.5:1 on its fill and on its fill under the pointer; a link reaches 4.5:1 on the band of the marker. Every decoration with text on it (a glow, a gradient, a dot grid, the ruling of a band) is made of these checked colors. All four themes pass.

## Motion (DES-09)

Every duration is a token (`--duration-quick`, `--duration-sweep`, `--duration-ambient`), and the one rule of `tokens.css` sets all three to 0 when the reader asks for less motion. Checked in Chrome with Aurora: the drift of the strip goes from 14 s to 0 s, the transition of a link from 0.32 s to 0 s. The network of the hero keeps its own rule (issue 81). No hover moves an element: a hover changes only colors, lines and shadows (section 15.1.1 of the spec).

## Budgets of the note page

The variants share one style sheet: all four themes are in it. The CSS of the empty site grows from 7,620 to 9,714 bytes with Brotli (budget 12,000); `page-budgets.spec.ts` passes on the fixture site. No variant adds a request: Marker takes its serif titles from the fonts of the system.

`bun run budgets` was run for each variant, with the variant set on the root of every page for the run (a change of `Page.astro` that is not committed). Medians of five Lighthouse runs, mobile LCP of the long, the media and the hub note:

| Variant | Long note | Media note | Hub note | Result                         |
| ------- | --------- | ---------- | -------- | ------------------------------ |
| Today   | 912 ms    | 1,964 ms   | 897 ms   | passes                         |
| Signal  | 915 ms    | 1,936 ms   | 904 ms   | passes                         |
| Marker  | 891 ms    | 1,888 ms   | 898 ms   | passes (second run, see below) |
| Aurora  | 901 ms    | 1,938 ms   | 902 ms   | passes (second run, see below) |

TBT is 0 ms everywhere, and the desktop LCP is 315 to 600 ms.

One thing breaks the budget at times, in every variant and in the look of today: the layout shift of the long note of the budget sample. When the Latin font file arrives after the first paint, the text of the long note takes new line breaks and the paragraphs under it move by one line (0.113 on mobile, 0.13 on desktop; 0.020 with Marker, whose serif titles do not change). It is not caused by the variants: with the font held back by 800 ms in Chrome, the look of today shifts by 0.114, Aurora by 0.113 and Marker by 0.020; in an alternating Lighthouse run on the long note (desktop), `main` shifted 2 times out of 5 and the branch 1 time out of 5. In the first round on a busy machine, Marker (mobile 0.020, desktop 0.130) and Aurora (mobile 0.113) failed on this shift and the look of today had 1 and 2 runs of 5 above it; on the second round all passed. This flake is worth its own ticket: the preload of the font does not always win against the first paint.

## What changes in the code

- The token contract (`tokens.css`) grows: link style (line, thickness, offset, weight, fill, shadow under the pointer), link hover and highlight, the hover color of the navigation, the section title color and font, the display font, weight and letter spacing of titles, the glow, the badge, the edge of a card under the pointer, the color of the network, three shadows (card, card under the pointer, header), the fills of the page, the hero, the title band and the cards, the padding of a card, the space between the blocks of a note, the strip of the header, the marker of a section title, and three durations. Today's theme gives each of them the value of today.
- Components read them: `card`, `badge`, `link`, `display` (the titles), `section-title`, `site-header`, `hero`, `title-band`, the outline and the network of the hero.
- A select in the header and two inline scripts (`designs.ts`) switch the variant. They are for the comparison only and go away once the author picked, unless he wants the reader to keep a choice of theme.

## What will change after the choice

Not done before the author picks:

1. DES-01 and DES-03: the default theme becomes the picked variant; the name of the theme of today is recorded (for example `knowii-classic`).
2. DES-05: the link style of the picked variant replaces "the text color with a pink underline".
3. DES-10: the variants that stay as themes are listed beside `classic`.
4. The code: the picked variant moves into the default blocks (`:root` and `[data-theme='light']`), `knowii-system.css` and `knowii-bar.ts` get its light mode and its header color, the variants that do not stay are removed, and so is the select of the header if no reader choice of theme is wanted.

## Known limits

1. The color of the bar of the browser (`theme-color`) keeps the header color of today in every variant.
2. The server error page (no script) shows the look of today.
3. Marker uses serif fonts of the system: the titles look a little different on each system. A self-hosted serif would add a font file, and the note page budget allows one request for a font (the preloaded Latin file of Noto Sans).

## Choice of the author

Not made yet.
