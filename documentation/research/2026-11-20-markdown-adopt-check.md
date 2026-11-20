# Adopt check of the Markdown conversion (issue 26, PROTO-08)

Date: measured on 2026-11-19 and 2026-11-20. The runner is on the branch `prototype/markdown-adopt-check` (`prototypes/markdown-adopt-check/`), and is not merged. Every note of the corpus is invented. The decision of the author is R50 in `documentation/plans/decisions.md`.

## Question

Before own code is written for the conversion of Obsidian Markdown (BUILD-10, D49), do `astro-loader-obsidian` or the transformers of Quartz fit? Where is the line between the cleaning step and the conversion? Which form do the heading anchors of the current site have (OPEN-15, URL-14)?

## Answer

1. Use parts (decision of the author, R50). The parser is `@quartz-community/remark-obsidian` (legacy preset). The site moves from the Sätteri processor of Astro 7 back to the remark processor (`@astrojs/markdown-remark`). The rendering is own code: rehype steps written against the corpus. The link plugin of issue 34 is ported to the tree of remark.
2. Mermaid diagrams are rendered by Pele at build time (decision of the author, R50).
3. Canvas files and Bases come after the switch: issue 82 (Canvas) and issue 83 (Bases), each with an adopt check of the Quartz page plugin first (decision of the author, R50). Until then REN-11 and REN-14 hold.
4. `astro-loader-obsidian` is not used.

## The corpus

`fixtures/markdown-forms.json` lists 47 forms of issue 12. Each form names one invented note of the fixture vault (most of them in `50 Field guide/`) and checks on the HTML that a conversion gives for that note alone. A check says that an element must exist (a CSS selector, an optional text and an optional count), that a text must not appear anywhere in the HTML, or that headings have distinct ids. The checks come from spec v2 (REN, CARD, URL-14) and from the reading view of Obsidian where the spec names no markup (`data-callout`). `checkHtml()` of `packages/testing` runs them with the HTML rewriter of Bun. The rendering slice (issue 45) runs the same corpus on the site.

## The candidates

Each candidate gets the same input: the note without its properties, the same published set (every new note of the fixture vault, except the note that the tests never select), and the link rule of this project after the conversion, because the project has one resolver (ADR 0005).

1. `satteri-today`: the site of main. The tool publishes the fixture vault, the site is built and served, and the runner reads the text of each note page.
2. `quartz-v5`: the transformer packages of Quartz v5 (`@quartz-community/obsidian-flavored-markdown` 2.2.0, `github-flavored-markdown` 2.1.1, `latex` 1.0.2, `syntax-highlighting` 1.0.3) on unified, in the order of the default Quartz configuration.
3. `astro-loader-obsidian` 0.10.0, in an Astro 5 project of its own (Astro 5.18.2), because it declares Astro 5 only.

## Result per form

Cell: pass, or fail with the failed checks of all checks of the form.

| Form                    | Sätteri today | Quartz v5  | astro-loader-obsidian |
| ----------------------- | ------------- | ---------- | --------------------- |
| wikilink-note           | pass          | pass       | pass                  |
| wikilink-heading        | fail (2/3)    | pass       | fail (1/3)            |
| wikilink-block          | fail (1/2)    | pass       | pass                  |
| wikilink-alias          | pass          | pass       | pass                  |
| wikilink-hard-names     | pass          | pass       | fail (2/4)            |
| wikilink-unpublished    | pass          | pass       | pass                  |
| wikilink-missing        | pass          | pass       | pass                  |
| wikilink-duplicate-name | pass          | pass       | pass                  |
| wikilink-own-heading    | fail (1/2)    | pass       | fail (1/2)            |
| markdown-link-note      | pass          | pass       | fail (1/3)            |
| embed-image-size        | fail (2/6)    | pass       | fail (4/6)            |
| embed-image-in-link     | fail (2/2)    | pass       | pass                  |
| embed-note              | fail (2/3)    | fail (2/3) | pass                  |
| embed-heading           | fail (1/3)    | fail (1/3) | pass                  |
| embed-block             | fail (2/4)    | fail (2/4) | fail (1/4)            |
| embed-cycle             | fail (1/2)    | fail (1/2) | fail (1/2)            |
| embed-pdf               | pass          | pass       | pass                  |
| embed-audio             | pass          | pass       | pass                  |
| embed-video             | pass          | pass       | pass                  |
| embed-base              | pass          | pass       | fail (1/3)            |
| embed-canvas            | pass          | fail (1/3) | fail (1/3)            |
| callout-types           | fail (5/5)    | fail (1/5) | fail (5/5)            |
| callout-folded          | fail (4/4)    | fail (1/4) | fail (4/4)            |
| callout-nested          | fail (3/3)    | pass       | fail (3/3)            |
| callout-title           | fail (3/3)    | pass       | fail (3/3)            |
| frozen-dataview-table   | fail (2/4)    | fail (2/4) | pass                  |
| frozen-dataview-list    | fail (2/4)    | fail (2/4) | pass                  |
| link-block              | fail (3/8)    | fail (2/8) | fail (2/8)            |
| video-url-line          | fail (2/3)    | fail (3/3) | fail (2/3)            |
| meta-bind-inline        | fail (2/3)    | fail (2/3) | fail (2/3)            |
| meta-bind-block         | fail (4/4)    | fail (4/4) | fail (3/4)            |
| live-dataview           | fail (4/4)    | fail (4/4) | fail (3/4)            |
| live-base               | fail (2/2)    | fail (2/2) | fail (2/2)            |
| comment-percent         | fail (3/6)    | pass       | fail (3/6)            |
| comment-html            | fail (3/4)    | fail (3/4) | pass                  |
| tags                    | fail (3/5)    | fail (3/5) | fail (2/5)            |
| footnotes               | fail (3/5)    | pass       | fail (3/5)            |
| highlights              | fail (3/3)    | pass       | fail (3/3)            |
| math-inline             | fail (2/3)    | fail (1/3) | fail (2/3)            |
| math-block              | fail (2/3)    | fail (1/3) | fail (2/3)            |
| mermaid                 | fail (2/4)    | fail (1/4) | fail (3/4)            |
| table-pipe-in-link      | pass          | pass       | fail (1/4)            |
| task-list               | fail (3/4)    | fail (3/4) | fail (3/4)            |
| properties              | pass          | pass       | pass                  |
| headings-same-text      | pass          | pass       | pass                  |
| code-block              | fail (1/2)    | fail (1/2) | fail (1/2)            |
| raw-html                | fail (3/4)    | fail (3/4) | fail (3/4)            |
| **passed** (of 47)      | 15            | 24         | 17                    |

Every failure is quiet: no candidate stops on a form. The only error is the build of `astro-loader-obsidian`, below.

## What each candidate does

### Sätteri today

The site of main reads CommonMark and GFM. Every form that Obsidian adds is missing: callouts, highlights, `%%` comments, tags, math, inline footnotes, embeds of notes, heading and block links, image sizes in Markdown images, custom task marks. Facts that matter for issue 45:

1. A `%%` comment, an HTML comment and the markers of a frozen query reach the HTML of the page. REN-03 says that they must not. The site is not live.
2. A `<script>` element and an `onclick` attribute of a note reach the page. REN-15 asks for an allow list of elements. The site is not live.
3. Code blocks get inline styles from the highlighter (REN-06 asks for classes).

Sätteri is the fastest processor (below). Its parser has a `wikilinks` feature for `[[T]]` and `[[T|L]]` only, and no hook for `%%`, `==` or callouts.

### Quartz v5 transformers

The best result: 24 of 47 forms with no change. The parser, `@quartz-community/remark-obsidian` 2.2.1, is a standalone remark plugin: MIT, no runtime dependency, its own vendored copy of the remark-parse 8 fork that Obsidian uses. Its repository says that its legacy preset matches Obsidian 1.15.0 on 3,469 of 3,471 recorded cases, measured with a harness inside the app (a claim of the repository: the harness was not run here). The transformer package wraps it with the rendering.

What it does not do, and what is own code in every option:

1. Embeds of notes, headings and blocks become a placeholder (`blockquote.transclude`). Quartz fills them in its core, which is not a library.
2. Links come out as raw vault paths. Quartz resolves them in its core. Here the link rule of this project resolved them, which passed every link form but the heading display.
3. HTML comments and the markers of frozen queries stay in the HTML (`allowDangerousHtml`).
4. Meta Bind code, live Dataview and live base blocks stay as code blocks.
5. `LINK` blocks and the video URL line are not cards. The video URL line becomes an `iframe` of YouTube (against CARD-07 and CARD-09).
6. KaTeX and Shiki write inline styles (REN-06). Mermaid stays as source for a script in the browser, or for Pele in the browser.
7. Raw HTML is not filtered: a `<script>` passes (REN-15).
8. Smaller differences with Obsidian: a tag shows without its `#`, the alias `faq` of a callout becomes `question`, an open folded callout has no `+` mark, a custom task mark (`- [/]`) is no checkbox, and each heading gets an anchor link with an icon.

Packaging: the LaTeX package imports `@myriaddreamin/rehype-typst` at load time, but declares it as an optional peer. Without it the import fails. The full transformer is a bundle of 1.5 MB with 17 runtime dependencies.

### astro-loader-obsidian

Not usable:

1. The last release (0.10.0) and the last commit are of 2025-09-07. It declares `astro ^5.12.5`, so it does not install with Astro 7, and it uses zod 3.
2. It reads the vault folder itself, and resolves links with its own fuzzy match on file names. No option takes another resolver (ADR 0005).
3. Its default schema refuses the date form that Obsidian writes (`created: 2031-03-05T10:00`, no seconds): the build stops on every note. The runner gives it an open schema.
4. The first build on a clean cache fails: a Markdown image named by its file name alone (`![…](garden-plan.png)`, valid in Obsidian) is not found by the image step of Astro. A second build passes on the cache of the first one. The forms were measured on the second build.
5. It has no code for callouts, comments, highlights, math or Mermaid: its companion theme adds remark plugins for them.

## Speed

The time to convert the 20,735 notes of the invented corpus (`bun run corpus`) to HTML, with no syntax highlighting, one converter per process, on the machine of the author (`measure-speed.ts`):

| Converter                                        | Time   | Notes per second | Memory (RSS) |
| ------------------------------------------------ | ------ | ---------------- | ------------ |
| Sätteri (Astro 7)                                | 1.7 s  | 12,445           | 346 MB       |
| `remark-obsidian` and `rehype-obsidian`          | 18.2 s | 1,142            | 385 MB       |
| Quartz Obsidian and GitHub Flavored transformers | 95.0 s | 218              | 477 MB       |

The page, the links and the render cache of Astro are not part of the measure. With the render cache of BUILD-04, a full conversion runs only when the renderer changes. No speed work is done before the author used a first version (R43).

## Pele

Pele (`pele` 1.13.0 on npm, MIT, from the Obsidian team, `github.com/obsidianmd/pele`) renders Mermaid to SVG. Measured in Bun with no browser (`pele-check.ts`): about 10 ms for the first invented diagram, SVG with no script, and colors through CSS variables (`--pele-bg`, `--pele-fg` and more), so one SVG works in both modes (REN-08, BUILD-09). The SVG has 4 `style` attributes, mostly the declarations of these variables: the rendering slice moves them to classes (REN-06). The Quartz transformer can use Pele, but loads it in the browser.

## The line between cleaning and conversion

The cleaning step (the publishing tool, two implementations) stays as it is: it changes no character of a note, and it writes the facts that the build cannot find alone (links, attachments, aliases) into the manifest. The conversion (the build, TypeScript only) does all the rest: it removes comments, Meta Bind code, the markers of frozen queries and live queries from the page, and it renders every form. So the raw Markdown of a note (`/-/md/<path>.md`) keeps the comments, as REN-03 and business rule 18 say. No rule of the conversion needs a Rust twin.

## Heading anchors of the current site (OPEN-15)

Measured on 2026-11-19 in Chrome, on public notes of notes.dsebastien.net (Obsidian Publish). The examples here are invented.

1. A heading has no `id`. It has the attribute `data-heading` with its text.
2. A link `[[Note#Heading]]` of a note gets the `href` of the note, then `#` and the heading text as the link writes it (`…/Note#Panels: a review`). The outline writes the hash with the text as `%20`-encoded, without `:`.
3. When a page loads, a hash is matched to a heading by its text: in any letter case, with `+` or `%20` for a space, with or without punctuation such as `:`. An emoji of the heading must stay. The site then writes the hash again with `+` for a space (`#panels+a+review`).
4. A slug (`#panels-a-review`) and an unknown text do not match: the page opens at the top, and the hash is removed.
5. Two headings with the same text get the same hash, and it leads to the first one. The form `#Parent#Child` leads to the child under that parent.
6. Not checked: two direct loads of a note URL answered "Not found" in the app of the current site, one with a raw comma in its path (the app writes it `%2C`) and one without. The same notes opened from inside the app. A point for the run on the URLs of today (issue 44).

So URL-14 needs more than stable ids: a static `id` cannot hold a space, so an old anchor reaches its heading only through a small script that reads the hash with the rules above, or through ids that the old forms can never be. The rendering slice decides the form of the ids.

## How much each form is used

The count per form on the published notes of the author is in the private repository (`.private/analysis/2026-11-19-markdown-forms-count.md`), made with `count-forms.ts` on the branch of the prototype. In short: images with a size, frozen queries, inline Meta Bind code and tags are on a large part of the notes; `LINK` blocks, embeds of notes, heading links, links in tables and code blocks are on many; Mermaid, math, callouts, footnotes and highlights are on a few; nested callouts, custom task marks and canvas embeds are on none.

## What issue 45 builds from this

1. The remark processor of Astro with `remark-obsidian` (legacy preset), and the port of the link plugin of issue 34.
2. Own rehype steps, each against its forms of the corpus: callouts (with `data-callout` and folding), the display text of heading links, embeds of notes, headings and blocks from the content store (depth limit, cycle check), images with a size, removal of comments, markers, Meta Bind code and live queries, tags, task lists with custom marks, class-based highlighting and math, Mermaid with Pele, and an allow list of HTML elements.
3. `LINK` blocks and the video URL line are the cards of CARD-01 to CARD-09 (issue 45 or the cards slice).

## Sources

- https://github.com/quartz-community/remark-obsidian
- https://github.com/quartz-community/rehype-obsidian
- https://github.com/quartz-community/obsidian-flavored-markdown
- https://github.com/jackyzha0/quartz (branch v5, release v5.1.0)
- https://www.npmjs.com/package/@quartz-community/canvas-page
- https://www.npmjs.com/package/@quartz-community/bases-page
- https://github.com/aitorllj93/astro-loader-obsidian
- https://www.npmjs.com/package/astro-loader-obsidian
- https://pele.run and https://github.com/obsidianmd/pele
- https://www.npmjs.com/package/@astrojs/markdown-satteri
- https://github.com/bruits/satteri
