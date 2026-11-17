# SEO and AI search requirements (2026-11-17)

- **Status**: research. Nothing here is approved.
- **Trigger**: the author said: "SEO and AISEO are of critical importance."
- **Input**: `documentation/plans/spec-v1.md` (sections 5.4, 9.1 to 9.4, 9.7, 9.13 to 9.17, 11, 13), `documentation/plans/decisions.md`, the five ADRs, `documentation/research/2026-11-17-current-state.md` (sections 1.2 to 1.6, 2). This file calls them "the spec", "the decision log" and "the research".
- **Output**: requirements that spec v2 can adopt (section F), decisions for the author (section G), contested points (section H).
- **Terms**: "AISEO" means visibility in AI answers and for AI agents: Google AI Overviews and AI Mode, Microsoft Copilot, ChatGPT search, Perplexity, Claude with web search, and agents that read a site for a user. Other names for it are GEO and AEO.
- **Rule**: no timing information and no effort estimates. Dates of sources are facts, not plans.
- **Privacy**: this repository is public. This file holds no analytics numbers of the author, no private note names and no infrastructure detail. Measurement results must stay outside this repository.

How to read it:

- Every item has a number. The numbers run through the whole file, so that a reply can point to "item 57".
- A link next to a claim is the source of that claim. All sources were read on 2026-11-17. The list is at the end.
- Labels for the kind of evidence: **[Doc]** documentation of the operator, **[Study]** a published study with a stated method, **[Vendor]** a claim of a vendor about its own product, **[Reported]** press or a third-party test, **[Inference]** my own reasoning from the facts.
- Placeholders in templates: `{site}` is the site name, `{author}` is the public name of the author, `{N}` is the display title of a note (spec 9.1.4: `title` property, else first heading, else file name).
- Property names (`rating`, `status`, `release_date`, `directors`, `bgg_id`) are the names in the note type definitions of the vault. The per-type configuration of spec 9.3.3 maps them. A property reaches a title, a description or structured data only when the allow list of its type permits it (spec 7).

## 0. Frame

1. **Settled decisions that this file designs within.** Every note is indexed (ADR 0004). The vault path with `+` is the canonical URL for good (ADR 0005). Three hosts stay (ADR 0001). Article and newsletter notes point their canonical URL to the main site. Generated pages live under `/-/`. AI policy (D33): search and AI input for all content, training for the author's own text only. Static HTML behind Cloudflare.
2. **Pending decisions that this file depends on.** D3 (hosting) decides how the edge sets headers and enforces bot rules. D40 (person notes) decides which person properties may appear in markup. D47 (third-party material and paid products) decides image sitemaps and bulk files. D29 (licenses) decides the license line of the "cite this note" block.
3. **What the switch repairs.** Today crawlers get a canonical tag that is cut at the first dot of the path, an empty sitemap, and status 200 for missing pages (research 1.6). So the search engines hold a damaged copy of the site. Section D treats the switch as a repair, not as a launch.
4. **The main risk that stays.** About 14,000 of the 20,700 notes are thin: media notes, quotes and person notes. They stay indexable. Section B raises their floor. It cannot make them strong pages, and no source proves that they are harmless to the host (item 197).
5. **What Google says about AI features in one line.** A page must be indexed and eligible for a snippet. Nothing else is required. Special files are ignored, and no special markup is needed ([AI features][g-ai-features], [AI optimization guide][g-ai-guide]). So the technical SEO of section A is also the base of section E.
6. **What this file adds to spec 9.13.** A template per note type, redirect codes per variant, a structured data model, index rules for generated pages, a migration procedure, an AI crawler policy that fits D33, and tests for each.

## A. Technical SEO requirements

### A.1 Titles and descriptions

7. **Title rules for every page.** One `<title>` per page. The main part comes first, then one delimiter and the site name. The main part equals the visible `<h1>`. The title is in the language of the note. Google asks for unique, descriptive, short titles without boilerplate, and it rewrites titles that are half empty, repeated or not in line with the page ([title links][g-title]). Microsoft asks that title, `<h1>` and description agree ([Microsoft guidance][ms-ai-answers]).
8. **A type word in the title of media notes.** One name is often a book, a movie, a video game and a board game in this vault. The type word ("Movie", "Board game") and the year make such titles unique and state what the page is. **[Inference]** from the uniqueness rule of [title links][g-title].
9. **Description rules.** The `description` property wins when it is filled (2,635 notes, research 1.4). When it is empty, the build writes a description from the properties of the note. Google accepts this for database-driven sites when the result is readable, different per page and built from page-specific data, and it sets no length limit ([snippets][g-snippet]). Working bound: 70 to 160 characters, cut at a word end. This bound is a convention for display width, not a Google rule.
10. **Order inside a generated description.** The data that only this site has comes first: the status, the rating, the ownership, the number of linked notes. Facts that every database has (director, year, runtime) come second. **[Inference]**: the unique part must survive a cut.
11. **Empty values.** A clause whose property is empty is left out. No description contains an empty slot, a raw enum value, a wikilink syntax or a property that is not on the allow list. The star rating (`★★★★☆`) is written as a number: "4/5".
12. **Templates per type.** The table gives the `<title>` and the description that the build writes when the author wrote none.

| Row | Note type                        | `<title>`                                                                   | Description from properties                                                                                                                                                                            |
| --- | -------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 12a | Permanent note (concept)         | `{N} - {site}`                                                              | First paragraph of the body that is prose (not a list, an embed or a callout), cut at a sentence end. Fallback: `{N}: a note in {map 1} and {map 2}, linked from {k} notes.`                           |
| 12b | Map of content                   | `{N} - Map of content - {site}` (no type word when `{N}` already has one)   | `A map of {k} notes about {N}: {the 4 linked notes with the most backlinks}, and more.`                                                                                                                |
| 12c | Movie                            | `{title} ({release year}) - Movie - {site}`                                 | `{author} {status phrase} {title} ({year}){ and rated it r/5}. {categories} movie directed by {directors}, {runtime} min.`                                                                             |
| 12d | TV show                          | `{title} ({first_aired year}) - TV show - {site}`                           | `{author} {status phrase} {title}{ ({episodes_watched} of {episodes_total} episodes)}{, rated r/5}. {categories} series by {creators}, {seasons_total} seasons, {airing_status}.`                      |
| 12e | Anime                            | `{title} ({year}) - Anime - {site}`                                         | As 12d, with `{studios}` and `{source_material}`.                                                                                                                                                      |
| 12f | Video game                       | `{title} ({release year}) - Video game - {site}`                            | `{author} {status phrase} {title}{, {completion}}{, rated r/5}. {categories} game by {developers} for {platforms}.`                                                                                    |
| 12g | Board game                       | `{title} ({release year}) - Board game - {site}`                            | `{author} {ownership phrase} {title}{ and rated it r/5}. Board game by {designers} for {min_players} to {max_players} players, {playtime} min, weight {weight}/5. Mechanics: {the first 3 mechanics}.` |
| 12h | Board game item                  | `{title} - {base_game} expansion - {site}`                                  | As 12g, with `For {base_game}.` first.                                                                                                                                                                 |
| 12i | Book note                        | `{title} by {first author} - Book notes - {site}`                           | `{author} {status phrase} {title}{: subtitle} by {authors} ({published_on year}, {pages} pages){, rated r/5}. {q} quotes and {n} notes from this book.`                                                |
| 12j | Quote                            | `{quoted person}: "{quote, cut at a word end near 55 characters}" - {site}` | `"{quote, cut near 110 characters}" Quote by {quoted person}{, from {source}}. Topics: {the first 3 topic tags}.`                                                                                      |
| 12k | Own quote                        | `"{quote, cut}" - {author} - {site}`                                        | `"{quote, cut}" A quote by {author}. Topics: {tags}.`                                                                                                                                                  |
| 12l | Person                           | `{name} - {public role, when allowed} - {site}`                             | `{name}{, public role}. This garden holds {q} quotes, {b} books and {n} notes that refer to {name}.` Only counts above zero appear.                                                                    |
| 12m | Literature note                  | `{N} - Literature note - {site}`                                            | First prose paragraph. Fallback: `Notes by {author} on {source title} by {source author}.`                                                                                                             |
| 12n | AI wiki article                  | `{N} - {wiki_name} wiki - {site}`                                           | First prose paragraph. The disclosure of item 104 is in the body, not in the description.                                                                                                              |
| 12o | Product documentation (English)  | `{N} - {product} documentation - {site}`                                    | First prose paragraph. Fallback: `How to {N} in {product}.` only when `{N}` is a task title.                                                                                                           |
| 12p | Product documentation (French)   | `{N} - Documentation {product} - {site}`                                    | First prose paragraph, in French. No English fallback text on a French page.                                                                                                                           |
| 12q | Article, newsletter, news (copy) | `{title} - {site}`                                                          | `excerpt` property, else `description`, else first paragraph. The page points its canonical URL to the main site (item 22).                                                                            |
| 12r | Music work                       | `{title} by {composers or artists} - {site}`                                | `{title} by {composers}{, in {key}}{, {bpm} bpm}. {k} arrangements and exercises in this garden.`                                                                                                      |
| 12s | Guitar or piano arrangement      | `{work title} - {instrument} arrangement{ ({style})} - {site}`              | `{instrument} arrangement of {work} by {arranger}{, key {key}}{, capo {capo}}{, tuning {tuning}}. With tab and playback.`                                                                              |
| 12t | Chord, scale, technique, theory  | `{N} - {instrument} {kind} - {site}`                                        | Chord: `How to play {chord_symbol} on {instrument}: {shape} shape, position {position}. With diagram and sound.` Others: first prose paragraph.                                                        |
| 12u | Expression                       | `{N}: meaning - {site}`                                                     | First prose paragraph.                                                                                                                                                                                 |
| 12v | Folder note                      | `{folder name without its number} - {site}`                                 | First prose paragraph, else `{k} notes in {folder name}.`                                                                                                                                              |
| 12w | Type hub, page 1                 | `{type plural} - {site}`                                                    | `All {count} {type plural} in the garden of {author}, with {the unique columns: rating, status}.`                                                                                                      |
| 12x | Type hub and tag page, page n    | `{type plural} - page {n} - {site}`                                         | As page 1, with `Page {n} of {m}.`                                                                                                                                                                     |
| 12y | Tag page                         | `Notes tagged {tag} - {site}`                                               | `{count} notes tagged {tag}: {the 4 notes with the most backlinks}.`                                                                                                                                   |
| 12z | Curated list (item 92)           | The list title from the registry                                            | The intro text from the registry, cut.                                                                                                                                                                 |

13. **Status and ownership phrases.** One table in the type configuration turns an enum value into a phrase: "Watched" gives "watched", "To Watch" gives "wants to watch", "Abandoned" gives "stopped watching", "Wishlist" gives "has on the wishlist", "Owned" gives "owns". A value without a phrase drops its clause.
14. **The quoted person of a quote note.** The `authors` property, else the first link to a person note after the block quote (the common shape today). A quote without a resolvable person uses template 12k without the author part and gets a warning.
15. **Uniqueness test.** No two indexable pages share a `<title>`, and no two share a description. File names are unique in the vault (research 1.4), so the test fails only for `title` overrides and for generated pages.
16. **Sharing tags.** `og:title` is the main part without the site name. `og:url` is the canonical URL. `og:site_name` is `{site}`. `og:image` follows spec 9.13.2. `og:locale` follows the note language. Article-like types carry `article:published_time` and `article:modified_time`. Google reads `og:title` and `og:site_name` as sources for title links and site names ([title links][g-title], [site names][g-sitename]).

### A.2 Canonical URLs

17. **One canonical link per page.** Every indexable page has one `<link rel="canonical">` with an absolute `https://notes.dsebastien.net/...` URL, without query and without fragment. Google asks for absolute URLs and treats the link as a strong signal, but as a hint, not as a rule ([canonical methods][g-canon], [canonicalization][g-canon-what]).
18. **All signals agree.** The canonical link, `og:url`, the `url` and `@id` values in JSON-LD, the sitemap `<loc>`, every internal `<a href>`, the feeds, `llms.txt` and the IndexNow payload come from the one URL function of rule U13, byte for byte. Google names redirects, the canonical link and the sitemap as the signals it combines, and it asks for internal links to the canonical URL ([canonical methods][g-canon]).
19. **The `+` form.** In a URL path, `+` is a plain character. Only form encoding of query strings reads it as a space ([RFC 3986][rfc3986], section 2.2). So `/Zettelkasten+method` and `/Zettelkasten%20method` are two URLs for a crawler. The site writes the `+` form everywhere and never the `%20` form. A literal `+` in a name is `%2B` (rule U1). Non-ASCII characters are percent-encoded in every `href`, as Google asks ([URL structure][g-url]). Google prefers hyphens between words in new URLs ([URL structure][g-url]). ADR 0005 keeps `+`, and the cost is discussed in item 200.
20. **Tolerant reading of `%2B` and `%20`.** Some clients rewrite `+` to `%2B`, or decode `+` to a space. When the literal reading of a path finds no note, the resolver reads `%2B` and `%20` as a space and answers with one redirect to the `+` form. The literal reading wins, because 14 notes have a real `+` in their name (research 1.4b). **[Inference]**: this protects links that agents and tools rewrite.
21. **Query strings do not redirect.** A URL with a query answers 200 with the same page, and the canonical link names the clean URL. The cache ignores the query (rule U12). A redirect would remove `?ref=...` and `utm_source=chatgpt.com` before the analytics script reads them. ChatGPT adds that parameter to its outbound links ([OpenAI publisher FAQ][openai-faq]), and inbound links from the main site carry `?ref=` (research 1.6). This narrows rule U2, which lists a query string among the forms that redirect.
22. **Article and newsletter copies.** The 675 notes that are copies of main-site posts carry a canonical link to the post on `www.dsebastien.net`. The target comes from the `url` property of the note, never from `slug`, because the slug often differs from the live one (research 2). The build accepts the target only after a check that it answers 200 and names itself as canonical. `og:url` is the same target. Google and Bing both describe a cross-host canonical link as the way to name the original ([canonicalization][g-canon-what], [Bing on duplicates][b-dup]). It stays a hint (item 201).
23. **Markdown twins.** The Markdown form of a note lives under `/-/` (rule U11). Its response carries `X-Robots-Tag: noindex` and `Link: <canonical URL>; rel="canonical"`. Google supports both headers for non-HTML files ([robots meta][g-robots-meta], [canonical methods][g-canon]). The HTML page carries `<link rel="alternate" type="text/markdown" href="...">`. The twin is never in a sitemap. `robots.txt` does not block the twins, because a blocked URL hides its `noindex` ([robots meta][g-robots-meta]).
24. **Pages of a list.** Each page of a paginated list names itself as canonical. Google says not to point all pages to page 1 ([pagination][g-pagination]).
25. **Language twins.** A French page and its English twin each name themselves as canonical. A canonical link never crosses languages ([canonical methods][g-canon]).

### A.3 Redirects

26. **Codes per variant.** Google reads a 301 or 308 as a signal that the target is the canonical URL, and a 302 or 307 as no such signal ([redirects][g-redirects]). The table refines rule U4. Rows 26c, 26d and 26g differ from U4, and item 174 asks the author.

| Row | Requested form                                                | Answer                                    | Reason                                                                                                                                           |
| --- | ------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 26a | Former path of a moved or renamed note                        | 301                                       | U4. The move is permanent.                                                                                                                       |
| 26b | `%20` or `%2B` for spaces, trailing slash, other Unicode form | 301                                       | Pure syntax of the same path. The target can never differ.                                                                                       |
| 26c | Full path in another letter case                              | 301                                       | No two paths are equal when case is ignored (research 1.4b), and the publication blocks such a collision (spec 7).                               |
| 26d | `.md` suffix on a full path                                   | 301                                       | Pure syntax. The 13 notes whose name ends like a file extension resolve first as live paths (rule U3).                                           |
| 26e | `http://`                                                     | 301 to `https://`                         | One scheme.                                                                                                                                      |
| 26f | Alias                                                         | 302                                       | U4. 60 aliases belong to more than one note (research 1.4b), and an alias can move.                                                              |
| 26g | File name alone (any letter case)                             | 301 with a short `Cache-Control` lifetime | File names are unique and collisions are blocked. The short lifetime stops a browser from keeping the redirect for good if the name moves later. |
| 26h | Query string                                                  | No redirect (item 21)                     | Analytics parameters must survive.                                                                                                               |
| 26i | Legacy generated notes (home note, "Recently added", "Stats") | 301 to the generated page, or 200 (U7)    | One URL per page.                                                                                                                                |
| 26j | `stats.notes.dsebastien.net`                                  | 301 (U14)                                 | Permanent move.                                                                                                                                  |

27. **One hop.** Every variant reaches a 200 page in one redirect. A redirect target never redirects. Google warns that chains slow crawling ([crawl budget][g-crawl-budget]).
28. **No redirect to a list for a missing note.** An unknown path answers 404. It does not redirect to the home page or to a hub. Google treats such answers as soft 404 ([status codes][g-status], [facets][g-facets]).

### A.4 Status codes

29. **200** only for a canonical URL, for a canonical URL with a query, and for the Markdown form.
30. **404** for an unknown path, also under `/-/`, with the search suggestions of rule U9 in the body. **410** for a note that the author unpublished. Google handles 404 and 410 the same way: it drops the URL and crawls it less ([status codes][g-status]). So 410 is correct but brings no measured gain.
31. **404 for an empty generated list.** A tag page, a list page or a page number without items answers 404, as Google asks for empty filter results ([facets][g-facets]).
32. **304 for unchanged pages.** HTML and Markdown responses carry `ETag` or `Last-Modified`, and a conditional request gets 304. Google asks for this to save crawl resources ([crawl budget][g-crawl-budget]).
33. **No 403, 429 or 5xx for search crawlers.** Rate limits and bot rules at the edge (spec 9.15.4) exempt verified search crawlers. Google slows its crawl on 429 and 5xx and drops URLs that keep failing ([status codes][g-status]).
34. **`robots.txt` always answers 200.** A 5xx answer on `robots.txt` stops the Google crawl of the whole host for the first 12 hours, and a 4xx answer means "no rules" ([robots.txt][g-robots]). The second case would silently remove the AI policy of section E.

### A.5 Sitemaps

35. **Structure.** One sitemap index at `/sitemap.xml`, the URL that is empty today. One sitemap file per group, at the root of the host, because a sitemap file may list only URLs below its own folder ([sitemap protocol][sitemaps-protocol]). Each file stays far below the limit of 50,000 URLs and 50 MB ([sitemaps][g-sitemap]). Google says that separate files help to track each group in Search Console ([sitemaps][g-sitemap]). That is the reason for the split.

| Row | File                      | Holds                                               | About      |
| --- | ------------------------- | --------------------------------------------------- | ---------- |
| 35a | `sitemap-permanent.xml`   | Permanent notes, expressions                        | 3,900 URLs |
| 35b | `sitemap-maps.xml`        | Maps of content, folder notes with own text         | 300        |
| 35c | `sitemap-books.xml`       | Book notes, literature notes                        | 600        |
| 35d | `sitemap-wiki.xml`        | AI wiki articles                                    | 470        |
| 35e | `sitemap-docs.xml`        | Product pages and documentation, English and French | 420        |
| 35f | `sitemap-music.xml`       | Music notes                                         | under 200  |
| 35g | `sitemap-quotes.xml`      | Quotes and own quotes                               | 2,900      |
| 35h | `sitemap-people.xml`      | Person notes                                        | 1,030      |
| 35i | `sitemap-movies.xml`      | Movies                                              | 4,900      |
| 35j | `sitemap-tv.xml`          | TV shows and anime                                  | 950        |
| 35k | `sitemap-video-games.xml` | Video games                                         | 2,000      |
| 35l | `sitemap-board-games.xml` | Board games and board game items                    | 2,600      |
| 35m | `sitemap-generated.xml`   | Indexable generated pages only (item 46)            | by rule    |

36. **Only canonical, indexable, 200 URLs.** A sitemap holds no redirect, no 404, no Markdown twin, no page with `noindex`, and none of the 675 copies whose canonical URL is on the main site. Google asks to list the URLs that should show in results ([sitemaps][g-sitemap]).
37. **`lastmod`.** The value is the date and time of the last significant update of the note (spec 6.7.3), in W3C format with a time zone. It is never the build time. Google uses `lastmod` only when it is "consistently and verifiably" accurate, and it counts a change of main content, structured data or links as significant ([sitemaps][g-sitemap]). Bing uses `lastmod` to schedule crawls, also for AI answers, and may ignore values that always equal the current date ([Bing lastmod][b-lastmod], [Bing sitemaps][b-sitemaps-ai]).
38. **No `priority`, no `changefreq`.** Google and Bing ignore both ([sitemaps][g-sitemap], [Bing lastmod][b-lastmod]).
39. **XML escaping.** Every value is entity-escaped and the files are UTF-8 ([sitemaps][g-sitemap]). 175 notes have `&` in their path and 1,501 have an apostrophe (research 1.4b).
40. **Image sitemap.** None for cover images. The 10,567 covers are third-party material, they sit in `<img>` elements that crawlers find without a sitemap, and an image sitemap only helps for images that crawlers would miss ([image sitemaps][g-img-sitemap]). An image sitemap for the author's own images (diagrams, screenshots) is a second-wave option. This matches the first recommendation of D47.
41. **Reserved root names.** `robots.txt`, `sitemap.xml`, every `sitemap-*.xml`, `llms.txt`, the IndexNow key file, the verification files of Search Console and Bing, and `.well-known/` are reserved routes. The publication check of rule U6 blocks a note or alias with such a name.

### A.6 `robots.txt`

42. **One generated file.** The build writes `robots.txt` from the manifest and the site configuration (spec 9.16, design note 3). It holds the sitemap line, one group for all crawlers, and one group for training crawlers. Section E gives the content (items 145 to 153). The file stays below the 500 KiB limit of Google ([robots.txt][g-robots]).
43. **No crawl block for generated pages.** Pages that must stay out of the index carry `noindex`. They are not blocked in `robots.txt`, because a blocked page cannot show its `noindex` and can still be indexed by its URL ([robots meta][g-robots-meta]). The site has no crawlable filter URLs (item 47), so no crawl block is needed for them.
44. **The Cloudflare managed `robots.txt` stays off.** When it is on, Cloudflare puts its own rules in front of the file: a signal `ai-train=no` for all crawlers and a full block for a list of AI crawlers ([managed robots.txt][cf-managed-robots]). That would refuse training for the author's own text, against D33. A check after each deployment compares the live file with the build output.

### A.7 Pagination

45. **Static pages with a path.** A list that is too long for one page is split into pages with their own URLs: `/-/types/movies/`, `/-/types/movies/2`. The page number is in the path, not in a query, so that rule U12 holds. Each page has its own canonical link, a link to the next and the previous page, a link to page 1, and numbered links to all pages, as plain `<a href>` ([pagination][g-pagination]). The numbered links keep every page two clicks from the hub. The movie hub has about 4,900 entries, so this matters. `rel="next"` and `rel="prev"` are optional: Google does not use them ([pagination][g-pagination]).

### A.8 Generated pages under `/-/`

46. **Index rule per kind.** ADR 0004 covers notes. Generated pages are not notes, so they can carry `noindex`.

| Row | Generated page                                       | Robots                  | Reason                                                   |
| --- | ---------------------------------------------------- | ----------------------- | -------------------------------------------------------- |
| 46a | Home                                                 | index                   |                                                          |
| 46b | Type hub, all pages                                  | index                   | The crawl path to every note (item 59).                  |
| 46c | Curated list from the registry (item 92)             | index                   | Carries the search value of thin types (spec 9.13.6).    |
| 46d | Tag page with at least the threshold number of notes | index                   | A real topic list.                                       |
| 46e | Tag page below the threshold                         | `noindex, follow`       | One or two links are a thin page. Threshold: item 179.   |
| 46f | Folder URL with a folder note that has own text      | index (it is a note)    | ADR 0004.                                                |
| 46g | Folder URL with a generated list only                | `noindex, follow`       | It repeats the type hub with folder numbers as headings. |
| 46h | "Recently added", "Recently updated", page 1         | index                   | Shows that the site is alive. U7 keeps the old URLs.     |
| 46i | Recent pages after page 1, change log pages          | `noindex, follow`       | The same links in another order.                         |
| 46j | Stats page                                           | index                   | Original data of the author.                             |
| 46k | Author page                                          | index                   | The entity page (item 70).                               |
| 46l | Search page, graph page, random note                 | `noindex, follow`       | No text content of their own.                            |
| 46m | "All backlinks of X" pages (item 56)                 | `noindex, follow`       | Link lists.                                              |
| 46n | Markdown twins, JSON files, feeds, API               | `X-Robots-Tag: noindex` | Not pages.                                               |

47. **No crawlable filter combinations.** Filters and sort orders on hubs and in search run in the browser, and their state lives in the URL fragment. Google does not use fragments for crawling, so such filters have "no impact on crawling" ([facets][g-facets]). The build writes no `<a href>` with a query string to a generated page. So a filter can never become a URL that a crawler follows.
48. **An allow list decides what is indexable.** Indexable list pages come from one registry file (item 92). A page that is not in the registry, and not of a kind in rows 46a to 46k, gets `noindex`. A new kind of generated page is `noindex` until a rule says otherwise.
49. **Growth guard.** A build fails when the number of indexable generated pages rises above a set share of the number of notes, or when it grows by more than a set step between two builds without a change of the registry. Google warns that many low-value URLs take crawl resources from the rest ([crawl budget][g-crawl-budget]) and states that "a high quantity of pages doesn't make a website higher quality" ([AI optimization guide][g-ai-guide]).

### A.9 Languages

50. **`lang` per page.** `<html lang>` comes from the language of the note (spec 9.1.5). A French note in an English site frame is still `lang="fr"`, because the main content decides ([localized versions][g-hreflang]).
51. **`hreflang` for documentation twins.** A French page and its English twin carry `<link rel="alternate" hreflang="fr">`, `hreflang="en"` and `hreflang="x-default"` (the English page), each with an absolute canonical URL, and each page lists itself. Google ignores a pair that does not point both ways ([localized versions][g-hreflang]). One method only: link elements in the HTML, not in the sitemap as well.
52. **The pair comes from the notes.** A property on the note names its twin. The publication check fails when a twin link is not answered by the other note, or when a twin is not live. A French note without a twin gets `lang="fr"` and no `hreflang`.

### A.10 Internal links

53. **Plain links.** Every internal link is an `<a href>` with the canonical URL and the note title or the alias as text. No `nofollow` on internal links. Google asks for `<a href>` links between pages ([pagination][g-pagination]).
54. **"Part of" line.** A `<nav aria-label="Part of">` above the content lists the maps of content that link to the note (spec 9.4.2). In JSON-LD each map is an `isPartOf` reference to the `CollectionPage` of that map.
55. **Breadcrumb.** A visible breadcrumb and a `BreadcrumbList` with the same items: Home, the type hub, and for media the sub-hub, then the note. Google asks for a typical user path "instead of mirroring the URL structure" and allows more than one trail ([breadcrumb][g-sd-breadcrumb]). The folder path (`30 Areas`, `33.02 Content`) is the URL structure and means nothing to a reader, so it is not the breadcrumb. A second trail through the first map of content is allowed.
56. **Backlinks.** A `<section>` after the content, with a heading, a list, and per entry a link and the sentence around the link (story 6). The sentence sits in a `span` or `div` with `data-nosnippet`, so that a search snippet of this page comes from this note and not from another one ([robots meta][g-robots-meta]). The first entries are in the HTML. For a note with very many backlinks the rest is on `/-/backlinks/...` pages (row 46m), which keeps large data out of the page (spec 9.14.9).
57. **Related notes.** An `<aside aria-label="Related notes">` with plain links. Order: shared links first, shared tags second (D26).
58. **Link properties.** A property that links to a note (`directors`, `designers`, `authors`, `franchise`, `base_game`) renders as a link when the target is live (spec 9.3.4). This is the main link source of media notes.
59. **No orphan.** Every indexable note is reachable from the home page through `<a href>` links in at most four steps: home, type hub, hub page, note. A build check walks the links and fails on a note that it cannot reach.
60. **Links between the three hosts.** The header or footer of every page links to the main site and to the store with stable text. These links and the author markup of item 70 are what tie the hosts together for a crawler. **[Inference]**

### A.11 Headings

61. **One `<h1>`.** The page title is the only `<h1>`. A first heading in the note that repeats the title is removed. When a note uses level-1 headings in its body, all body headings move down one level. Sections that the build adds ("Linked from", "Related notes", "Cite this note") are `<h2>` after the content.
62. **Stable ids.** Each heading has an id that follows rule U8 and does not change between builds when the text does not change. A skipped level in the author's text is a warning in the publication report, not a build failure.

### A.12 Images

63. **Alt text for covers.** A cover has a generated alt text from properties: "Cover of the board game {title} ({year})", "Poster of the movie {title} ({year})". Google calls alt text the most important image metadata and warns against keyword lists ([images][g-images]).
64. **Alt text for other images.** The alt text that the author wrote wins. Without one, the build uses the file name when it is a real name, and an empty alt plus a warning when the name is a generated one ("Pasted image", a hash, a camera number). No alt text is invented at build time.
65. **File names and URLs.** The content-hashed URL of rule U10 keeps the readable name: `{readable-name}.{hash}.webp`. One image has one URL on all pages. Google asks for descriptive names and for one URL per image ([images][g-images]).
66. **Markup.** Every `<img>` has `width`, `height`, `alt`, and a `src` fallback next to `srcset` ([images][g-images]). The first image of a media note (the cover) loads eagerly with high priority. All others load lazily (spec 9.14.3).
67. **Preview size.** Pages carry `max-image-preview:large` in the robots meta element, so that search engines may show a large preview ([robots meta][g-robots-meta]). D33 allows search for all content.

### A.13 Core Web Vitals

68. **Field targets.** Largest Contentful Paint at most 2.5 s, Interaction to Next Paint at most 200 ms, Cumulative Layout Shift at most 0.1, each at the 75th percentile of page loads, for phones and for desktops ([Web Vitals][webdev-vitals]). The Search Console report gives these values per URL group when the traffic is large enough.
69. **Laboratory gates.** The budgets of spec 9.14 and decision D30 are the gate in CI, per note type. They must be stricter than the field targets, because a laboratory run has no slow network of a real reader. Google states that faster pages let it crawl more of a site ([crawl budget][g-crawl-budget]). That matters after the switch, when every URL needs a new crawl.

### A.14 Structured data

70. **One author entity.** One `Person` node with one `@id` stands for the author on every page of the notes host. The same `@id` string is offered to the main site and the store. The full node (name, description, image, `url`, `sameAs` to the main site, the store, the newsletter and the public profiles) is on the author page only. Other pages repeat the short form: `@id`, `name`, `url`. Google asks for `author.name` and `author.url` on articles and offers `ProfilePage` for "an 'About Me' page on a blog site" ([Article][g-sd-article], [ProfilePage][g-sd-profile]).
71. **One publisher entity.** One `Organization` node (name, `url`, `logo`) as `publisher` of every page and of the `WebSite` node.
72. **One graph per page.** Each page has one JSON-LD block with a `@graph`: the page node, the main entity, the `BreadcrumbList`, and the short author and publisher nodes. Nodes refer to each other by `@id`.
73. **Visible content only.** Every value in the markup is also visible on the page. Google forbids markup for content "that is not visible to readers" ([structured data policies][g-sd-policies], [AI features][g-ai-features]). So the properties that feed the markup are in the header or in the key facts box (item 159), not only in the closed properties panel.
74. **Types per note type.** "Rich result" names the Google feature that the markup can qualify for. No feature is guaranteed ([structured data policies][g-sd-policies]).

| Row | Note type                        | Page node        | Main entity and minimum properties                                                                                                                                                                             | Rich result                                                              |
| --- | -------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 74a | Permanent note, literature note  | `WebPage`        | `Article`: `headline`, `description`, `author`, `publisher`, `datePublished`, `dateModified`, `inLanguage`, `image`, `isPartOf` (maps), `keywords` (tags), `about` (row 74b)                                   | Article                                                                  |
| 74b | Concept with a definition        | (inside 74a)     | `DefinedTerm` as `about` of the article: `name`, `description` (the `description` property), `inDefinedTermSet` (the hub of the type). Only when the description is filled                                     | None                                                                     |
| 74c | Quote                            | `WebPage`        | `Quotation`: `text`, `creator` (`Person`: name, URL of the person note), `inLanguage`, `about` (topics), `isBasedOn` (the source book, when known)                                                             | None                                                                     |
| 74d | Own quote                        | `WebPage`        | `Quotation`: `text`, `creator` (the author entity)                                                                                                                                                             | None                                                                     |
| 74e | Person                           | `WebPage`        | `Person`: `name`, `description` (public role), `url`. `sameAs` only for links that D40 allows                                                                                                                  | None                                                                     |
| 74f | Book note                        | `WebPage`        | `Book`: `name`, `author`, `isbn`, `numberOfPages`, `datePublished`, `publisher`, `image`, `sameAs`. Plus `review` (item 75)                                                                                    | Review snippet                                                           |
| 74g | Movie                            | `WebPage`        | `Movie`: `name`, `image`, `dateCreated`, `director`, `actor` (first names of `cast`), `duration`, `genre`, `sameAs`. Plus `review`                                                                             | Review snippet. Movie carousel on a list page only ([Movie][g-sd-movie]) |
| 74h | TV show, anime series            | `WebPage`        | `TVSeries`: `name`, `image`, `startDate`, `endDate`, `numberOfSeasons`, `numberOfEpisodes`, `creator`, `actor`, `sameAs`. Plus `review`. An anime of kind "movie" uses row 74g                                 | Review snippet                                                           |
| 74i | Video game                       | `WebPage`        | `VideoGame`: `name`, `image`, `datePublished`, `gamePlatform`, `author` (developers), `publisher`, `genre`, `playMode`, `sameAs` or `identifier`. Plus `review`                                                | Review snippet                                                           |
| 74j | Board game, board game item      | `WebPage`        | `Game`: `name`, `image`, `datePublished`, `numberOfPlayers` (`minValue`, `maxValue`), `author` (designers), `publisher`, `genre` (mechanics), `sameAs`. Plus `review`. An item adds `isPartOf` (the base game) | Review snippet                                                           |
| 74k | Music work                       | `WebPage`        | `MusicComposition`: `name`, `composer`, `musicalKey`, `sameAs`                                                                                                                                                 | None                                                                     |
| 74l | Arrangement, tab                 | `WebPage`        | `SheetMusic`: `name`, `creator` (the arranger), `isBasedOn` (the `MusicComposition` of the work), `inLanguage`                                                                                                 | None                                                                     |
| 74m | Chord, scale, technique, theory  | `WebPage`        | `Article` with `about` a `DefinedTerm` (the chord symbol or the scale name)                                                                                                                                    | Article                                                                  |
| 74n | Product page, documentation      | `WebPage`        | `TechArticle`: as row 74a, plus `about` a `SoftwareApplication` or `Product` with `name` and `url` (the store page). No `offers`, no price. Twins add `translationOfWork` or `workTranslation`                 | Article                                                                  |
| 74o | AI wiki article                  | `WebPage`        | `Article`: `headline`, `description`, `publisher`, dates, `citation` (the `sources` property), `digitalSourceType` (item 104). No human `author`                                                               | Article                                                                  |
| 74p | Article or newsletter copy       | `WebPage`        | `Article`: `headline`, `author`, `datePublished`, and `url` and `mainEntityOfPage` set to the main-site URL                                                                                                    | None on this host                                                        |
| 74q | Map of content                   | `CollectionPage` | `ItemList`: `numberOfItems`, `itemListElement` (`ListItem`: `position`, `url`, `name`). Plus `about` (the topic)                                                                                               | None                                                                     |
| 74r | Type hub, tag page, curated list | `CollectionPage` | `ItemList` with `ListItem` entries that hold `position` and `url` only                                                                                                                                         | Movie carousel for a movie list, phones only ([Movie][g-sd-movie])       |
| 74s | Home                             | `WebPage`        | `WebSite`: `name`, `alternateName`, `url`, `inLanguage`, `publisher`. On the home page only ([site names][g-sitename])                                                                                         | Site name                                                                |
| 74t | Author page                      | `ProfilePage`    | `Person` (item 70): `name`, `alternateName`, `description`, `image`, `sameAs`. Plus `dateCreated`, `dateModified` on the page node ([ProfilePage][g-sd-profile])                                               | Profile page                                                             |
| 74u | Every page                       | (in the graph)   | `BreadcrumbList`: at least two `ListItem` nodes with `position`, `name`, `item` ([breadcrumb][g-sd-breadcrumb])                                                                                                | Breadcrumb                                                               |

75. **The author's rating as a `Review`.** A media or book note with a `rating` carries one `Review`: `author` (the author entity), `reviewRating` with `ratingValue` (0 to 5), `bestRating` 5 and `worstRating` 0, `datePublished`, and `reviewBody` when the note has own text. Google supports review snippets for `Book`, `Movie`, `Game`, `CreativeWorkSeries` and `SoftwareApplication`, requires `author`, the reviewed item and the rating value, and assumes a scale of 1 to 5 unless the markup says otherwise ([review snippet][g-sd-review]). A note without a rating carries no `Review`.
76. **No `AggregateRating` from other sites.** The `online_rating` property is a score from another database. It is shown as text and never marked as `aggregateRating`. Google requires that ratings in markup come from the site's own users or reviewer ([structured data policies][g-sd-policies], [review snippet][g-sd-review]).
77. **Why `Article` and not `DefinedTerm` as the main entity of a concept note.** `DefinedTerm` is an `Intangible`: it has no author and no dates ([DefinedTerm][schema-definedterm]). Google has no feature for it ([gallery][g-sd-gallery]). `Article` carries author, dates and image, and Google reads it ([Article][g-sd-article]). So the note is an `Article` about a `DefinedTerm`. `TechArticle` is used for documentation only: it is a subtype of `Article`, and Google names `Article`, `NewsArticle` and `BlogPosting` in its list ([Article][g-sd-article]).
78. **`sameAs` and identifiers.** The table says where a link to an outside record is built and what it gives.

| Row | Type              | Source property             | Link                                                                                      | What it gives                                                                                         |
| --- | ----------------- | --------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 78a | Movie, TV show    | `imdb_id`, `tmdb_id`        | `https://www.imdb.com/title/{imdb_id}/`, the TMDB page                                    | Tells two works with one name apart. No documented ranking use                                        |
| 78b | Board game        | `bgg_id`                    | `https://boardgamegeek.com/boardgame/{bgg_id}`                                            | As 78a                                                                                                |
| 78c | Video game        | `steam_app_id`, `igdb_id`   | The Steam store page as `sameAs`. The IGDB id as `identifier` (a `PropertyValue`), no URL | A numeric IGDB id gives no stable public URL, so it is not a `sameAs`                                 |
| 78d | Anime             | `mal_id`, `anilist_id`      | The MyAnimeList and AniList pages                                                         | As 78a                                                                                                |
| 78e | Book              | `isbn`                      | `https://openlibrary.org/isbn/{isbn}`, and `isbn` itself                                  | `isbn` is the stronger key                                                                            |
| 78f | Music work        | `musicbrainz_id`            | The MusicBrainz work page                                                                 | As 78a                                                                                                |
| 78g | Person            | public links, if D40 allows | Wikipedia page, official site                                                             | Tells people with one name apart. Depends on D40                                                      |
| 78h | Author, publisher | site configuration          | Main site, store, newsletter, public profiles                                             | Google documents `sameAs` for profile pages ([ProfilePage][g-sd-profile]). This is the one proven use |
| 78i | Any type          | (no property today)         | Wikidata                                                                                  | The vault holds no Wikidata ids. Adding them is vault work, not site work. Not a requirement          |

79. **`WebSite` without a search action.** Google removed the sitelinks search box in November 2024 and says that leftover markup causes no problem ([sitelinks search box][g-searchbox]). So `potentialAction` with a `SearchAction` gives no Google feature. It is optional and second wave. The `WebSite` node itself stays, because Google reads the site name from it, also for a subdomain ([site names][g-sitename]).
80. **Validation.** A build test checks each JSON-LD block against the schema of its type, and a snapshot per note type catches changes. One page per type goes through the Rich Results Test at each release, and the result is recorded. The privacy gate also runs on the markup: person data never enters it (spec 7, spec 9.13.3).

## B. Thin pages

### B.1 What search engines do with 14,000 thin pages on one host

81. **Crawl budget is not the limit.** Google writes its crawl budget guide for sites with more than a million pages, or more than 10,000 pages that change every day ([crawl budget][g-crawl-budget]). 20,700 static pages are far below that. **[Doc]**
82. **Crawl demand follows quality.** Google crawls a URL more or less often by its popularity, its staleness and the quality of the site ([crawl budget][g-crawl-budget]). So thin notes get a first crawl and then few new crawls. **[Inference]** from that text.
83. **Many thin notes will not be indexed.** A 200 status does not promise a place in the index ([status codes][g-status]). The Search Console state "Crawled - currently not indexed" means only "The page was crawled by Google but not indexed" ([page indexing report][g-index-report]). Google gives no reason per URL. The common reading is "not enough value". **[Inference]** Expect this state for a large share of the media notes. It is not an error to repair.
84. **Signals of the host.** Google ranks pages, but it states that "site-wide signals and classifiers are also used" ([ranking systems][g-ranking]). So 14,000 thin pages can weigh on the 6,700 others. No source gives the size of that effect (item 197).
85. **Policy position.** The scaled content policy targets pages "generated for the primary purpose of manipulating search rankings" ([spam policies][g-spam]). A personal catalog with the author's own status and rating is not that. Google calls "a first-hand review" non-commodity content and calls content that "could easily be produced by a generative AI model" commodity content ([AI optimization guide][g-ai-guide]). So the author's data is the asset of a thin note, and generated filler text would be the risk.
86. **Near-duplicates.** Bing states that AI systems group near-duplicate URLs and pick one page for the group ([Bing on duplicates][b-dup]). Two media pages that differ only in a title look like that. The share of fixed layout text against note data must be low.

### B.2 Measures per thin type, without new writing by the author

87. **Principle.** The floor rises through data that the vault already holds, through links, and through structure. The build never writes prose with a language model for a note page. Google names AI-generated pages "without adding value" as scaled content abuse ([generative AI content][g-genai-content]).
88. **Measures per type.**

| Row | Type                            | Unique data to show first                                                        | Context that the build adds                                                                                                                 | Markup            |
| --- | ------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| 88a | Movie, TV show, anime           | Status, rating, date finished, where it was watched (`consumed_via`), own text   | "Same franchise" (`franchise`, `related_media`), "Same director" (the first entries), the maps and lists that hold the note, backlinks      | Rows 74g, 74h, 75 |
| 88b | Video game                      | Status, completion, hours played, rating, platform, own text                     | "Same franchise", "Same developer", lists that hold the note                                                                                | Rows 74i, 75      |
| 88c | Board game, board game item     | Ownership, rating, number of plays (`dates_played`), best player count, own text | Base game and expansions (`base_game`, `integrates_with`), "Same designer", "Same mechanics I own", lists that hold the note                | Rows 74j, 75      |
| 88d | Quote                           | The quote, the person, the source, the author's rating of the quote              | "More quotes by this person" (the first five), "Notes on these topics" (notes that share topic tags), the "quotes about" list of each topic | Row 74c           |
| 88e | Own quote                       | The quote, the date                                                              | The notes that use it (backlinks), related own quotes (`related_quotes`)                                                                    | Row 74d           |
| 88f | Person                          | Public role, the author's text                                                   | Generated summary: quotes by the person, books by the person, notes that mention the person. The page becomes a hub for that person         | Row 74e           |
| 88g | Book note without own text      | Status, rating, dates                                                            | Quotes from the book, literature notes on it, the author's person note                                                                      | Rows 74f, 75      |
| 88h | Chord, scale (mostly a diagram) | The diagram, the fingering, the sound                                            | Arrangements that use it, related chords                                                                                                    | Row 74m           |

89. **Generated descriptions.** Rows 12c to 12l give each thin note a meta description that differs from every other one, as Google asks ([snippets][g-snippet]).
90. **Stub notes.** A media note with the default status, no rating and no own text is a catalog row. It stays indexed (ADR 0004). It shows what it has and nothing more: no empty sections, no empty property rows, no "My take" heading without text. It is left out of curated lists. The publication report counts the stubs per type, so that the author can use the per-note override of ADR 0004.
91. **Fixed text.** The layout text of a thin page (navigation, newsletter bar, footer) stays small against the note data. Ads already skip person and quote notes (spec 9.10.11). The same exclusion for stub notes is proposed (item 180).

### B.3 Generated pages that carry the search value

92. **A registry of curated lists.** One file in the site configuration defines each indexable list page: a slug under `/-/lists/`, a title, an intro text that the author wrote or approved, one filter (a type, one property condition, one sort order), the columns to show, and a minimum number of items. The build makes one static page per entry (paginated by item 45). Nothing else creates an indexable list.
93. **List families that the data supports.**

| Row | Family                                     | Built from                                                                    | Example                                        |
| --- | ------------------------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------- |
| 93a | Owned games by one mechanic                | `ownership`, `mechanics`, `rating`                                            | "Cooperative board games I own, by my rating"  |
| 93b | Top rated of a type, by decade or platform | `rating`, `release_date`, `platforms`                                         | "Video games I rated 5/5"                      |
| 93c | Quotes about a topic                       | Quote notes that share a topic tag, for topics that have a map of content     | "Quotes about habits" (backlog 85)             |
| 93d | People behind a topic                      | Person notes that the notes of one map of content link to, by number of links | "People who shaped my thinking on note-taking" |
| 93e | Books on a topic                           | `status`, `topics`, `rating`                                                  | "Books I read about knowledge management"      |
| 93f | Completed or abandoned                     | `status`, `completion`                                                        | "Games I finished at 100 percent"              |

94. **Rules that keep a list from being a doorway page.** Google defines doorway abuse as pages made "to rank for specific, similar search queries" and names "substantially similar pages that are closer to search results than a clearly defined, browseable hierarchy" ([spam policies][g-spam]). So:
    1. A list is part of the hierarchy: its type hub links to it, and each of its notes links back to it ("part of").
    2. A list has an intro text by the author. No list goes live with a generated intro.
    3. A list has a minimum number of items, and it shows the author's own data per item (rating, status, ownership).
    4. One filter dimension per list. A list over two dimensions exists only as a hand-written registry entry. No matrix of combinations is ever generated.
    5. Two lists whose item sets overlap by more than a set share fail the registry check.
    6. The word "best" appears only on a list that is sorted by the author's rating, and the page says so.
    7. "Quotes by {person}" is a section of the person note, not a second page.
    8. The registry has a size cap (item 49).

### B.4 Sitemaps after the switch

95. **All sitemaps are live at the switch.** Spec 9.13.8 releases sitemaps in stages. This file proposes another reading (item 178). Every note URL is already known to the search engines, with a wrong canonical URL. A sitemap is a hint for discovery, not a gate ([sitemaps][g-sitemap]), so leaving a file out does not stop the crawl of known URLs. It only delays the repair. The stages apply to what is pushed, not to what exists:
    1. Sitemap index with all files: live at the switch.
    2. Order of submission in Search Console and Bing Webmaster Tools, and order of the IndexNow batches: rows 35a to 35f and 35m first, then quotes and people, then media.
    3. The per-file reports in Search Console then show the indexed share per type (item 35).

### B.5 What to monitor

96. **Per sitemap file**: submitted URLs, indexed URLs, and the count in "Crawled - currently not indexed" ([page indexing report][g-index-report]).
97. **Per note type, from the edge logs**: requests of Googlebot and Bingbot per day, and the share of URLs that got a crawl since the switch.
98. **Per note type, from Search Console**: impressions and clicks, compared with the baseline (story 93). The own-text types (rows 35a to 35f) are the control group. The one success metric of spec 9.13.8 is proposed as: clicks from search to the own-text types.
99. **Action rule.** When the own-text types fall below the baseline while the thin types are crawled and dropped, the levers inside ADR 0004 are, in this order: fix the template of the thin type, remove thin types from prominent internal links (home page, recent lists), use the per-note override for stubs. A type-wide `noindex` stays a decision of the author, outside this file.

## C. Duplicate content

100. **Article and newsletter copies (675 notes).** Item 22 sets the canonical link. In addition: a visible line "First published on {main site} on {date}" with a link to the post, the copies stay out of the sitemaps, out of the feeds, out of `llms.txt` and out of IndexNow, and the Markdown twin of a copy names the main-site URL as its source. Bing asks for a canonical link and prefers excerpts over full copies for syndicated text ([Bing on duplicates][b-dup]). Excerpts are not possible here, because the garden links into these notes. So the canonical link and the visible line carry the signal.
101. **Copies without a verified target.** A copy whose `url` property is empty, or whose target does not answer 200, cannot name its original. It gets `noindex` through the per-note override until the target is verified (item 182). The publication report lists these notes.
102. **Product documentation and the store.** The store holds the product pages with the offer. The notes host holds the documentation. Rule: the notes host is the canonical place for documentation text, the store for the offer. Markup follows that split: no `offers` and no price on the notes host (row 74n). A report compares the text of each documentation note with the store pages and lists strong overlaps, so that the store can link to the documentation, or name it as canonical, in its own project. The store is not changed here (ADR 0001).
103. **Quotes.** The text of a quote exists on many sites. The page will not rank for the quote text itself, and it does not need to. Its own value is the attribution, the source, the topic links and the lists of row 93c. The letter-case variants of a quote are aliases today, and the resolver sends them to one URL, so they create no extra pages.
104. **AI-written wiki articles (470).** Google allows AI-written content that meets its quality rules, asks that automation is "self-evident to visitors through disclosures", and warns against invented authors ([helpful content][g-helpful], [generative AI content][g-genai-content]). Requirements:
     1. A visible line under the title: written by an AI model, from which sources, reviewed or not by the author. The `ai_generated`, `sources`, `confidence` and `maturity` properties feed it.
     2. In markup: `digitalSourceType` with the value `TrainedAlgorithmicMediaDigitalSource` ([digitalSourceType][schema-dst], [enumeration][schema-iptc]), `citation` for the sources, the publisher, and no human `author`. The author appears as `editor` only when the note says that he reviewed it.
     3. Any note of any type with `ai_generated: true` gets the same line and the same marker.
     4. The articles have their own sitemap file (row 35d), so that their index state is visible apart from the hand-written notes.
105. **Near-duplicate notes.** A build report compares the cleaned text of notes of the same type and lists pairs above a similarity limit. It is a warning for the author, not a build failure. Known sources of pairs: two editions of one game, a board game and its item note, a movie and its remake.
106. **French and English twins.** Translated pages are not duplicates for Google when the main content is translated ([localized versions][g-hreflang], [canonicalization][g-canon-what]). Items 50 to 52 mark them.
107. **Markdown twins and `.md` URLs.** Item 23 keeps the twins out of the index. A path with a `.md` suffix redirects to the page (row 26d). So no note has two indexable forms.
108. **Lists over the same notes.** A folder listing, a type hub, a tag page, a map of content and a curated list can all list the same notes. Only the forms with their own purpose are indexable (rows 46b to 46g), and the overlap check of item 94 covers the curated lists.
109. **Embedded notes.** A note that embeds another note repeats its text. About 25 notes do that (research 1.4). The embedded block carries a visible link to its source note. No further rule is needed at this volume.
110. **Other hosts for the same content.** The preview host carries `X-Robots-Tag: noindex` and is not linked (spec 11.2.9). To verify before the switch: whether the site also answers on the default host of Obsidian Publish next to the custom domain, and whether search engines hold URLs of it. If yes, those copies disappear only when Obsidian Publish is cancelled. **Unverified.**

## D. Migration from the damaged index

### D.1 Facts that shape the procedure

111. **The Change of Address tool does not apply.** Google offers it for a move "from one domain or subdomain to another". For a change of hosting without a change of URLs it points to its guide for moves without URL changes ([Change of Address][g-coa], [site move without URL changes][g-move]). The host stays `notes.dsebastien.net`, so this is that second case.
112. **Google expects a dip and a recovery of the crawl rate.** After a hosting change "it's normal to see a temporary drop" in the crawl rate, followed by a rise ([site move without URL changes][g-move]).
113. **The repair needs a new crawl of every note.** The corrected canonical link reaches a search engine only when it fetches the page again. So the procedure aims at fast, complete recrawling: correct signals, complete sitemaps, a push through IndexNow, and an origin that never answers a crawler with an error.
114. **What the engines did with the wrong canonical link is not known.** About 19,200 notes named a cut URL as canonical, and each cut URL was shared by many notes with different content. Google treats the link as a hint and may have chosen the note URLs itself ([canonicalization][g-canon-what]). The baseline must show which case holds (item 117). **[Inference]**

### D.2 Before the switch

115. **Search Console.** A URL-prefix property for `https://notes.dsebastien.net/` exists next to any domain property, with a verification method that survives the switch: a DNS record, or a file or meta element that the new site also serves (item 41). Google lists this step ([site move without URL changes][g-move]).
116. **Bing Webmaster Tools.** The same for Bing, with its own verification. Bing also feeds Copilot and, in part, ChatGPT search (items 139 and 140).
117. **Baseline.** Exported and kept outside this repository:
     1. Search Console performance by page and by query, for the longest range that the tool gives.
     2. The page indexing report: the count per state, and the example URLs of "Duplicate, Google chose different canonical than user", "Alternate page with proper canonical tag", "Soft 404" and "Crawled - currently not indexed" ([page indexing report][g-index-report]).
     3. URL Inspection on a sample of each note type: the canonical URL that the page declared and the one that Google selected.
     4. Bing: indexed pages, and the AI Performance report ([Bing AI Performance][b-ai-perf]).
     5. Whether any cut URL (item 118) has impressions.
118. **Inventory of the cut canonical targets.** A script cuts every note path of the Publish cache at its first dot and writes the list of distinct targets. Two kinds exist: a target that many notes share (a folder with a dot in its name, for example `/30+Areas/33+Permanent+notes/33` for every note below `33.02 Content`), and a target of one note (a dot in the file name only: 1,488 notes have a dot in the file name, research 1.4b).
119. **Full check of the preview host.** Every requirement of section F with priority G passes on the preview host. Google asks to test the copy and to check that the firewall does not block Googlebot ([site move without URL changes][g-move]).
120. **DNS and edge settings.** The time to live of the DNS record is lowered ahead of the switch ([site move without URL changes][g-move]). At the edge: the managed `robots.txt` is off (item 44), the AI crawler policies allow search and agent traffic (item 152), no feature injects scripts (spec 9.15.2), and verified search crawlers are exempt from rate limits (item 33).
121. **IndexNow key.** The key file is in the build output at the root of the host ([IndexNow documentation][indexnow-doc]).

### D.3 At the switch

122. **Order.** (1) Deploy the release that has no `noindex` header on indexable pages. (2) Move the DNS record. (3) Check from outside: `robots.txt` 200 and equal to the build output, sitemap index 200, a sample of notes 200 with the right canonical link, an unknown path 404, a variant one redirect. (4) Submit the sitemap index and each sitemap file in Search Console and in Bing Webmaster Tools. (5) Send the IndexNow batches. (6) Request indexing by hand in URL Inspection for the home page, the type hubs and the pages with the most clicks in the baseline.
123. **IndexNow for the whole site, one time.** IndexNow is "not designed for submitting every URL on your site at once", with one exception that fits: after "a migration or redesign" a full submission is acceptable ([IndexNow FAQ][indexnow-faq]). A request holds up to 10,000 URLs, and one submission reaches all engines that take part: Bing, Yandex, Naver, Seznam, Yep and Amazon ([IndexNow documentation][indexnow-doc], [IndexNow FAQ][indexnow-faq]). Google does not take part. The batches follow the order of item 95. The cut targets that now answer 404 are submitted too, because the FAQ asks for URLs that answer 404 or 410 ([IndexNow FAQ][indexnow-faq]).
124. **`lastmod` at the switch.** Spec 6.7 says that a change of the renderer does not move the dates of a note. That stays true for the visible dates and for the feeds. For the sitemaps only, and one time only, this file proposes the switch date as `lastmod` of every note (item 177). On that day the canonical link, the structured data and the links of every page change, and Google counts a change of structured data or links as significant ([sitemaps][g-sitemap]). After that day `lastmod` follows item 37.
125. **What the cut canonical targets answer.** Proposal (item 176):
     1. A target that many notes shared answers **404**, with the normal 404 page. It was never a page, a 404 removes it from the index ([status codes][g-status]), and a redirect to a hub would be a soft 404 (item 28).
     2. A target of one note also answers 404, unless the baseline shows that this URL is indexed or has impressions. Then it gets a 301 to its note, from a fixed list that is made one time.
     3. A cut target that equals a real path, file name or alias follows the resolver. The real note wins.
     4. A test walks the whole list of item 118 and checks each answer.
126. **URLs that exist only because every path answered 200.** Any junk URL in the index now gets a real 404 and leaves the index by itself ([status codes][g-status]). The 404 report of the first days shows which of them had real visitors and need a redirect (spec 11.3.4).

### D.4 After the switch

127. **Search Console, per sitemap file**: indexed share, and the states of item 117 over time. The count of "Duplicate, Google chose different canonical than user" for note URLs must fall. "Validate fix" on that issue group asks Google for a recheck. Google says that a validation "typically takes up to about two weeks" and can take longer ([page indexing report][g-index-report]).
128. **Crawl statistics**: response codes and host status in the crawl stats report of Search Console, and the same from the edge logs for Googlebot and Bingbot. Any 5xx, 429 or 403 for a search crawler is an alert.
129. **Recrawl coverage**: the share of note URLs, per type, that Googlebot fetched since the switch, and the same for Bingbot. This is the direct measure of the repair.
130. **Canonical check**: URL Inspection on the same sample as in the baseline. The canonical URL that Google selected must equal the declared one.
131. **Traffic**: clicks and impressions per note type against the baseline, and the Plausible numbers with the unchanged site id (story 89).
132. **404 report**: unknown paths with visitors or with crawler requests feed the redirect list.
133. **Bing**: indexed pages, IndexNow status, and the AI Performance report.

### D.5 When the old system can be switched off

134. **The window ends by conditions, and the author decides** (spec 11.3.2). Proposed conditions, all true at the same moment:
     1. No error answers for search crawlers since the last incident review.
     2. Recrawl coverage (item 129) is complete for the own-text types and above a set share for the thin types.
     3. The canonical check (item 130) passes for the sample of every type.
     4. At least one full comparison period of Search Console data after the switch exists, and the own-text types are at or above the baseline in it. Proposed minimum: one period of 28 days, which is a standard comparison range of Search Console.
     5. The count of "Duplicate, Google chose different canonical than user" for note URLs is falling, not rising.
     6. The 404 report has no open entry with real visitors.
135. **What a revert costs.** A revert of the DNS record brings the wrong canonical links back for every page that a crawler fetches in that time. So a revert is for a broken site, not for a dip in traffic. A dip is expected (item 112).
136. **What the switch cannot repair.** Images that search engines hold under the Obsidian host disappear when Obsidian Publish is cancelled, and no redirect is possible from that host (research 1.6). Copies in caches of crawlers and AI models stay as they are (spec 6.8.6).

## E. AI search and agent visibility (AISEO)

### E.1 How each engine selects and cites sources: what is known

137. **The operators publish access rules, not ranking rules.** Each engine documents which crawler must reach a page. None documents how it picks a source for an answer. Every statement about "ranking factors" for AI answers comes from a study or from a seller of tools. This section marks which is which.
138. **Google AI Overviews and AI Mode.** **[Doc]**
     1. A page is eligible when it is indexed and can show with a snippet. "There are no additional technical requirements" ([AI features][g-ai-features]).
     2. Both features fan one question out into several related searches and take pages from the Search index through the normal ranking systems ([AI features][g-ai-features], [AI optimization guide][g-ai-guide]).
     3. "You don't need to create new machine readable files, AI text files, markup, or Markdown". Google Search ignores `llms.txt`. No "chunking" and no rewriting for AI is needed ([AI optimization guide][g-ai-guide]).
     4. Controls: `nosnippet`, `data-nosnippet`, `max-snippet` and `noindex`. `nosnippet` also keeps the content out of AI Overviews and AI Mode ([robots meta][g-robots-meta]). `Google-Extended` does not affect Search or its AI features ([Google crawlers][g-crawlers]).
     5. Google asks for "unique, non-commodity content" and names first-hand experience ([succeeding in AI search][g-ai-blog], [AI optimization guide][g-ai-guide]).
     6. The guide states that a site "must be included in Search generative AI features in Search Console" to be eligible ([AI optimization guide][g-ai-guide]). Third-party reports describe a setting for this that is on by default. **[Reported]** The setting must be checked for the notes property.
139. **Microsoft Copilot and AI answers in Bing.** **[Doc]**
     1. They draw on the Bing index. Bing Webmaster Tools reports citations in Copilot and in Bing AI summaries per page, with the "grounding queries" behind them ([Bing AI Performance][b-ai-perf]).
     2. Microsoft's advice: clear headings, tables and question-and-answer sections, claims with evidence, fresh content, IndexNow ([Bing AI Performance][b-ai-perf]). It says that assistants break a page into pieces and select pieces, and it asks for headings that name the topic, short self-contained answers, lists and tables, schema markup, and no key content hidden in tabs or only in images ([Microsoft guidance][ms-ai-answers]). This is guidance of the operator, without published data.
     3. Near-duplicate pages are grouped and one is chosen ([Bing on duplicates][b-dup]).
     4. Controls: the `nocache` and `noarchive` robots values limit use in Copilot answers and in training of Microsoft models ([Bing chat controls][b-chat-controls]).
140. **ChatGPT search.**
     1. **[Doc]** `OAI-SearchBot` must be allowed, or the site "will not be shown in ChatGPT search answers". A change of `robots.txt` takes about a day to apply ([OpenAI bots][openai-bots]). `noindex` is respected ([OpenAI publisher FAQ][openai-faq]).
     2. **[Doc]** OpenAI says that it uses third-party search providers and names Bing ([OpenAI publisher FAQ][openai-faq]). **[Reported]** Tests found a strong overlap of cited URLs with Google results. OpenAI did not confirm a use of Google results.
     3. **[Doc]** Outbound links carry `utm_source=chatgpt.com` ([OpenAI publisher FAQ][openai-faq]).
     4. **[Inference]** A good state in both Bing and Google is the safe position. The Bing side is the one that IndexNow can push.
141. **Perplexity.** **[Doc]** `PerplexityBot` builds the index that Perplexity links to, and `Perplexity-User` fetches a page when a user asks ([Perplexity bots][perplexity-bots]). Perplexity publishes no selection rules. Lists of "Perplexity ranking factors" are claims of third parties. **[Vendor]**
142. **Claude with web search.** **[Doc]** Anthropic runs `Claude-SearchBot` for search quality and `Claude-User` for fetches on request, and a block of either "may reduce your site's visibility" ([Anthropic crawlers][anthropic-bots]). Citations are "always enabled" for its web search, and each search result reaches the model with its URL, its title and its page age ([Claude web search tool][anthropic-search]). **[Reported]** Anthropic lists Brave Search as a subprocessor, and a test found the same results in Claude and in Brave ([Willison][willison-brave]). So presence in the Brave index matters for Claude. No submission tool for it is known to me. **Unverified.**
143. **Published studies.**

| Row  | Study                                                                          | Finding                                                                                                                                                  | Limits                                                                                                                                               |
| ---- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 143a | Aggarwal et al., "GEO", KDD 2024 ([paper][geo-paper])                          | Changes to the text of a source can raise its visibility in generated answers "by up to 40%". The effect differs by domain                               | A research benchmark, not the live engines of today. The methods (adding sources, quotes, numbers) are in the paper body, which was not checked here |
| 143b | Ahrefs, March 2026 ([study][ahrefs-top10])                                     | 37.9 percent of the URLs that AI Overviews cite are in the top 10 for the same query. 863,000 result pages                                               | The same team found about 76 percent in July 2025, with another parser. The two numbers do not compare cleanly                                       |
| 143c | Ahrefs, July 2025 ([study][ahrefs-fresh])                                      | URLs that AI assistants cite are 25.7 percent "fresher" than organic results. AI Overviews are the exception: slightly older                             | A correlation. The average cited page is still 2.9 years old                                                                                         |
| 143d | Indig, February 2026 ([report][sel-indig]) **[Reported]**                      | 44.2 percent of ChatGPT citations point to text in the first 30 percent of a page. Direct definitions and named entities are cited more                  | One engine, 18,012 citations, read here through press coverage                                                                                       |
| 143e | Ahrefs, May 2026 ([study][ahrefs-schema])                                      | 1,885 pages that added JSON-LD: no clear change in citations. AI Mode +2.4 percent and ChatGPT +2.2 percent (not significant), AI Overviews -4.6 percent | Pages that were cited a lot before. A window of 30 days                                                                                              |
| 143f | SE Ranking, November 2025 ([study][seranking-llms], [coverage][sej-llms-300k]) | About 300,000 domains: `llms.txt` has no effect on how often a domain is cited                                                                           | A correlation and a model                                                                                                                            |
| 143g | Ahrefs, June 2026 ([study][ahrefs-llms])                                       | 137,210 domains: 97 percent of the `llms.txt` files got no request in a month. AI retrieval bots made 1.1 percent of the requests                        | Measures fetches of the index file only                                                                                                              |

144. **What follows for this site.** In order of evidence:
     1. Be indexed, correctly, in Google and Bing. This is section A and section D. It has the strongest evidence, because every engine starts from a search index.
     2. Let the search crawlers and the user-triggered fetchers in (items 145 to 153).
     3. Put the answer and the author's own data at the top of the page, in static HTML (items 158 to 166). Evidence: operator guidance and one study (row 143d).
     4. Make the author one entity across the hosts (item 167). Evidence: documentation for profile markup, none for AI answers.
     5. Keep dates honest and push changes (item 168). Evidence: row 143c and the Bing documentation.
     6. Treat `llms.txt`, Markdown on request and structured data as service to agents and to search features, not as levers for citations (items 154 to 157).

### E.2 Crawlers and the D33 policy

145. **Crawlers by purpose.** The tokens are the names for `robots.txt`.

| Row  | Operator   | Search index                                      | Fetch on request of a user                                                  | Training                                                                                                             | Source                                         |
| ---- | ---------- | ------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 145a | Google     | `Googlebot` (also feeds AI Overviews and AI Mode) | `Google-Agent`, `Google-GeminiNotebook`. They "generally ignore robots.txt" | `Google-Extended`: a token without its own crawler. It also switches off grounding in the Gemini apps, not in Search | [crawlers][g-crawlers], [fetchers][g-fetchers] |
| 145b | Microsoft  | `bingbot` (feeds Copilot)                         | Not documented in the sources read                                          | No token. Page-level `nocache` and `noarchive`                                                                       | [Bing chat controls][b-chat-controls]          |
| 145c | OpenAI     | `OAI-SearchBot`                                   | `ChatGPT-User`. For it, "robots.txt rules may not apply"                    | `GPTBot`                                                                                                             | [OpenAI bots][openai-bots]                     |
| 145d | Anthropic  | `Claude-SearchBot`                                | `Claude-User`                                                               | `ClaudeBot`                                                                                                          | [Anthropic crawlers][anthropic-bots]           |
| 145e | Perplexity | `PerplexityBot` (stated: not for training)        | `Perplexity-User`. It "generally ignores robots.txt rules"                  | None stated                                                                                                          | [Perplexity bots][perplexity-bots]             |
| 145f | Apple      | `Applebot` (Siri, Spotlight, Safari)              | Not documented                                                              | `Applebot-Extended`: a token that does not crawl                                                                     | [Apple][apple-bots]                            |
| 145g | Meta       | `Meta-WebIndexer`                                 | `Meta-ExternalFetcher`. It "may bypass robots.txt rules"                    | `Meta-ExternalAgent` (training and indexing)                                                                         | [Meta crawlers][meta-bots]                     |
| 145h | Others     |                                                   |                                                                             | `CCBot`, `Bytespider`, `Amazonbot`: on the list of AI crawlers that Cloudflare blocks in its managed file            | [managed robots.txt][cf-managed-robots]        |

146. **Group for all crawlers.** `robots.txt` allows everything for `User-agent: *` and carries one Content Signals line: `Content-Signal: search=yes, ai-input=yes`. The line says nothing about `ai-train`, because the answer differs per content class. A missing signal "neither grants nor restricts" ([Content Signals][cf-signals]). Content Signals are a statement of preference: Cloudflare says that they are "not technical countermeasures" and that some companies may ignore them ([Content Signals][cf-signals]).
147. **Group for training crawlers.** One group names the training tokens of table 145 (`GPTBot`, `ClaudeBot`, `Google-Extended`, `Applebot-Extended`, `Meta-ExternalAgent`, `CCBot`, `Bytespider`, `Amazonbot`). It allows everything except the URL sets of the third-party classes (item 151). A crawler follows only the most specific group that names it, and groups are not merged with the `*` group ([robots.txt][g-robots]). So this group is complete in itself. The list of tokens is a data file with a date, reviewed at each release, because such lists age.
148. **Side effect at Google.** `Google-Extended` also covers grounding in the Gemini apps ([Google crawlers][g-crawlers]). A block of the third-party paths for that token therefore removes those pages from Gemini app answers too, which is "AI input". AI Overviews and AI Mode are not affected. Google states that it intends to support a shared training signal "in early 2027" ([Google crawlers][g-crawlers]). Until then, D33 cannot be expressed exactly at Google (item 188).
149. **Bing has no token.** The only way to refuse training at Microsoft is a robots meta value per page. `nocache` keeps the page in Copilot answers with URL, title and snippet only, and limits training to those three ([Bing chat controls][b-chat-controls]). It applies to pages, so it can cover quote and tab notes, but not a cover image (item 189).
150. **Response headers per class.** Every HTML and Markdown response carries a `Content-Signal` header that fits its class: `search=yes, ai-input=yes, ai-train=yes` for the author's own text, and `ai-train=no` for the third-party classes. The header matters for one more reason: without it, the Cloudflare Markdown feature adds `ai-train=yes` by itself ([Markdown for Agents][cf-md], hosting research 4.2). The IETF draft for the same purpose defines a `Content-Usage` header and a `robots.txt` rule with an optional path ([AIPREF attachment draft][aipref-attach], [AIPREF vocabulary draft][aipref-vocab]). Both drafts are still moving, and the vocabulary draft says that it has no working group consensus. So the generator keeps the signal vocabulary in one module, and the IETF form is added when it is stable.
151. **Third-party classes as URL sets.** D33 names quotes, cover images and music tabs. For the build:
     1. **Quote notes** of other people (not the author's own quotes), and generated lists whose main content is such quotes (row 93c).
     2. **Tab and arrangement notes** of works that are not in the public domain. The `public_domain` property of the work decides.
     3. **Cover images**: every file that a `cover` or `local_cover` property of a media or book note names. All public attachments share one vault folder (research 1.2), so the path alone cannot tell a cover from the author's own image. The hashed URL of rule U10 therefore carries a class segment, and the rules name that segment.
     4. A page that mixes the author's text with a few quotes stays in the own-text class.
     5. The `robots.txt` rules use the shortest set of path prefixes that covers exactly these notes, with `$` at the end of a single note URL. A build check fails when the file passes the size limit of item 42.
     6. If the hashed files live on a separate media host, that host needs its own `robots.txt` with the same rule.
152. **Enforcement and edge settings.** `robots.txt` is a request. For enforcement, the edge answers 403 to a verified training crawler on a URL of a third-party class. How that is built depends on D3: a rule on the crawler category and the path, or the edge function with the class map. Settings that must hold in Cloudflare:
     1. AI crawler policies: search and agent traffic are allowed ([AI crawler policies][cf-ai-policies]). The training policy is not set to "Disallow" for the zone, because that blocks training crawlers for the whole site.
     2. The managed `robots.txt` is off (item 44).
     3. Verified search and assistant bots are not challenged by bot rules ([verified bots][cf-verified]).
     4. AI Crawl Control shows which AI crawlers come and whether they follow `robots.txt`, on all plans ([AI Crawl Control][cf-ai-crawl]). It is the free monitor for this policy.
153. **Fetchers on request.** Several of them ignore `robots.txt` by design (table 145). That fits D33, which allows AI input for all content. No operator except Perplexity states in the sources read what happens to a fetched page afterwards. **[Inference]**: the policy for these fetchers rests on the statements of the operators, not on a technical control.

### E.3 `llms.txt`, Markdown and structured data

154. **`llms.txt` has no measured effect on citations.** Google Search ignores it ([AI optimization guide][g-ai-guide]). Two studies found no effect and almost no readers (rows 143f and 143g). John Mueller of Google said that AI systems "can't trust" a file in which a site describes itself, and saw a use only for an agent that is already on the site ([coverage][sej-mueller-llms]). **[Reported]** Chrome Lighthouse checks for the file in an experimental category for agents ([coverage][sej-llms-google]). The spec keeps the file for agent readiness (spec 9.16), and that is the right frame: a map for an agent, not a ranking signal. Requirement: a small generated index with the author, the policy, the hubs, the maps of content and the way to get Markdown. It links to canonical URLs only.
155. **No single full-text file.** One file for all notes would be 71 MB (spec 9.16). Full-text files per map of content (backlog 66) are a second-wave option. They never hold third-party classes (item 151), never hold the 675 copies, and they wait for D47, because a bulk file can hand out what a product sells.
156. **Markdown on request has no measured effect on citations either.** Google says that Markdown is not needed for Search ([AI optimization guide][g-ai-guide]), and Mueller called separate Markdown pages for bots "a stupid idea" ([coverage][sej-llms-google]). **[Reported]** Cloudflare reports that coding agents such as Claude Code and OpenCode ask for `text/markdown`, and that Markdown cut the tokens of one page by 80 percent ([Markdown for Agents][cf-md]). **[Vendor]** The site builds a Markdown twin for readers anyway (stories 15 and 16), so the cost is low. Requirements that keep it safe:
     1. The twin holds the same content as the page. Both come from the one cleaned artifact (spec 3.3.4). Different content for crawlers would be cloaking.
     2. The format follows the `Accept` header or the twin URL, never the user agent.
     3. The twin starts with a header block: title, canonical URL, author, created and updated dates, type, license, and the content class.
     4. The twin is `noindex` (item 23).
157. **Structured data and AI answers.** Google: "Structured data isn't required for generative AI search", and it must match the visible text ([AI optimization guide][g-ai-guide]). Microsoft: schema helps machines to read a page ([Microsoft guidance][ms-ai-answers]). The one controlled study found no gain in citations (row 143e). Position: the markup of item 74 is built for search features and for a clear author entity. No requirement expects more citations from it.

### E.4 Content patterns that the templates can give without new writing

158. **Definition line.** When the `description` property is filled, the page shows it as the first paragraph under the title, as a plain sentence. 2,635 notes have one today (research 1.4). This puts a definition in the first lines of the page, which operator guidance and row 143d point to. A note without the property gets no invented definition. The publication report lists such notes, sorted by their search impressions, so that the author can add a description where it pays.
159. **Key facts box.** Media, book, person and music notes show their main properties as a visible list of name and value pairs (`<dl>`) in the page header: for a board game the players, the playing time, the weight, the designers, then the author's rating and ownership. The closed properties panel (spec 9.3.1) keeps the rest. Microsoft warns that content inside closed elements can be skipped ([Microsoft guidance][ms-ai-answers]), and the markup rule of item 73 needs visible values.
160. **Author and dates on every note.** One line near the title: the author name as a link to the author page, the created date and the updated date, each in a `<time datetime>` element (story 19). The updated date is the date of the last significant update (spec 6.7.3) and equals `dateModified` in the markup and `lastmod` in the sitemap. Google "strongly encourages" bylines ([helpful content][g-helpful]).
161. **"Cite this note" block.** At the end of each note: the title, the author, the two dates, the canonical URL, the license (D29), and one ready citation line. For a copy (item 100) the block names the main-site URL. An agent or a person who quotes the note gets the right URL and name without a guess.
162. **Stable anchors.** Each heading has a stable id and a visible link (story 30, rule U8), so that an answer can point to a section.
163. **Tables and lists stay tables and lists.** Markdown tables render as `<table>` with header cells, lists as lists, the key facts as a description list. The 2,772 notes with tables (research 1.4) keep their structure in HTML and in the Markdown twin. Microsoft names lists and tables as the forms that assistants reuse ([Microsoft guidance][ms-ai-answers]).
164. **Everything in static HTML.** The full text of a note, its key facts, its dates and its backlinks are in the HTML that the server sends (spec 3.1.1). A build check extracts the text from the HTML without running scripts and compares it with the cleaned note. Google notes that browser agents read the page structure and the accessibility tree, and it advises semantic HTML ([AI optimization guide][g-ai-guide]).
165. **What a template cannot do.** Headings in the form of a question, sections that can stand alone, and facts with a source are properties of the author's text. No template rewrites notes. Google says that no rewriting for AI is needed ([AI optimization guide][g-ai-guide]). The site gives the author a report only: notes with many impressions and no description, long notes without headings.
166. **Original data.** The data that only this site has is shown as text and tables: the author's ratings and statuses, the stats page, the lists of item 93. Google and Microsoft both point to original content and evidence ([succeeding in AI search][g-ai-blog], [Bing AI Performance][b-ai-perf]).

### E.5 Entity and freshness

167. **One author across three hosts.** On the notes host: one name string, one `Person` id, one author page with `ProfilePage` markup and `sameAs` links to the main site, the store, the newsletter and the public profiles (item 70), the author line on each note (item 160), and links to the two other hosts in the frame of each page (item 60). The author page links to the profiles with `rel="me"`. The main site and the store are outside this project (ADR 0001). The id string and the `sameAs` list are written down so that they can adopt them.
168. **Freshness without tricks.** Dates change only with a significant update (spec 6.7). Each publication sends the changed, new and removed URLs through IndexNow (spec 9.13.8), which Bing names as the way to keep AI answers current ([Bing AI Performance][b-ai-perf], [Bing sitemaps][b-sitemaps-ai]). No date is moved without a change of content: Google checks `lastmod` against the page ([sitemaps][g-sitemap]), and the freshness finding of row 143c is a correlation, not a rule.

### E.6 How to measure AI visibility

169. **Free sources.**

| Row  | Source                                            | Shows                                                                                                          | Limit                                                                                  |
| ---- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 169a | Search Console, generative AI performance reports | Impressions of each page in AI Overviews and AI Mode ([announcement][g-genai-report])                          | Impressions only, and the two features are not split                                   |
| 169b | Bing Webmaster Tools, AI Performance              | Citations per page in Copilot and Bing AI summaries, with grounding queries ([Bing AI Performance][b-ai-perf]) | Microsoft surfaces only. A citation is not a visit                                     |
| 169c | Plausible                                         | Visits that come from AI assistants, by referrer and by `utm_source` ([Plausible][plausible-ai])               | Visits from apps without a referrer are missing. Answers without a click are invisible |
| 169d | Edge logs or AI Crawl Control                     | Requests per AI user agent ([AI Crawl Control][cf-ai-crawl])                                                   | A user agent string can be false. Verified bots are the reliable part                  |

170. **Log classes.** The edge counts requests per day, per note type and per class of user agent: search index crawlers, fetchers on request, training crawlers. Requests of the fetchers (`ChatGPT-User`, `Claude-User`, `Perplexity-User`) are the nearest signal to "an assistant read this note for a person". The counters hold no personal data.
171. **A fixed set of questions.** A small script asks a fixed list of questions through the public APIs of the engines that offer search with citations, several times each, and records which URLs of the three hosts are cited. The list of questions and the results stay private. Answers vary from run to run, so only trends count.
172. **Paid trackers.** Otterly.AI, Peec AI, Profound, Ahrefs Brand Radar and the Semrush AI Visibility Toolkit ask sets of prompts on a schedule and report mentions and citations. Reported entry prices differ by source and by month and must be read on the vendor pages. **[Reported]** Google states that "no third-party tool has access to our internal ranking or AI systems" ([AI optimization guide][g-ai-guide]). For a business of one person: the four free sources and the script of item 171 come first. A paid tracker is worth it only when a decision depends on a comparison with competitors, and then the lowest tier of one tool is enough (item 194).
173. **What stays invisible.** An answer that uses a note without a link, and a reader who does not click, leave no trace in any of these sources. Google reports impressions, not use. No number here measures "share of AI answers".

## F. Requirement list for the spec

Priority: **G** needed at the domain switch, **M** first release, **S** second wave. "Spec" is the section of `spec-v1.md` that the requirement belongs to. A number in brackets is the item of this file that explains the requirement.

### F.1 Search engines

| Id      | P   | Spec     | Requirement                                                                                                                                                                             | Verification                                                                                       |
| ------- | --- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| SEO-001 | G   | 5.4 U13  | One URL function writes the canonical link, `og:url`, JSON-LD URLs, sitemap `<loc>`, internal links, feeds and IndexNow payloads [18]                                                   | Build test: the values are equal per page, and each answers 200 without a redirect                 |
| SEO-002 | G   | 9.13.1   | Every indexable page has exactly one absolute, self-referring canonical link without query or fragment [17]                                                                             | HTML check on all pages                                                                            |
| SEO-003 | G   | 5.4 U1   | `+` for spaces, `%2B` for a literal plus, percent-encoded non-ASCII. The build writes no `%20` in any URL [19]                                                                          | Search of the build output for `%20` in `href`, `loc` and `content` values                         |
| SEO-004 | G   | 5.4 U2   | The resolver reads `%2B` and `%20` as a space when the literal path finds no note [20]                                                                                                  | Resolver table test, with names that hold a real `+`                                               |
| SEO-005 | G   | 5.4 U4   | Redirect codes follow table 26                                                                                                                                                          | Resolver table test per row, and the same test against the preview host                            |
| SEO-006 | G   | 5.4 U2   | Every variant reaches a 200 page in one redirect. No target redirects [27]                                                                                                              | Test follows a sample of each variant kind and counts the hops                                     |
| SEO-007 | G   | 5.4 U12  | A URL with a query answers 200 with a clean canonical link and no redirect [21]                                                                                                         | Edge test with `?ref=x` and `?utm_source=chatgpt.com`                                              |
| SEO-008 | G   | 5.4 U9   | Unknown path 404, also under `/-/`. Unpublished note 410. Empty list or page number 404. No redirect to a hub [28, 30, 31]                                                              | Edge test with generated random paths and with an empty tag                                        |
| SEO-009 | G   | 11.3     | Each cut canonical target of the old site answers as item 125 says                                                                                                                      | Test over the generated list of item 118                                                           |
| SEO-010 | G   | 5.6      | HTML and Markdown answer 304 to a conditional request [32]                                                                                                                              | Edge test with `If-None-Match`                                                                     |
| SEO-011 | G   | 9.15.4   | Verified search crawlers get no 403, no 429 and no challenge [33]                                                                                                                       | Log alert on such answers for Googlebot and Bingbot. URL Inspection live test after the deployment |
| SEO-012 | G   | 9.13.1   | Title per template of item 12, unique among indexable pages [15]                                                                                                                        | Snapshot per type. Uniqueness test over the build                                                  |
| SEO-013 | G   | 9.13.1   | Description from the property, else generated per item 12. Unique, no empty slot, inside the length bound [9, 11]                                                                       | Snapshot per type. Uniqueness and pattern test                                                     |
| SEO-014 | G   | 9.4      | One `<h1>` that equals the main part of the title. Body headings move down when needed [61]                                                                                             | HTML check on all pages                                                                            |
| SEO-015 | G   | 9.1.5    | `<html lang>` from the language of the note [50]                                                                                                                                        | HTML check, fixture with a French note                                                             |
| SEO-016 | G   | 9.13.1   | Open Graph and Twitter tags per item 16                                                                                                                                                 | HTML check                                                                                         |
| SEO-017 | G   | 9.13.4   | Sitemap index at `/sitemap.xml` and one file per row of table 35, at the root, escaped, under the limits [35, 39]                                                                       | XML schema validation and a count check                                                            |
| SEO-018 | G   | 9.13.4   | Sitemaps hold only canonical, indexable, 200 URLs. No copy, twin, redirect or `noindex` page [36]                                                                                       | Set comparison of the sitemap URLs with the page index of the build                                |
| SEO-019 | G   | 6.7      | `lastmod` is the date of the last significant update, with a time zone, never the build time. No `priority`, no `changefreq` [37, 38]                                                   | Two builds without a content change give byte-equal sitemaps                                       |
| SEO-020 | G   | 5.4 U6   | A note or alias cannot take a reserved root name of item 41                                                                                                                             | Publish-core test with a fixture note that is named like a route                                   |
| SEO-021 | G   | 9.16     | `robots.txt` is generated, answers 200, stays under 500 KiB and names the sitemap index [34, 42]                                                                                        | Parser test, size check, edge test                                                                 |
| SEO-022 | G   | 9.15.2   | The live `robots.txt` equals the build output. The Cloudflare managed file is off [44]                                                                                                  | Byte comparison after each deployment                                                              |
| SEO-023 | G   | 11.2.9   | Preview host: `X-Robots-Tag: noindex` on every response. Production: none on indexable pages                                                                                            | Edge test on both hosts after each deployment                                                      |
| SEO-024 | G   | 9.13.7   | Article and newsletter copies: canonical link and `og:url` to the verified main-site URL from the `url` property, a visible "first published" line, out of sitemaps and feeds [22, 100] | Build test per copy. Scheduled check that each target answers 200 and names itself as canonical    |
| SEO-025 | G   | 9.13.7   | A copy without a verified target is `noindex` and is listed in the publication report [101]                                                                                             | Fixture with a copy that has no `url`                                                              |
| SEO-026 | G   | 9.14.3   | Every `<img>` has `width`, `height`, `alt` and `src` [66]                                                                                                                               | HTML check                                                                                         |
| SEO-027 | G   | 9.14.1   | The laboratory budgets per note type pass [69]                                                                                                                                          | Lighthouse run in CI on a sample of each type                                                      |
| SEO-028 | G   | 11.2     | The Search Console and Bing verifications survive the switch [115, 116]                                                                                                                 | Item of the switch gate. Edge test for the verification files                                      |
| SEO-029 | G   | 9.13.8   | IndexNow: key file at the root, full submission at the switch in the order of item 95, then changed, new and removed URLs at each publication [121, 123, 168]                           | Unit test of the payload builder. The publication report records the answer code                   |
| SEO-030 | G   | 11.1     | The baseline of item 117 exists before the switch, outside this repository                                                                                                              | Item of the switch gate                                                                            |
| SEO-031 | G   | 9.4.4    | Every indexable note is reachable from the home page through `<a href>` links in at most four steps [59]                                                                                | Link walk over the build                                                                           |
| SEO-032 | M   | 9.13.3   | JSON-LD graph per table 74, with the entities of items 70 to 72                                                                                                                         | Schema test and snapshot per type. Record of the Rich Results Test per release                     |
| SEO-033 | M   | 9.13.3   | Each value in the markup is visible on the page [73]                                                                                                                                    | Build test: every text value of the graph occurs in the page text                                  |
| SEO-034 | M   | 9.13.3   | A `Review` only with a `rating`, with the scale stated. No `aggregateRating` from `online_rating` [75, 76]                                                                              | Fixtures with and without a rating                                                                 |
| SEO-035 | M   | 7        | The markup of person notes holds allowed properties only                                                                                                                                | Privacy gate test on the JSON-LD output                                                            |
| SEO-036 | M   | 9.4.2    | Visible breadcrumb and `BreadcrumbList` through the type hub [55]                                                                                                                       | HTML and schema check                                                                              |
| SEO-037 | M   | 9.4.2    | "Part of", backlinks and related notes use the elements of items 54, 56 and 57. Backlink excerpts carry `data-nosnippet`                                                                | HTML check                                                                                         |
| SEO-038 | M   | 8.1 (31) | `hreflang` pairs are complete and reciprocal, with `x-default` [51, 52]                                                                                                                 | Pair symmetry test in the publish core and in the build                                            |
| SEO-039 | M   | 9.7      | Paginated lists: page number in the path, self canonical, numbered links [24, 45]                                                                                                       | HTML check on a hub with many pages                                                                |
| SEO-040 | M   | 9.13.6   | The robots value of each kind of generated page follows table 46. An unknown kind is `noindex` [48]                                                                                     | Test: each generated route has a declared rule                                                     |
| SEO-041 | M   | 9.6      | No `<a href>` with a query string to a generated page. Filter state lives in the fragment [47]                                                                                          | Search of the build output                                                                         |
| SEO-042 | M   | 9.13.6   | Growth guard for indexable generated pages [49]                                                                                                                                         | The build fails above the set share or step                                                        |
| SEO-043 | M   | 9.1.6    | Thin types render per table 88. No empty section. Stubs are counted [90]                                                                                                                | Snapshot per thin type, with a full fixture and a stub fixture                                     |
| SEO-044 | M   | 9.14.3   | Cover alt text from properties. Other images per item 64                                                                                                                                | HTML check. Warning list in the publication report                                                 |
| SEO-045 | M   | 5.4 U10  | Hashed image URLs keep the readable name and carry a class segment [65, 151]                                                                                                            | URL pattern test                                                                                   |
| SEO-046 | M   | 9.13.1   | `max-image-preview:large` on indexable pages [67]                                                                                                                                       | HTML check                                                                                         |
| SEO-047 | M   | 5.4 U11  | Markdown twin: `X-Robots-Tag: noindex`, canonical `Link` header, never in a sitemap. The page links to it as an alternate [23]                                                          | Edge test                                                                                          |
| SEO-048 | M   | 9.13.3   | Author page with `ProfilePage`. `WebSite` on the home page only [70, 74]                                                                                                                | Schema check                                                                                       |
| SEO-049 | M   | 9.13     | AI-written notes: visible line, `digitalSourceType`, no human `author` [104]                                                                                                            | Fixture with `ai_generated: true`                                                                  |
| SEO-050 | M   | 9.13     | Reports: near-duplicate notes [105], overlap of documentation with the store [102]                                                                                                      | CLI check with fixtures                                                                            |
| SEO-051 | M   | 9.9      | Counters per note type for Googlebot and Bingbot requests, and recrawl coverage [97, 129]                                                                                               | Check of the log pipeline with a replayed sample                                                   |
| SEO-052 | S   | 9.13.6   | Curated lists from the registry, with the rules of item 94                                                                                                                              | Registry check: intro present, minimum items, overlap limit, cap                                   |
| SEO-053 | S   | 9.13.3   | `sameAs` and `identifier` per table 78                                                                                                                                                  | Schema snapshot                                                                                    |
| SEO-054 | S   | 9.1.6    | Person notes get the generated summary of row 88f                                                                                                                                       | Snapshot                                                                                           |
| SEO-055 | S   | 9.13.4   | Image sitemap for the author's own images only [40]                                                                                                                                     | Set check: no cover URL in it                                                                      |

### F.2 AI search and agents

| Id      | P   | Spec    | Requirement                                                                                                    | Verification                                                                    |
| ------- | --- | ------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| AIS-001 | G   | 9.16    | `robots.txt` allows search index crawlers and fetchers on request on all URLs [145, 146]                       | Matrix test: each token of table 145 against a sample URL of each content class |
| AIS-002 | G   | 9.16    | The training group blocks exactly the third-party URL sets [147, 151]                                          | The same matrix test, and a set comparison with the manifest                    |
| AIS-003 | G   | 9.15.4  | Cloudflare AI crawler policies allow search and agent traffic. No zone-wide training block [152]               | Check of the settings after each change. Review of AI Crawl Control             |
| AIS-004 | G   | 3.1     | Note text, key facts, dates and backlinks are in the static HTML [164]                                         | Build test: text extracted without scripts covers the cleaned note              |
| AIS-005 | G   | 9.9     | Analytics parameters of AI engines survive the request [21]                                                    | As SEO-007                                                                      |
| AIS-006 | M   | 9.16    | `Content-Signal` response header per content class, on HTML and Markdown [150]                                 | Edge test per class                                                             |
| AIS-007 | M   | 9.16    | `Content-Signal` line in `robots.txt`, without `ai-train` [146]                                                | Parser test                                                                     |
| AIS-008 | M   | 9.15.4  | The edge answers 403 to verified training crawlers on third-party URLs [152]                                   | Edge test, built per hosting option (D3)                                        |
| AIS-009 | M   | 5.4 U10 | A separate media host has its own `robots.txt` with the training rule [151]                                    | Edge test                                                                       |
| AIS-010 | M   | 9.16    | Bing `nocache` on quote and tab notes, if item 189 is accepted [149]                                           | HTML check per class                                                            |
| AIS-011 | M   | 9.4.2   | Definition line from `description` under the title [158]                                                       | Snapshot                                                                        |
| AIS-012 | M   | 9.3.3   | Visible key facts box per type [159]                                                                           | Snapshot per type                                                               |
| AIS-013 | M   | 9.4.2   | Author line and dates in `<time>`. The updated date equals `dateModified` and `lastmod` [160]                  | Build test that compares the three values                                       |
| AIS-014 | M   | 9.4.2   | "Cite this note" block [161]                                                                                   | Snapshot. A copy fixture names the main-site URL                                |
| AIS-015 | M   | 5.4 U8  | Heading ids are stable between builds [162]                                                                    | Two builds, comparison of the ids                                               |
| AIS-016 | M   | 9.2.1   | Tables and lists keep their structure in HTML and in Markdown [163]                                            | Markdown snapshot tests                                                         |
| AIS-017 | M   | 9.16    | Markdown twin: same content as the page, header block, format by `Accept` or by URL, never by user agent [156] | Build test that compares the text. Edge test with two user agents               |
| AIS-018 | M   | 9.16    | `llms.txt`: a small generated index with canonical links [154]                                                 | Link check and size cap                                                         |
| AIS-019 | M   | 9.13.3  | One author name, one `Person` id, one `sameAs` list, and links to the two other hosts on every page [167]      | Build test over all pages                                                       |
| AIS-020 | M   | 9.9     | Counters per class of AI user agent and per note type [170]                                                    | Check of the log pipeline                                                       |
| AIS-021 | M   | 11.3    | The Search Console setting for generative AI features is on. The sources of table 169 are reviewed [138]       | Item of the switch gate, then a recurring check                                 |
| AIS-022 | M   | 9.13    | Report for the author: notes with impressions and no description [158, 165]                                    | CLI check                                                                       |
| AIS-023 | S   | 9.16    | Full-text files per map of content, without third-party classes and without copies, after D47 [155]            | Set check                                                                       |
| AIS-024 | S   | 9.9     | Script with the fixed set of questions. Results are stored privately [171]                                     | Unit test with recorded answers                                                 |
| AIS-025 | S   | 9.16    | The IETF usage preference syntax is added when it is stable [150]                                              | Parser test                                                                     |
| AIS-026 | S   | 9.14.10 | Landmarks and labels give browser agents a clear accessibility tree [164]                                      | Accessibility check of spec 10.8                                                |

## G. Decisions for the author

Each decision is worded so that "yes" accepts the recommendation.

174. **Redirect codes.** Accept table 26: 301 for every pure syntax variant and for a bare file name (with a short cache lifetime), 302 for aliases only? **Recommended: yes.** A 301 tells Google that the target is the canonical URL, a 302 does not ([redirects][g-redirects]). File names are unique and collisions are blocked, so the permanent signal is safe. This changes rule U4 for letter case and file names.
175. **Query strings.** A URL with a query answers 200 with a clean canonical link, and never redirects? **Recommended: yes.** A redirect would remove `utm_source=chatgpt.com` and `?ref=` before the analytics script runs (item 21). This changes rule U2.
176. **Cut canonical targets.** They answer 404, and a single-note target gets a 301 only when the baseline shows that it is indexed (item 125)? **Recommended: yes.** A 404 is the honest answer for a URL that was never a page, and it clears the index.
177. **One-time `lastmod`.** The sitemaps carry the switch date as `lastmod` for every note, one time, while the visible dates and the feeds stay untouched (item 124)? **Recommended: yes.** Every page changes its links and its structured data on that day, and Google counts that as significant. It is the one honest way to ask for a recrawl of everything.
178. **Sitemaps at the switch.** All sitemap files are live at the switch, and "stages" means the order of submission and of IndexNow batches (item 95)? **Recommended: yes.** The URLs are known already. Holding a file back delays the repair and protects nothing.
179. **Index rules for generated pages.** Accept table 46, with a threshold of five notes for an indexable tag page? **Recommended: yes.** It keeps real topic pages and drops pages with one or two links. The number five is a starting value without a source.
180. **Stub notes.** A media note with the default status, no rating and no own text stays indexed, shows no ad, stays out of curated lists, and is counted in the publication report (items 90 and 91)? **Recommended: yes.** It respects ADR 0004 and gives the author the list for the per-note override.
181. **Curated lists.** Indexable list pages exist only through the registry of item 92, under the rules of item 94, with the families of item 93 as the first set? **Recommended: yes.** It gives the thin types a strong page each and makes an index explosion impossible.
182. **Copies without a verified target.** An article or newsletter copy whose main-site URL is missing or dead is `noindex` until it is verified (item 101)? **Recommended: yes.** Without a target it is a plain duplicate of a post on the main site. ADR 0004 allows the per-note override.
183. **Titles.** Accept the templates of item 12, with the type word for media, and keep the current site name string in titles at the switch? **Recommended: yes.** A change of brand name in every title on the day of the repair would mix two effects in the data. The name can change later in one step.
184. **Breadcrumb.** The breadcrumb follows the type hub, not the folder path (item 55)? **Recommended: yes.** Google asks for a user path, and the folder numbers mean nothing to a reader.
185. **Ratings in markup.** The author's rating becomes a `Review`, and scores from other databases never become markup (items 75 and 76)? **Recommended: yes.** The rating is the author's own data. A copied score in markup risks a manual action.
186. **Image sitemap.** No image sitemap for cover images (item 40)? **Recommended: yes.** It matches the first recommendation of D47, and crawlers find the images without it.
187. **Media notes and the training rule.** Media notes count as the author's own text for the training rule, and only their cover images are in the third-party class (item 151)? **Recommended: yes**, on one condition: the `description` of media notes is the author's text or a short factual line. If it holds a synopsis copied from a database, the author must say so, and the class changes.
188. **Google and D33.** Accept that the block for `Google-Extended` on third-party paths also removes those pages from answers in the Gemini apps, until Google supports a separate training signal (item 148)? **Recommended: yes.** Search, AI Overviews and AI Mode are not affected. The other choice is to allow Gemini training on quotes and tabs.
189. **Bing and D33.** Quote notes and tab notes carry `nocache` for Bing, so that Copilot shows them with URL, title and snippet only, and Microsoft training is limited to those (item 149)? **Recommended: yes.** It is the only control that Microsoft offers. The cost is a shorter use of these pages in Copilot answers.
190. **AI-written articles.** They carry the visible line and the markup of item 104, and they stay indexed? **Recommended: yes.** Disclosure is what Google asks for, and their own sitemap file shows early if they are a problem.
191. **`llms.txt`.** A small index at the first release, no full-text file until D47 is decided (items 154 and 155)? **Recommended: yes.** No engine uses the file for citations, and a bulk file touches the question of paid products.
192. **Author entity.** The notes host gets one author page with `ProfilePage` markup. Its URL is the `author.url` of every note, and its `sameAs` list names the main site and the store (items 70 and 167)? **Recommended: yes.** It is the only form that this project controls alone. The main site and the store can link back in their own projects.
193. **Person notes in markup.** A person note may carry `sameAs` links to the Wikipedia page and the official site of that person (row 78g)? **Recommended: yes**, as part of D40. Both are public by the person's own choice, and they tell people with the same name apart.
194. **Paid tracker for AI visibility.** None for now: the free sources of table 169 and the script of item 171 first? **Recommended: yes.** The paid tools sample prompts and cannot see inside the engines (item 172).
195. **Success metric.** The one metric of spec 9.13.8 is "clicks from search to the own-text note types", with the thin types watched apart (item 98)? **Recommended: yes.** It measures the part of the site that carries the business, and it is not moved by the index state of 14,000 catalog pages.
196. **End of the rollback window.** The conditions of item 134 are the proposal that the author decides on? **Recommended: yes.** They tie the cancellation of Obsidian Publish to evidence that the repair worked.

## H. Uncertain or contested

197. **Do thin pages hurt the rest of the host?** For: Google uses site-wide signals ([ranking systems][g-ranking]), it says that many pages do not make a site better ([AI optimization guide][g-ai-guide]), and crawl demand follows quality ([crawl budget][g-crawl-budget]). Against: Google says that its systems work "on the page level" and that weak site-wide signals do not sink every page ([ranking systems][g-ranking]), and the catalog is first-hand data, not text made for ranking. No source measures the effect for a site of this shape. Two reviews of the spec advised `noindex` (ADR 0004). The monitoring of items 96 to 99 is the answer of this file.
198. **Does a staged release of sitemaps help?** For: it is common advice for new sites, and spec 9.13.8 has it. Against: a sitemap is a hint ([sitemaps][g-sitemap]), the URLs are already known, and Google documents no benefit of holding files back. **[Inference]** The proposal of item 95 follows the second view.
199. **301 or 302 for bare file names.** For 302 (rule U4): a name can move to another note, and browsers keep a 301. For 301 (item 26): Google reads only a permanent redirect as a canonical signal ([redirects][g-redirects]), names are unique, and a cache lifetime limits the browser problem. Google also says that the target of a 302 can still be indexed when other signals agree ([redirects][g-redirects]), so a 302 is not a disaster.
200. **The `+` in URLs.** Google recommends hyphens ([URL structure][g-url]) and says nothing about `+` in a path. By the standard, `+` in a path is a plain character ([RFC 3986][rfc3986]). The risk is in clients that rewrite it (item 20), and it is not measured. ADR 0005 keeps the form. The resolver and the tests carry the risk.
201. **Will Google follow the canonical link from a copy to the main site?** It is a hint. Google chooses "for various reasons" ([canonicalization][g-canon-what]). The frame of the two pages differs, and the main text is the same, so the hint is likely to hold. **[Inference]** The check: URL Inspection on a sample of copies after the switch.
202. **`noindex` together with a canonical link on Markdown twins.** Rule U11 sets both. Google warns against `noindex` as a tool to choose a canonical URL inside a site ([canonical methods][g-canon]). Here the aim is different: the twin must never show in results. If a problem shows, the canonical header is the one to drop. **[Inference]**
203. **The one-time `lastmod`.** For: the pages do change in links and structured data ([sitemaps][g-sitemap]). Against: the visible "updated" date does not move, so the two dates differ on that day, and Bing may ignore dates that look like a bulk stamp ([Bing lastmod][b-lastmod]). The cost of being ignored is small. The proposal stays (item 177).
204. **`llms.txt`.** For: agent tools and Lighthouse look for it ([coverage][sej-llms-google]), and coding agents fetch it ([Ahrefs][ahrefs-llms]). Against: Google ignores it ([AI optimization guide][g-ai-guide]), and two studies found no effect and almost no readers (rows 143f and 143g). Position: keep it small and cheap.
205. **Markdown for agents.** For: fewer tokens for agents that ask for it ([Markdown for Agents][cf-md], **[Vendor]**). Against: Google sees no need, and Mueller rejects separate Markdown pages for bots ([coverage][sej-llms-google]). No study measures an effect on citations. Position: keep it, because readers get the same file.
206. **Structured data and AI answers.** For: Microsoft says that schema helps machines ([Microsoft guidance][ms-ai-answers]). Against: Google says that it is not required ([AI optimization guide][g-ai-guide]), and the one controlled study found no gain (row 143e). Position: build it for search features and the author entity.
207. **Does a good rank bring AI citations?** One team measured 76 percent of AI Overview citations from the top 10 in 2025 and 38 percent in 2026, with a changed method (row 143b). So the link between rank and citation is real but weaker than first reported, and the fan-out of questions is the likely cause ([Ahrefs][ahrefs-top10]). **[Inference]** by the authors of the study.
208. **Which index ChatGPT uses.** OpenAI names Bing ([OpenAI publisher FAQ][openai-faq]). Tests point to Google results as well. **[Reported]** Position: both must be in order.
209. **Do crawlers obey the signals?** `robots.txt` and Content Signals are requests ([Content Signals][cf-signals]). Fetchers on request ignore `robots.txt` by design (table 145). The IETF drafts are not final ([AIPREF vocabulary draft][aipref-vocab]). Only the block at the edge is a control, and only for crawlers that identify themselves.
210. **Freshness.** AI assistants cite newer pages on average, but AI Overviews do not, and the average cited page is years old (row 143c). A garden with honest dates and old notes loses little. Date tricks are not worth the risk.
211. **Review snippets for one person's ratings.** The markup is valid, and Google lists the types ([review snippet][g-sd-review]). Whether Google shows stars for a personal site is not known. Rich results are never promised ([structured data policies][g-sd-policies]).
212. **`Quotation`, `DefinedTerm`, `Game`, `SheetMusic`.** They are correct schema.org types ([Quotation][schema-quotation], [DefinedTerm][schema-definedterm], [Game][schema-game], [SheetMusic][schema-sheetmusic]). No search engine documents a feature for them. Their value is a clear, typed page for any reader of the markup. **[Inference]**
213. **Content patterns.** "Definition first", "question headings" and "self-contained sections" rest on operator guidance without data ([Microsoft guidance][ms-ai-answers]) and on one study of one engine (row 143d). Google says that no special writing is needed ([AI optimization guide][g-ai-guide]). The template features of items 158 to 164 are cheap and also help human readers, so they stay.
214. **404 or 410 for unpublished notes.** Rule U9 uses 410. Google treats both the same ([status codes][g-status]). No change is needed.
215. **The tools that track AI visibility.** They ask sample prompts, and answers differ per run, per user and per place. Their numbers are estimates of a sample (item 172).
216. **Brave and Claude.** The link between Claude search and the Brave index rests on a subprocessor list and one test ([Willison][willison-brave]). It can change without notice.

## Sources

All read on 2026-11-17.

Google:

[g-ai-features]: https://developers.google.com/search/docs/appearance/ai-features
[g-ai-guide]: https://developers.google.com/search/docs/fundamentals/ai-optimization-guide
[g-ai-blog]: https://developers.google.com/search/blog/2025/05/succeeding-in-ai-search
[g-genai-report]: https://developers.google.com/search/blog/2026/06/gen-ai-performance-reports
[g-genai-content]: https://developers.google.com/search/docs/fundamentals/using-gen-ai-content
[g-helpful]: https://developers.google.com/search/docs/fundamentals/creating-helpful-content
[g-ranking]: https://developers.google.com/search/docs/appearance/ranking-systems-guide
[g-spam]: https://developers.google.com/search/docs/essentials/spam-policies
[g-canon]: https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls
[g-canon-what]: https://developers.google.com/search/docs/crawling-indexing/canonicalization
[g-redirects]: https://developers.google.com/search/docs/crawling-indexing/301-redirects
[g-status]: https://developers.google.com/search/docs/crawling-indexing/http-network-errors
[g-sitemap]: https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap
[g-img-sitemap]: https://developers.google.com/search/docs/crawling-indexing/sitemaps/image-sitemaps
[g-robots]: https://developers.google.com/search/docs/crawling-indexing/robots/robots_txt
[g-robots-meta]: https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag
[g-crawl-budget]: https://developers.google.com/search/docs/crawling-indexing/large-site-managing-crawl-budget
[g-facets]: https://developers.google.com/search/docs/crawling-indexing/crawling-managing-faceted-navigation
[g-pagination]: https://developers.google.com/search/docs/specialty/ecommerce/pagination-and-incremental-page-loading
[g-hreflang]: https://developers.google.com/search/docs/specialty/international/localized-versions
[g-url]: https://developers.google.com/search/docs/crawling-indexing/url-structure
[g-title]: https://developers.google.com/search/docs/appearance/title-link
[g-snippet]: https://developers.google.com/search/docs/appearance/snippet
[g-images]: https://developers.google.com/search/docs/appearance/google-images
[g-sitename]: https://developers.google.com/search/docs/appearance/site-names
[g-sd-gallery]: https://developers.google.com/search/docs/appearance/structured-data/search-gallery
[g-sd-policies]: https://developers.google.com/search/docs/appearance/structured-data/sd-policies
[g-sd-article]: https://developers.google.com/search/docs/appearance/structured-data/article
[g-sd-breadcrumb]: https://developers.google.com/search/docs/appearance/structured-data/breadcrumb
[g-sd-profile]: https://developers.google.com/search/docs/appearance/structured-data/profile-page
[g-sd-movie]: https://developers.google.com/search/docs/appearance/structured-data/movie
[g-sd-review]: https://developers.google.com/search/docs/appearance/structured-data/review-snippet
[g-searchbox]: https://developers.google.com/search/blog/2024/10/sitelinks-search-box
[g-move]: https://developers.google.com/search/docs/crawling-indexing/site-move-no-url-changes
[g-coa]: https://support.google.com/webmasters/answer/9370220
[g-index-report]: https://support.google.com/webmasters/answer/7440203
[g-crawlers]: https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers
[g-fetchers]: https://developers.google.com/search/docs/crawling-indexing/google-user-triggered-fetchers
[webdev-vitals]: https://web.dev/articles/vitals

Microsoft and IndexNow:

[b-ai-perf]: https://blogs.bing.com/webmaster/February-2026/Introducing-AI-Performance-in-Bing-Webmaster-Tools-Public-Preview
[b-dup]: https://blogs.bing.com/webmaster/December-2025/Does-Duplicate-Content-Hurt-SEO-and-AI-Search-Visibility
[b-lastmod]: https://blogs.bing.com/webmaster/february-2023/The-Importance-of-Setting-the-lastmod-Tag-in-Your-Sitemap
[b-sitemaps-ai]: https://blogs.bing.com/webmaster/July-2025/Keeping-Content-Discoverable-with-Sitemaps-in-AI-Powered-Search
[b-chat-controls]: https://blogs.bing.com/webmaster/september-2023/Announcing-new-options-for-webmasters-to-control-usage-of-their-content-in-Bing-Chat
[ms-ai-answers]: https://about.ads.microsoft.com/en/blog/post/october-2025/optimizing-your-content-for-inclusion-in-ai-search-answers
[indexnow-doc]: https://www.indexnow.org/documentation
[indexnow-faq]: https://www.indexnow.org/faq

AI operators:

[openai-bots]: https://developers.openai.com/api/docs/bots
[openai-faq]: https://help.openai.com/en/articles/12627856-publishers-and-developers-faq
[anthropic-bots]: https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler
[anthropic-search]: https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
[perplexity-bots]: https://docs.perplexity.ai/guides/bots
[apple-bots]: https://support.apple.com/en-us/119829
[meta-bots]: https://developers.facebook.com/docs/sharing/webmasters/web-crawlers/
[willison-brave]: https://simonwillison.net/2025/Mar/21/anthropic-use-brave/

Cloudflare and standards:

[cf-signals]: https://blog.cloudflare.com/content-signals-policy/
[cf-managed-robots]: https://developers.cloudflare.com/bots/additional-configurations/managed-robots-txt/
[cf-ai-policies]: https://developers.cloudflare.com/bots/additional-configurations/block-ai-bots/
[cf-ai-crawl]: https://developers.cloudflare.com/ai-crawl-control/
[cf-verified]: https://developers.cloudflare.com/bots/concepts/bot/verified-bots/
[cf-md]: https://blog.cloudflare.com/markdown-for-agents/
[aipref-attach]: https://www.ietf.org/archive/id/draft-ietf-aipref-attach-05.html
[aipref-vocab]: https://www.ietf.org/ietf-ftp/internet-drafts/draft-ietf-aipref-vocab-08.html
[rfc3986]: https://www.rfc-editor.org/rfc/rfc3986
[sitemaps-protocol]: https://www.sitemaps.org/protocol.html
[schema-quotation]: https://schema.org/Quotation
[schema-definedterm]: https://schema.org/DefinedTerm
[schema-game]: https://schema.org/Game
[schema-sheetmusic]: https://schema.org/SheetMusic
[schema-dst]: https://schema.org/digitalSourceType
[schema-iptc]: https://schema.org/IPTCDigitalSourceEnumeration

Studies and coverage:

[geo-paper]: https://arxiv.org/abs/2311.09735
[ahrefs-top10]: https://ahrefs.com/blog/ai-overview-citations-top-10
[ahrefs-fresh]: https://ahrefs.com/blog/do-ai-assistants-prefer-to-cite-fresh-content/
[ahrefs-schema]: https://ahrefs.com/blog/schema-ai-citations/
[ahrefs-llms]: https://ahrefs.com/blog/llmstxt-study/
[seranking-llms]: https://seranking.com/blog/llms-txt/
[sej-llms-300k]: https://www.searchenginejournal.com/llms-txt-shows-no-clear-effect-on-ai-citations-based-on-300k-domains/561542/
[sej-llms-google]: https://www.searchenginejournal.com/googles-llms-txt-guidance-depends-on-which-product-you-ask/575431/
[sej-mueller-llms]: https://www.searchenginejournal.com/googles-mueller-says-llms-txt-cant-help-llms-differentiate-sites/579304/
[sel-indig]: https://searchengineland.com/chatgpt-citations-content-study-469483
[plausible-ai]: https://plausible.io/blog/ai-referral-traffic-and-optimization

Notes on the sources:

- The OpenAI publisher FAQ refused a direct fetch. Its statements were read through search result excerpts of the same page. The wording can differ on the live page.
- The Bing Webmaster Guidelines page did not load as text. The Bing statements here come from the Bing Webmaster blog.
- The Indig study (row 143d) was read through press coverage, not in the original.
- The SE Ranking page was not opened. Its findings were read through the coverage that the row links to.
