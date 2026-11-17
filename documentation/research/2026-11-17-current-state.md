# Current state (2026-11-17)

Measured facts about the three existing sites and the publishing pipeline. Input for `documentation/plans/spec-v1.md`. Every number here was measured on 2026-11-17, from the vault, from the live sites, or from the Obsidian Publish site cache.

## 1. Notes site (notes.dsebastien.net, Obsidian Publish)

### 1.1 Why it is slow

- The site is a client-side application. The server returns the same small HTML shell for every path.
- Before the first note shows, the browser downloads the site cache: 13 MB compressed, 69 MB of JSON, 34,709 entries (every note and attachment, with links and frontmatter).
- The cost grows with the number of published notes. A static page per note removes it.

### 1.2 Volume

| What                                | Count          | Size   |
| ----------------------------------- | -------------- | ------ |
| Published notes (`.md`)             | 20,735         | 71 MB  |
| Attachments                         | 13,970         | 788 MB |
| of which `webp`                     | 10,375         | 279 MB |
| of which `png`                      | 2,370          | 282 MB |
| of which `jpg` / `jpeg`             | 1,181          | 118 MB |
| of which `mp4`                      | 15             | 80 MB  |
| of which `wav`, `gif`, `svg`, `pdf` | 30             | 28 MB  |
| Links between notes (Publish cache) | about 155,000  |        |
| Total                               | 34,709 entries | 859 MB |

- All public attachments live in one vault folder (`50 Resources/51 Attachments/51.03 Public`).
- Largest files: two promo videos (27 MB, 13 MB), one `wav` (18 MB).
- 20,756 vault notes carry `public_note: true`. 22 of them are not in the Publish cache (18 note templates that carry the property as a default, 4 recent notes). One published note does not carry the property. So the property and the published state differ slightly at any time.

### 1.3 Notes by area

| Area (vault folder)                           | Public notes |
| --------------------------------------------- | ------------ |
| Media (movies, games, board games, TV, anime) | 10,459       |
| Permanent notes                               | 5,359        |
| Literature notes (incl. quotes, book notes)   | 3,135        |
| People                                        | 1,022        |
| AI wiki articles                              | 467          |
| Maps of content                               | 274          |
| Other (meta, home, resources)                 | about 40     |

Main type tags: movie 4,890, permanent note 3,839, quote 2,475, board game 2,375, video game 2,029, person 1,024, TV show 716, AI wiki 466, product page 414, own quote 380, article 351, literature note 327, book 273, map 271, newsletter 231, anime 227, board game item 193, news 93, expression 63, folder note 39.

### 1.4 Markdown and Obsidian features in use

Number of public notes that use each feature:

| Feature                            | Notes    | Remark                                               |
| ---------------------------------- | -------- | ---------------------------------------------------- |
| Image embeds (`![[x.webp]]`)       | 11,752   | Includes size suffix (`\|300`)                       |
| `cover` / `local_cover` property   | 10,567   | Media notes                                          |
| Meta Bind buttons (`BUTTON[...]`)  | 10,447   | Must be removed from output                          |
| `aliases` property                 | 5,385    | Usable for search and short URLs                     |
| Tables                             | 2,772    |                                                      |
| Serialized Dataview queries        | 2,761    | Static Markdown between HTML comments                |
| `description` property (filled)    | 2,635    | Meta description source                              |
| Code blocks                        | 651      |                                                      |
| Heading links (`[[Note#Heading]]`) | 216      |                                                      |
| Music notation blocks              | 191      | See 1.7                                              |
| External Markdown images           | 182      |                                                      |
| Callouts                           | 47       |                                                      |
| Canvas or Excalidraw references    | 46       |                                                      |
| Task checkboxes                    | 36       |                                                      |
| Audio or video embeds              | 21       |                                                      |
| Highlights (`==x==`)               | 18       |                                                      |
| Bases embeds (`![[x.base]]`)       | 16       | Not rendered by Publish                              |
| Footnotes                          | 14       |                                                      |
| Comments (`%%x%%`)                 | 14       | Must be removed from output                          |
| Live Dataview blocks               | 12       | Not rendered by Publish                              |
| Mermaid                            | 8        |                                                      |
| Math                               | 7        |                                                      |
| Block references (`[[Note#^id]]`)  | 6        |                                                      |
| PDF embeds                         | 4        |                                                      |
| Note transclusion (`![[Note]]`)    | about 25 | For example the home page embeds "Recently modified" |
| Iframes                            | 1        |                                                      |

- More than 260 distinct property keys. Media notes carry about 60 each, most of them empty.
- No two public notes share a file name. No note uses a `permalink` property.
- Some notes are in French (product documentation).

### 1.4b Names and paths (from the Publish cache)

| Property of the note path or file name                                         | Notes        |
| ------------------------------------------------------------------------------ | ------------ |
| File name contains a dot                                                       | 1,488        |
| File name ends like a file extension (`Next.js`, `Node.js`, `Transformers.js`) | 13           |
| Contains an apostrophe                                                         | 1,501        |
| Contains non-ASCII characters                                                  | 1,221        |
| Contains `&`                                                                   | 175          |
| Contains a literal `+`                                                         | 14           |
| Contains `%`                                                                   | 9            |
| Two paths equal when letter case is ignored                                    | 0            |
| Two file names equal when letter case is ignored                               | 0            |
| Notes inside a folder whose name has a dot (`33.02 Content`)                   | about 19,200 |
| Distinct aliases                                                               | about 6,900  |
| Aliases that belong to more than one note                                      | 60           |
| Aliases equal to the file name of another note                                 | 16           |

### 1.4c Personal data in person notes

About 1,020 person notes are public. Their properties hold personal data of other people: dates of birth (about 300 notes), locations (about 215), social network handles (about 420), email addresses (16). Today this data sits in the site cache and shows only after JavaScript runs.

### 1.5 Site configuration (Publish options)

- Home page: the `README` note of the Publish resources folder.
- Site name "DeveloPassion", logo, favicon.
- Search on, backlinks on, outline on, navigation tree on, theme toggle on (default light), sliding window mode on, hover preview off, note title hidden.
- The graph option and sliding window mode are in use: a link opens the note in a new column next to the open ones.
- 13 vault folders are excluded from publication (private and internal content, templates, tooling). A note inside them is never published, whatever its properties say.

### 1.6 URL behavior

- URL = vault path without `.md`. Each path segment is percent-encoded (`encodeURIComponent`), then each `%20` becomes `+`. So a space is `+`, and a literal `+` in a name is `%2B`. Example: `/30+Areas/33+Permanent+notes/33.02+Content/Obsidian+Publish`.
- The `%20` form of the same path also loads.
- The server answers 200 for any path, also for a path that does not exist. The browser resolves the note.
- Verified in a browser: these variants all resolve to the note today: the file name alone (`/Obsidian+Publish`), lower case, a `.md` suffix, a trailing slash, an alias. The `.md` form shows the page, not raw Markdown.
- The root name space is therefore about 48,000 names: 20,735 paths, 20,735 file names, about 6,900 aliases.
- Inbound links often carry a query (`?ref=dsebastien.net`).
- Heading anchors use the heading text. The exact encoding (`+`, `%20`, raw) and the handling of duplicate headings are not verified yet.
- Tag links in the properties panel point to `#tag`.
- Images load from the Publish host (`publish-01.obsidian.md/access/<site id>/<path>`), not from the notes domain.
- `sitemap.xml` is empty. `robots.txt` is 23 bytes. `rss.xml` is an empty feed.
- Browsers get a small shell (about 2 KB) with the note title in `<title>` and no content.
- Known crawlers (tested with Googlebot and GPTBot user agents) get another response (about 9 KB): the note content, a title of the form `<note name> - DeveloPassion`, Open Graph tags and a canonical tag.
- That canonical tag is wrong for most notes: the URL is cut at the first dot of the path. A note in `33.02 Content` gets the canonical `/30+Areas/33+Permanent+notes/33`. About 19,200 notes sit in such a folder.
- A path that does not exist returns 200 to crawlers too.
- Consequence: the notes are in search indexes today, in a damaged state. The switch repairs an existing index. It is not a first appearance. No baseline of search traffic was recorded yet.
- At least one inbound link from the main site points to a notes URL that returns "not found" today (a project note that was never public).

### 1.7 `publish.js` (891 lines): what it loads and does

External resources loaded on every page:

| Resource                                       | From                                                | Purpose                                  | Note                                                |
| ---------------------------------------------- | --------------------------------------------------- | ---------------------------------------- | --------------------------------------------------- |
| Plausible script                               | Own Cloudflare Worker proxy                         | Analytics, site `notes.dsebastien.net`   | Events go to the proxy `/api/v1/event`              |
| `ghost-subscribe.js`                           | jsDelivr, GitHub `dsebastien/ghost-subscribe@main`  | Newsletter signup against the Ghost site | Not pinned to a version                             |
| `gumroad.js`                                   | gumroad.com                                         | Gumroad overlay checkout                 | Probably obsolete: product links point to the store |
| `products-light.json`                          | Store website                                       | Product catalog for the cards            | Fetched once per day, cached in `localStorage`      |
| `music-notation.publish.min.js` (551 KB)       | jsDelivr, `@dsebastien/music-notation@0.23.1`       | Music blocks                             | Only on pages with such blocks                      |
| `music-notation.tab.min.js` (66 KB) + alphaTab | jsDelivr                                            | Tabs and scores                          | Only on pages with `tab` / `score` blocks           |
| Sound fonts                                    | jsDelivr, `@dsebastien/music-notation-sounds@0.1.1` | Playback                                 | Per instrument, at the first Play                   |

Features:

1. **Properties panel**. Collapsible `<details>` under the frontmatter, not on the home page.
    - Keys: `snake_case`, `kebab-case` and `camelCase` become Title Case.
    - Empty values are hidden (null, blank, empty lists, empty objects). The internal `position` key is hidden.
    - Booleans show as `✓ true` / `✗ false`. Numbers get their own style.
    - Dates: date-only values stay `YYYY-MM-DD`. Values with a time show `YYYY-MM-DD, HH:MM`.
    - `[[Target#heading|alias]]` values become internal links. The target resolves by full path, then by file name. A target that is not published shows as plain text.
    - `http(s)` values become external links in a new tab.
    - Lists render as chips. `tags` render as `#tag` links.
    - Objects render as formatted JSON.
2. **History block**. "Created" and "Updated" dates under the backlinks, when both properties exist.
3. **Product cards ("Go deeper")**. Up to 2 cards under the note.
    - Never on the home page, never on person or quote notes.
    - Tokens come from tags (not the `zone/` and `type/` namespaces), `topics`, title words and known title phrases. An alias map expands them (for example `pkm` to `knowledge-management`).
    - Score: number of matching product tags first, match density second, commercial rank (best value, bestseller, featured, priority) as a small nudge. No match means no card.
    - Card: image, badge, tier and category line, name, short description, "Learn more".
    - Opens the store in a new tab.
4. **Analytics event** `cta_clicked` with the properties `position` (always `end`), `slot` (0 or 1), `product` (product id), `href`, `page` (the vault path with `.md`). No impression event exists, so no click rate can be computed. Links to the store carry no campaign parameter.
5. **Newsletter form**. The markup is inserted before the site footer, and the style sheet turns it into a bar fixed to the bottom of the screen, in view on every page. It has error and success messages, an "already subscribed" state and a "Don't show this again" link. It calls the Ghost API of the main site with an integrity token. The form uses inline event handlers and inline styles.
6. **Meta Bind cleanup**. Paragraphs that contain only `BUTTON[...]` inline code are hidden.
7. **Global graph**. A click on the site name opens it (not the home page), and so does `Ctrl+G` / `Cmd+G`, which is "find next" in browsers.
8. **Music notation**. Fenced blocks `chord`, `chords`, `keyboard`, `fretboard`, `strum`, `picking`, `progression`, `circle`, `tab`, `score`.
    - An empty block in a chord or scale note draws from the properties of the page. Embedded notes and previews get no properties.
    - Playback uses the GeneralUser GS sound font.

Details of the properties panel and the history block that a build must reproduce or decide on:

- Dates and times show in the time zone of the reader. A static build needs a fixed zone.
- The panel is closed by default.
- The heading part of a wikilink property (`[[Note#Heading]]`) is dropped from the link.
- Lists with only empty items, and invalid dates, are hidden.
- The product matcher splits the note title into single words and expands them through the alias map. Short common words (`it`, `time`, `focus`, `community`) can match a product on any note, media notes included. Media notes are not excluded from ads.
- The product catalog is read from the `www` host of the store, because the bare host redirects without a CORS header. Product images load from the store.
- Each product link takes two redirects today (bare host, `www` host, trailing slash).

Workarounds that exist only because of Obsidian Publish (they disappear on a static site): polling timers and mutation observers to wait for the renderer, re-insertion of injected blocks after the virtual scroller removes them, client-side resolution of wikilinks in properties.

### 1.8 `publish.css` (40 KB)

- A Tailwind 4 build: utility classes for the newsletter form and the cards.
- Custom styles: properties panel, history block, product cards, section headers, the fixed newsletter bar and its states.
- Live Dataview blocks are hidden by a style rule.
- Paragraphs are justified and hyphenated.

### 1.9 Publishing workflow today

1. The switch is the Obsidian Publish panel: a note is public when the author published it there. The `public_note: true` property is a mirror of that state, not the trigger.
2. The Templater script `TPL Publish` runs in Obsidian:
    - It reads the list of published files from the Obsidian Publish API.
    - It writes the property to match the published state: it adds the property to published notes and removes it from notes that are not published.
    - It sets `created` (if missing) and `updated` when it changes the property.
    - It runs the Dataview Serializer plugin on each published file, so that query results become static Markdown. This needs a running Obsidian with Dataview.
    - It regenerates two notes with Dataview: "Recently added" (1,000 newest by file creation date, with a "Changelog" heading, the total count and links to the stats) and "Recently modified" (25 newest by file change date). Both lists cover the knowledge area of the vault only and skip notes with an "ignore" tag.
    - Those two notes, the "Stats" note and the home note are published notes with their own URLs. The home page embeds "Recently modified".
    - It opens the Obsidian Publish panel.
3. In the panel, the author reviews the lists (new, changed, deleted, unchanged), selects entries, and publishes. This is where a note can be published, skipped, or unpublished.

Other consumers of the published state:

- The Ghost Publish plugin lists published notes as candidates for the news feed of the main site, and writes a "News feed" note.
- The stats script (section 1.10) reads the same Publish API list, including attachments, for its totals.
- Both stop working when Obsidian Publish is cancelled, and so does `TPL Publish`.
- The author also runs publications through automation (the Obsidian command line), not only by hand.

### 1.10 Stats

- The Templater script `TPL Stats` (1,290 lines) runs in Obsidian. It uses Dataview, the Obsidian Starter Kit plugin API (note type registry), the Obsidian Publish API (published list), and git (commit counts).
- It writes a "Stats" note (published) and `stats.json`. The JSON never holds private note types. The published "Stats" note lists counts for all note types.
- It commits and pushes `stats.json` to the public `kb-stats` repository.
- A GitHub Actions workflow there runs `build.js` (Chart.js charts, a creation heat map, bar groups, product cards) and deploys `index.html` to GitHub Pages at stats.notes.dsebastien.net.
- `stats.json` has two blocks. `overall` covers the whole vault, private notes included (totals, words, note types with status buckets, links, tags, tasks, periodic notes, AI assets, git activity). `publication` covers the public part (published by year and month, topics, words, public ratio).

## 2. Main site (www.dsebastien.net, Ghost 6)

- 551 posts, 49 pages, 176 tag pages in the sitemap. Posts live at the root: `/<slug>/`.
- Hosted on Ghost(Pro).
- Ghost also stores the members, sends the newsletter by email, has a paid tier, and shows native comments on posts.
- The URL surface is larger than the sitemap: click-tracking links in sent emails (`/r/...`), unsubscribe links, `/email/`, `/members/`, `/content/images/`, `/rss/`, portal links.
- Posts have correct canonical tags today.
- Custom theme (`ghost-theme-dsebastien`). It reads prices from `products-light.json`.
- The articles and newsletters exist as vault notes (the vault is the source). They are published to Ghost with the Ghost Publish plugin.
- Result: each article exists two times on the web, on the notes site and on the main site.
- Known trap: the `slug` property of a vault note often differs from the live Ghost slug.

## 3. Store (store.dsebastien.net)

- React 19, TypeScript, Bun, Tailwind 4, React Router. Product data in JSON files validated by Zod schemas.
- 135 URLs in the sitemap, 376 files in the build output. Hosted on Cloudflare Pages.
- The build also generates static pages, a sitemap, `llms.txt`, an RSS feed and `products-light.json`.
- `products-light.json` is a contract. Its working URL is on the `www` host. Consumers: the Ghost theme, `publish.js`, the PKM wiki, the stats site.
- The canonical tag, the sitemap and each product link in `products-light.json` use the bare host, which redirects. `robots.txt` of the store allows AI training.
- Features: category and tag filters, command palette, compare pages, wishlist, quiz.

## 4. Related code that already exists

| Repository                         | What it gives                                                      |
| ---------------------------------- | ------------------------------------------------------------------ |
| `store-website`                    | Canonical Knowii web palette and components                        |
| `ai-wiki-template` / `ai-wiki-pkm` | Static wiki generator with search (Lunr) and a knowledge graph     |
| `kb-stats`                         | Stats page design and charts                                       |
| `music-notation`                   | Rendering library with `renderBlock`, SVG export and a CLI checker |
| `obsidian-dataview-serializer`     | Turns Dataview queries into static Markdown                        |
| `obsidian-ghost-publish`           | Publishes notes to Ghost from Obsidian                             |
| `obsidian-publisher`               | Older, unfinished multi-target publishing plugin                   |
| `obsidian-plugin-template`         | Template for a new Obsidian plugin                                 |

## 5. Brand

- Web palette: background `#37404c`, surface `#3f4957`, raised surface `#475363`, text `#ffffff`, signature magenta `#e5007d`, text accent `#ff1493`, success `#4ade80`, yellow accent `#fbbf24`, purple gradient partner `#a855f7`, chart wells `#2b323c`.
- Light mode: background `#f5f7fa`, text `#1a1a2e`, magenta `#d10070`.
- Measured contrast on the dark background `#37404c`: white 10.5:1, `#ff1493` 2.89:1, `#e5007d` 2.31:1. Both magentas fail WCAG AA as text, also as large text (3:1). White on a magenta button is 4.54:1. The light-mode magenta `#d10070` on `#f5f7fa` is 4.96:1.
- The site needs a link color that passes on the dark background. The magentas stay for fills, borders and decoration.
- The light palette has three defined colors only. It must be completed.
- Font: Noto Sans. JetBrains Mono for code and timestamps.
- Components: gradient hero, pill badges, cards with a subtle border and a lift on hover, solid magenta primary buttons, slate secondary buttons, tag chips, section headings with a short magenta bar, back-to-top button, dark chart wells.
- Motion: reveal on scroll, count-up numbers. All behind `prefers-reduced-motion`.
