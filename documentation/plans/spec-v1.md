# Spec v1: one website for notes, blog and store

- **Status**: draft v1. First take, written before the interview with the author. Nothing here is approved.
- **Reviews**: one coverage review, two adversarial reviews and one ideation pass were run on the first draft. Their findings are integrated. Section 19 records what changed.
- **Next**: an interview (grilling) settles the open decisions of section 13, round by round. The answers are in `documentation/plans/decisions.md`. The result is spec v2.
- **Scope change after round 1**: the author keeps the main site and the store out of this project. This spec stays as written. Read it together with the decision log.
- **Facts**: all measurements are in `documentation/research/2026-11-17-current-state.md`. This spec refers to it as "the research".
- **Ideas**: `documentation/plans/ideas-backlog.md` holds 232 ideas that are not part of the plan.
- **Rule**: no timing information in this plan.

## 0. What the decision log changes in this spec

This spec is the first take and stays as written. The author answered three interview rounds and part of a fourth. Where this spec and `decisions.md` differ, the decision log wins. The main changes:

1. **Scope**: the notes website and its publishing tool only. The blog and store sections (2, 5.2, 8, 11.4, round 4 of section 13) are out. The subdomains stay as they are (ADR 0001).
2. **No bridge**: route 1 of section 6.5 is rejected. The own publishing tool is a condition of the switch (ADR 0003). Kill criterion 4 of section 15.3 no longer has its fallback.
3. **Indexing**: every note is indexed. Section 9.13.5 and decision D46 no longer apply (ADR 0004).
4. **URLs**: the vault path is the canonical URL for good (ADR 0005). Generated pages live under `/-/`. Raw Markdown lives at `/-/md/<path>.md`.
5. **Hosting**: candidate "one Worker with static assets plus object storage", to confirm by a prototype. The cache can keep HTML and Markdown answers apart with a cache rule, so the statement in section 5.5 about `Vary: Accept` is outdated. See the hosting research.
6. **Content store**: a separate repository, private at first (ADR 0006). Renames are tracked in the manifest and a journal of the plugin (ADR 0007).
7. **First release grows**: all agent-facing parts with a remote MCP server in the code mode pattern, the command palette on `/`, `Ctrl+G` for the graph, several ad positions with a fallback ad, link cards for `LINK:` blocks, a reading progress bar.
8. **Second wave**: stacked pages and more themes.
9. **Stats**: the stats page is built by this codebase and stays on its own host.
10. **Articles and newsletters** that also exist on the main site get a canonical URL to the main site.
11. **Analytics**: a better setup is a requirement: what works, what does not, what leads to sales.
12. **Corrections from the research**: the Ghost Publish plugin does not call the Obsidian Publish API (sections 6.9 and 11.2 overstate that change). The author does not hold back changed notes, so changed notes are selected by default in the publishing tool.

## 1. Problem statement

1. The public notes site (notes.dsebastien.net) runs on Obsidian Publish. Each first visit downloads a 13 MB site cache before any note shows. The site gets slower with each published note, and it now has 20,735 notes.
2. Search engines get a damaged picture of it: crawlers receive the note content, but with a canonical URL that is cut at the first dot of the path (wrong for about 19,200 notes), an empty sitemap, and status 200 for pages that do not exist.
3. The site cannot be extended. Each custom feature (properties panel, ads, music notation) is a script that fights the Publish renderer with timers and observers.
4. The web presence is split over three sites with three stacks: notes (Obsidian Publish), main site with blog and newsletter (Ghost), store (React). They do not share navigation, search, design, links or analytics. Articles exist two times.
5. Two of the three stacks are rented. The goal is a stack that the author owns, with lower running costs.

## 2. Solution

One codebase that builds static sites from the Obsidian vault, with the Knowii brand, in three sections:

1. **Notes**: the digital garden. First to ship. It replaces Obsidian Publish, and every URL that works today continues to work.
2. **Blog**: articles, newsletters, news and pages. It replaces the Ghost front end.
3. **Store**: products. It replaces the React store.

The author continues to write in Obsidian and to decide in Obsidian what is published, skipped or unpublished.

## 3. Goals, non-goals, principles

### 3.1 Goals

1. A note page loads as plain HTML and is readable without JavaScript.
2. Every URL that works today works after the switch: same URL, or one redirect.
3. Feature parity with the current notes site at the switch, then more.
4. One design system, one search, one link graph and one analytics view across the sections.
5. Publishing stays a decision per note, made in Obsidian, with a review step.
6. Private content and personal data of other people can never reach the site or this repository by accident.
7. The domain switch is one DNS change, and it can be reverted during a defined window.
8. Performance is a release criterion. Budgets are checked in CI.
9. The site is "agent ready": it passes the checks of isitagentready.com that apply to it.
10. Ads for own products and newsletter signups work at least as well as today, and they can be measured.

### 3.2 Non-goals for the first release

1. A rewrite of the store. It moves last.
2. A replacement for newsletter delivery.
3. Accounts and gated content on the site.
4. One host name for everything. It stays possible later (decision D1).
5. A publishing plugin for the community (decision D18).

### 3.3 Principles

1. **Static first**. HTML at build time. JavaScript only for features that need it, loaded when used.
2. **Vault is the source**. No content is written in this repository.
3. **Fail closed**. When the pipeline is not sure that a note, a property or a file is public, it does not publish it. Allow lists, never hide lists.
4. **One cleaned artifact**. The publication produces one cleaned Markdown file per note. The HTML page, the Markdown download, the search index and the files for agents all derive from it. Nothing reads the vault after that point.
5. **Deep modules**. Few modules with small interfaces, each testable alone with a fixture vault.
6. **Contracts are tested**. The URL contract, the privacy gate, the performance budgets and the `products-light.json` shape each have an automated test that blocks a release.
7. **Measure first**. A baseline of search traffic, page speed, ad clicks and signups is recorded before the switch. "Better" needs a number.
8. **Prototype the risky parts** before they are specified: the full-size build, the URL resolver, Markdown on request behind the cache.

## 4. Vocabulary (draft, to refine in `GLOSSARY.md`)

| Term              | Meaning                                                                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vault             | The private Obsidian vault. Source of all content.                                                                                                 |
| Public note       | A note that the author marked for publication. An intent, not a state.                                                                             |
| Published note    | A note that is live on the site. A state.                                                                                                          |
| Deny list         | Vault folders and note types that can never be published, whatever a property says.                                                                |
| Privacy gate      | The checks that every note, property and attachment passes before publication and again at build.                                                  |
| Publication       | The act that moves selected changes from the vault to the content store. It starts in Obsidian.                                                    |
| Publication queue | The list of new, changed and removed notes that the author reviews and selects from.                                                               |
| Content store     | The snapshot of what is published: cleaned notes, attachments and the manifest. The site builds from it and from nothing else. It is never public. |
| Manifest          | The record of each published note: stable id, path, former paths, hashes, dates, state.                                                            |
| Takedown          | The fast removal of a note and of everything derived from it.                                                                                      |
| Section           | One of the three parts of the site: notes, blog, store.                                                                                            |
| Note type         | The Obsidian Starter Kit type of a note (movie, quote, person, article). It selects the layout, the allowed properties and the indexing rule.      |
| URL contract      | The rules that say which URL each note has and which other URLs lead to it.                                                                        |
| Resolver          | The one function that turns any requested path into a canonical URL, a redirect, or "not found".                                                   |
| Reserved prefix   | The path prefix under which every generated page lives, so that it can never collide with a note.                                                  |
| Ad                | A promotion of an own product or resource on a page. _Avoid_: CTA, banner                                                                          |
| Product card      | The card form of an ad.                                                                                                                            |
| Agent             | A program that reads or uses the site for a person: crawler, AI assistant, coding agent.                                                           |
| Switch gate       | The list of conditions that must be true before the DNS record moves.                                                                              |

## 5. Architecture (first take)

### 5.1 Flow

```
Obsidian vault (private)
   |  in Obsidian: freeze queries, export resolved links and note types
   |  publish core: privacy gate, clean, diff, select
   v
Content store (cleaned notes, attachments, manifest; never public)
   |  build: privacy gate again, link index, render, search index
   v
Static files + resolver map + discovery files
   |  deploy: new release, switch, purge what changed
   v
Edge (resolver, Markdown on request, cache)  ->  reader or agent
```

### 5.2 Repository layout (monorepo)

| Part                      | Role                                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `packages/publish-core`   | Privacy gate, cleaning, diff against the manifest, content store writes, takedown. Works on an export from Obsidian. |
| `packages/markdown`       | Cleaned Obsidian Markdown to HTML, with a render cache.                                                              |
| `packages/link-index`     | Links, backlinks, graph data, URL map, resolver data. One index for all sections.                                    |
| `packages/resolver`       | The resolver function (section 5.4). Plain TypeScript, so that it runs in tests, at the edge, or on a server.        |
| `packages/ui`             | Design system: tokens, themes, components.                                                                           |
| `apps/notes`              | Astro build of the notes section.                                                                                    |
| `apps/cli`                | Commands: publish, takedown, build, check, serve.                                                                    |
| `apps/blog`, `apps/store` | Later.                                                                                                               |
| Obsidian plugin           | Later, in its own repository (decision D17).                                                                         |

One notes build first. A split into one build per section comes only when a second section exists and a measured reason exists (decision D44). The link index and the URL map are built once, before any site build, so that sections can link to each other.

### 5.3 Stack

- Astro, TypeScript (maximum strictness), Tailwind 4, Bun as package manager and test runner.
- React only inside interactive islands, and only where the store needs it.
- Pagefind for search. WebGL for the global graph, with a layout computed at build time.
- Before the Markdown pipeline is written: a look at existing parts (`astro-loader-obsidian`, the Quartz transformers), decision D49.

### 5.4 URL contract (notes section)

What works today (verified in a browser, research 1.6): the full path, the file name alone, any letter case, a `.md` suffix, a trailing slash, an alias. About 48,000 names at the root.

| Id  | Rule                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1  | The canonical URL of a note is the URL it has today: each segment of the vault path percent-encoded, then `%20` written as `+`. A literal `+` in a name is `%2B`. Decision D42 asks whether a shorter form becomes canonical later.         |
| U2  | One resolver turns every other form into the canonical URL in one redirect: `%20` for spaces, any letter case, a `.md` suffix, a trailing slash, the file name alone, an alias, Unicode in another normal form, a query string.             |
| U3  | Precedence when a name can mean two things: live path, then former path, then file name, then alias. An alias that belongs to more than one note gives the "not found" page with those notes as suggestions.                                |
| U4  | Redirects from former paths are permanent (301). Redirects from file names, aliases and letter case are temporary (302), because the target can change when a new note takes the name.                                                      |
| U5  | A note that moved or was renamed keeps its former URLs as redirects. The manifest keeps former paths in an append-only log.                                                                                                                 |
| U6  | Every generated page (search, graph, recent, tags, types, stats, feeds, API) lives under one reserved prefix. A note can never collide with it. The publication is blocked if a note name or alias equals a top-level route. Decision D41.  |
| U7  | Notes that are generated today keep their URLs: the home note, "Recently added", "Recently modified", "Stats". Each shows the new generated page or redirects to it.                                                                        |
| U8  | Old heading anchors still scroll to the heading. Headings get valid ids, and a small script maps the old fragment forms. The real old forms are tested first.                                                                               |
| U9  | An unknown path gets a real 404 page with search suggestions. A note that was unpublished gets 410. A note that was taken down gets 404 and loses its former paths.                                                                         |
| U10 | Each attachment has a stable URL that follows its vault path, and a content-hashed URL with a long cache time that pages use. The stable URL serves the file or redirects to it.                                                            |
| U11 | The raw Markdown of a note lives under the reserved prefix, not at `<url>.md`: that form shows the page today, and 13 notes have names that end like a file extension. Markdown responses carry `noindex` and a canonical link to the page. |
| U12 | A query string never changes the page. It is ignored by the cache and by the canonical URL.                                                                                                                                                 |
| U13 | Every URL that the build writes (links, sitemap, feeds, search results) is canonical and returns 200 without a redirect. One URL function serves all outputs. CI checks it.                                                                 |
| U14 | stats.notes.dsebastien.net redirects to the new stats page.                                                                                                                                                                                 |
| U15 | Blog section: every Ghost URL keeps its path, including the paths that are not in the sitemap (research 2). Store section: every store URL keeps its path, and one host form becomes canonical (decision D53).                              |

Acceptance tests:

1. Every note path of the Publish cache (20,735) returns 200.
2. For a sample of each variant kind (file name, lower case, `.md`, trailing slash, alias, `%20`, names with `+`, `%`, `&`, apostrophes, dots and non-ASCII characters), one redirect leads to the right note.
3. Every link from the main site, the store, the PKM wiki and the sent newsletters to the notes host resolves. Targets that are dead today are listed, and the author decides on a redirect for each.

### 5.5 Hosting (two candidates, decision D3)

|                               | A: own server                                                                        | B: object storage and an edge function                                       |
| ----------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Shape                         | Static files on a self-managed server behind the Cloudflare cache                    | Static files in object storage, one edge function in front, Cloudflare cache |
| Resolver (U2)                 | Server-side script                                                                   | In the edge function                                                         |
| Markdown on request           | Needs an edge rule anyway: the cache ignores `Vary: Accept`                          | In the edge function, before the cache                                       |
| Crawler load after the switch | Reaches the server on each cache miss. The site is a long tail, so misses are common | Never reaches a server                                                       |
| Limits                        | None on file count                                                                   | Per-file size limit: large videos go to object storage directly. Paid plan   |
| Dependencies                  | Fewer vendors, more to operate                                                       | More dependence on Cloudflare, nothing to operate                            |
| Failure                       | One server shared with other services                                                | No shared server                                                             |

First recommendation: B for the notes section, with the resolver as portable TypeScript so that A stays possible. A prototype decides (section 15.2). The real file count is far above the 35,000 source files: a page, a Markdown file and image variants per note pass 100,000 files.

### 5.6 Build and deployment

1. The build runs outside the author machine and outside any shared server (decision D43). It needs the content store and the attachments, so both must be readable from there.
2. Astro renders every page at each build. It has no incremental page build. Speed comes from a render cache in `packages/markdown`, keyed by the cleaned note, the link state of its targets, and the renderer version.
3. A full-size prototype comes first: cold build, one-note change, layout change. It measures time and peak memory.
4. A deployment is a new release next to the old one, then one switch. Hashed assets of earlier releases stay available. A release can be reverted with one command.
5. After the switch of a release, the cache is purged for exactly the outputs whose hash changed. One note can change many outputs: pages that show its backlinks or its title, hub pages, recent pages, feeds, sitemaps, search chunks.
6. The search index is rebuilt at each build.

## 6. Publishing after the migration

### 6.1 Requirements

1. The author publishes from Obsidian.
2. The author chooses per note: publish, skip for now, unpublish.
3. A review step shows what will change before anything goes live.
4. A change in the vault never goes live by itself.

### 6.2 What changes compared with today

Today the Obsidian Publish panel is the switch. The `public_note` property is a mirror that `TPL Publish` writes: it adds the property to published notes and removes it from the others (research 1.9).

The new flow turns this around: **the property becomes the intent**. Consequences:

1. Anything that writes the property (a template, an agent, a bulk edit) creates a publication candidate. Anything that removes it creates a removal candidate.
2. The old reconciliation in `TPL Publish` must stop at the moment the new flow starts. If both run, the old script removes every new mark.
3. A guard asks for confirmation when one publication changes the intent of more than a set number of notes, or removes more than a set share of the site (a vault that is half synchronized looks like a mass removal).
4. 18 note templates carry the property today. The deny list keeps them out.

Decision D12 covers who may start a publication: the author only, or also automation that the author set up.

### 6.3 Model

- **Intent**: the property on the note.
- **State**: the manifest. Per note: `committed` (in the content store) and `deployed` (in which release it is live). The deployment writes `deployed`, so the manifest never claims more than what is live.
- **Publication queue**: intent compared with state. Four lists: new, changed, to remove, unchanged.
- **Skip**: an entry that the author leaves unselected. The live version stays.
- **Never skippable**: a note that moved into a deny-listed folder or got a deny-listed type is removed at the next publication, selected or not.
- **Link-only changes**: when a rename rewrites links in many notes, those notes change only in a link. They are published together with the renamed note, without a selection. Decision D55.

### 6.4 Steps of a publication

In Obsidian (needs the running application):

1. Freeze Dataview queries of public notes with the Dataview Serializer.
2. Export, per public note: the resolved target of each link and embed (from the Obsidian link cache, so that the result equals what Obsidian shows), the note type, and rename events since the last publication.

In the publish core (no Obsidian needed):

3. Run the privacy gate on **all** public notes, not only the changed ones (section 7).
4. Compute the publication queue.
5. The author selects (section 6.5).
6. Clean each selected note into one artifact: allowed properties only, comments and Meta Bind code removed, query markers removed, attachments collected and stripped of metadata. Links stay as references to a note id, so that the build decides at render time whether the target is live.
7. Upload attachments, then write notes and manifest to the content store in one commit. A publication that fails halfway can be run again and gives the same result.
8. Start the build and the deployment. Report the result in Obsidian with links.

A lock prevents two publications at the same time, from one machine or two.

### 6.5 Selection at the first release (decision D37)

Three routes. The first recommendation is route 1 for the switch, then route 3.

1. **Bridge**: Obsidian Publish stays the place where the author selects and reviews, exactly as today. A command reads the published list and exports those notes to the content store. The static site is live on the notes domain. Publish continues behind it, unseen. Cost: the subscription continues for a while, and the bridge depends on the internal Publish API. Gain: the publishing tool is off the critical path of the performance problem.
2. **Queue note**: the CLI writes a note with the four lists and check boxes. The author ticks entries in Obsidian and runs the publish command, which reads the note.
3. **Publication center**: a plugin view like the Publish panel, with filters, a diff per note, a status indicator on the open note and a history. Built on the publish core, after the switch.

### 6.6 Content store (decisions D9, D39)

1. A private git repository holds the cleaned Markdown and the manifest. Git gives history, a diff per note and a revert. The custom code stays small.
2. Attachments live in object storage, addressed by hash. The manifest lists them, so that totals, cleanup and takedown work.
3. The store never becomes public and is never shared: its history holds every note that was unpublished. An open data set (backlog S52) would be a fresh export without history.
4. The manifest is one file per note, so that two machines do not conflict.
5. Note ids live in the manifest, not in the notes. Nothing writes an id into 20,735 vault files. Renames come from the Obsidian rename events, with content similarity as a fallback (decision D13).
6. `stats.json` enters the build as its own input with its own schema. It is not part of the content store.

### 6.7 Dates

1. The manifest starts with real dates: "first published" is seeded from the `created` property of each note, so that the switch day does not make 20,735 notes "new".
2. "Updated" on the site comes from the hash of the cleaned note. A change of the renderer or of the template does not touch it.
3. Significant update: only an edit above a threshold, or an explicit property, moves a note up in "recently updated", feeds and sitemap dates.
4. Bulk import: a publication with a large number of notes of one type becomes one entry in the change log and stays out of the feeds and the recent pages.

### 6.8 Takedown

A command for the case "this must be gone now" (a person asks, a mistake is found):

1. Delete on the origin, first: the page, the Markdown file, the Open Graph image, the attachments that no other note uses, including their hashed URLs.
2. Purge those URLs from the cache.
3. Remove the note from the manifest, with its former paths. The URL answers 404, not 410, and no redirect keeps an old name alive.
4. Rebuild, so that search index, graph, feeds, sitemaps, files for agents, backlinks and embeds in other notes lose it.
5. Remove the note from the content store history if the case needs it.
6. Browser caches and copies taken by crawlers cannot be recalled. The document says so.

### 6.9 What replaces the current scripts

| Today                                                           | After                                                                |
| --------------------------------------------------------------- | -------------------------------------------------------------------- |
| `TPL Publish`: mirror the Publish state into the property       | Gone (not with route 1 of 6.5, where it stays until the bridge ends) |
| `TPL Publish`: run the Dataview Serializer                      | Step 1 of the publication, still in Obsidian                         |
| `TPL Publish`: generate the two "recent" notes                  | Generated pages. The two notes keep their URLs (U7)                  |
| `TPL Publish`: open the Publish panel                           | Selection of section 6.5                                             |
| Publish API list in `TPL Stats` and in the Ghost Publish plugin | The manifest. Both tools must change before Publish is cancelled     |
| `TPL Stats` pushing `stats.json` to the stats repository        | `stats.json` becomes a build input. The site renders the stats page  |

### 6.10 Build or adopt (decision D49)

- The closest existing route is Quartz with the Quartz Syncer plugin: wikilinks, embeds, callouts, backlinks, graph, search, tag pages, and a publication view with a diff.
- It does not give: one codebase and design with the blog and the store, layouts per note type, the URL contract with `+` paths and 48,000 names, strict performance budgets at 20,000 notes, the privacy gate.
- The own route is justified by those points only. It is not justified to rewrite parts that exist: the Markdown transformers and the loader get a look first.
- A plugin for the community has no clear gap today. It would be a plugin plus a site template plus a hosting guide, against free tools. First recommendation: a personal tool with a clean core, and a review after the store has moved (decision D18).

## 7. Privacy gate

The gate runs at each publication on all public notes, and again at each build on the content store. A clean report over the whole corpus is a condition of the switch gate.

| Check                                                                                       | Result                                                                                                                                        |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Note in a deny-listed folder or of a deny-listed type                                       | Blocked. If it is live, it is removed, and this cannot be skipped                                                                             |
| Property that is not on the allow list of its note type                                     | Dropped and reported. Unknown keys never pass                                                                                                 |
| Person notes                                                                                | Own allow list. No email address, birth date, location or private handle in HTML, Markdown, structured data or files for agents. Decision D40 |
| Property value that points to a private note or a private path                              | Dropped                                                                                                                                       |
| Frozen Dataview output with a row, link or title from a deny-listed note                    | Blocked. The row must go before the note can be published                                                                                     |
| Link or embed to a note that is public but not live yet                                     | Plain text for now. It becomes a link when the target goes live, with no change to the linking note                                           |
| Link or embed to a note in a deny-listed folder or type                                     | The alias, or a neutral placeholder. Never the title. Decision D50                                                                            |
| Embed at the depth limit or in a cycle                                                      | Placeholder. Never the raw link text                                                                                                          |
| Attachment outside the public attachment folder                                             | Blocked                                                                                                                                       |
| Attachment metadata (location, author, file paths in images, SVG and PDF)                   | Stripped at publication, originals included                                                                                                   |
| Text that looks like a secret or like personal data (key, token, email, phone, bank number) | Blocked, or allowed by an explicit mark on the note                                                                                           |
| Name or alias that collides with another note (letter case ignored) or with a site route    | Blocked                                                                                                                                       |
| Live Dataview or Bases block without a frozen form                                          | Dropped from the output, with a warning                                                                                                       |
| Raw HTML                                                                                    | Allow list. The same cleaned text feeds HTML and Markdown outputs, so a comment cannot survive in one of them                                 |
| No description, image without alt text, very large image                                    | Warning                                                                                                                                       |

Tests try to leak through each row (section 10).

## 8. User stories

Priority: **G** switch gate (must be true to move the DNS record), **M** must for the first release of the section, **S** should, **C** could. Section: **N** notes, **B** blog, **St** store, **X** all.

### 8.1 Reader

1. (G, N) As a reader, I want a note to show at once, so that I do not wait for the site to load.
2. (G, N) As a reader, I want to read a note without JavaScript, so that the site works in any browser and reader tool.
3. (G, N) As a reader with an old link, I want it to open the right note, so that links in articles and newsletters keep their value.
4. (G, N) As a reader, I want wikilinks, embeds, images, tables, callouts, code, footnotes, math and diagrams to render as in Obsidian.
5. (G, N) As a reader, I want to see the properties of a note in a tidy panel, so that I get its metadata at a glance.
6. (G, N) As a reader, I want to see which notes link to this note, with the sentence around each link, so that I can explore in both directions.
7. (G, N) As a reader, I want an outline of the note, so that I can jump to a section.
8. (M, N) As a reader, I want to know where a note sits: the maps of content that hold it, and its folder.
9. (G, N) As a reader, I want a local graph of the note, so that I see its neighborhood.
10. (G, N) As a reader, I want a global graph that I can zoom, filter and search. The current site has one.
11. (G, X) As a reader, I want full-text search with results as I type.
12. (M, N) As a reader, I want to filter search results by note type and tag.
13. (G, N) As a reader, I want a page with the recently added notes.
14. (G, N) As a reader, I want a page with the recently updated notes.
15. (M, N) As a reader, I want to download a note as Markdown, so that I can keep it in my own vault.
16. (M, N) As a reader, I want to copy a note as Markdown, so that I can paste it into my notes or an AI chat.
17. (G, X) As a reader, I want a dark and a light theme that follow my system and that I can switch.
18. (G, X) As a reader on a phone, I want the layout, the navigation and the search to work on a small screen.
19. (G, N) As a reader, I want the created and updated dates of a note, near the title.
20. (G, N) As a reader of a music note, I want chord diagrams, tabs and scores to render and to play.
21. (G, X) As a reader, I want a useful 404 page with search, so that a wrong link is not a dead end.
22. (S, N) As a reader, I want a preview when I hover an internal link.
23. (S, N) As a reader, I want a hub page per note type with filters and sorting.
24. (S, N) As a reader, I want a media library with covers, ratings and status.
25. (G, N) As a reader, I want a tag to lead to a page with its notes. A click on a tag works today.
26. (S, X) As a reader, I want a command palette (`Ctrl+K`).
27. (S, N) As a reader, I want related notes under a note.
28. (M, X) As a reader, I want RSS feeds (all, per type, per tag).
29. (S, N) As a reader, I want to zoom an image.
30. (M, N) As a reader, I want a link icon on each heading, so that I can share a section.
31. (M, N) As a reader of a French note, I want the page marked as French and linked to its English twin.
32. (C, N) As a reader, I want a random note button.
33. (C, N) As a reader, I want an "On this day" page.
34. (S, N) As a reader, I want stacked pages in the style of Andy Matuschak's notes: a click on a link opens the note in a new column next to the open ones. The current site has this (sliding window mode), so its absence is a visible downgrade. Decision D36.
35. (C, N) As a reader, I want to see how a note changed over time.
36. (C, N) As a reader, I want a quote of the day.
37. (C, N) As a reader, I want to download a map of content with its linked notes as one archive.
38. (C, N) As a reader, I want to share a quote as an image card.
39. (C, N) As a reader, I want a graph time-lapse.
40. (C, X) As a reader, I want to ask a question and get an answer from the notes with sources.
41. (M, N) As a reader, I want one line of context on each page (whose garden this is, what a note is, where to start), so that I am not lost when I arrive from a search.
42. (M, N) As a reader, I want to see that a link target is not published, so that plain text in the middle of a sentence does not look like a mistake.
43. (S, N) As a reader, I want a "report a problem" link on each note.
44. (C, X) As a reader, I want to choose between several visual themes, each with a light and a dark mode: the store and PKM wiki look (default), a look close to the current dsebastien.net, others. A bonus. Decision D35.

### 8.2 Author

45. (G, N) As the author, I want to mark a note as public in Obsidian.
46. (G, N) As the author, I want to review the list of new, changed and removed notes before they go live.
47. (G, N) As the author, I want to select which changes go live and leave the others.
48. (G, N) As the author, I want to unpublish a note.
49. (G, N) As the author, I want folders and note types that can never be published, whatever I do.
50. (G, N) As the author, I want links to private notes to never lead anywhere and never show a private title.
51. (G, N) As the author, I want only the attachments that public notes use to be published, without their hidden metadata.
52. (G, N) As the author, I want Dataview results frozen into the published note, and never a row from a private note.
53. (G, N) As the author, I want Meta Bind buttons and comments removed from every output.
54. (G, N) As the author, I want a renamed or moved note to keep its old URL as a redirect.
55. (M, X) As the author, I want a local preview of the site, so that I can check a page before publication.
56. (G, N) As the author, I want a publication to finish with a clear report (live, failed, warnings).
57. (G, N) As the author, I want to take a note down fast and completely, with everything derived from it.
58. (G, N) As the author, I want a check for secrets and personal data before publication.
59. (G, N) As the author, I want only allowed properties to reach the site, per note type, so that a new private property can never leak.
60. (G, N) As the author, I want a confirmation when one publication changes or removes an unusual number of notes.
61. (G, N) As the author, I want a failed publication to leave a state that I can see and repeat safely.
62. (M, N) As the author, I want a note to be indexed by search engines or not, by a rule per type and an override per note.
63. (M, N) As the author, I want only real edits to move a note up in "recently updated".
64. (M, N) As the author, I want a bulk import to stay out of feeds and recent pages.
65. (S, N) As the author, I want a publication center inside Obsidian that looks like the Publish panel, with a diff per note.
66. (S, N) As the author, I want a status indicator on the open note (not public, live, changes pending).
67. (S, N) As the author, I want warnings for missing descriptions, missing alt text and oversized images.
68. (M, N) As the author, I want images optimized at build time.
69. (S, B) As the author, I want to publish an article from Obsidian without a second tool.
70. (S, B) As the author, I want to send an article to newsletter subscribers from the same flow.
71. (C, X) As the author, I want to schedule a publication date on a note.
72. (C, N) As the author, I want to publish from my phone.
73. (C, X) As the author, I want properties such as `slug`, `canonical_url` and `cta` per note.
74. (S, N) As the author, I want a weekly note in my vault with what readers looked for and did not find.

### 8.3 Search engines and AI agents

75. (G, X) As a crawler, I want a unique title, description and correct canonical URL on each page.
76. (G, X) As a crawler, I want sitemaps split by section and type under one sitemap index, a correct `robots.txt`, and a real 404 status for pages that do not exist.
77. (G, X) As a social network, I want Open Graph and Twitter card tags with an image.
78. (M, X) As a search engine, I want structured data (JSON-LD) that fits the note type.
79. (M, N) As an AI agent, I want the Markdown of a page when I ask with `Accept: text/markdown`.
80. (M, N) As an AI agent, I want the raw Markdown of each note at a stable URL, and `llms.txt` as an index.
81. (M, X) As an AI agent, I want `robots.txt` to state the rules for AI bots and the content signals, so that I know what I am allowed to do.
82. (M, X) As an AI agent, I want `Link` headers that point to the sitemap, the Markdown form and the feeds.
83. (S, X) As an AI agent, I want an API catalog, published agent skills and an MCP server card.
84. (S, X) As an AI agent in a browser, I want the page to register tools (search notes, get this note as Markdown).
85. (C, N) As an AI agent, I want an MCP server for search and retrieval.
86. (C, N) As a developer, I want static JSON files (note index, graph, per-note data).
87. (C, St) As a shopping agent, I want the store to speak a commerce protocol.

### 8.4 Business

88. (G, N) As the business owner, I want ads on note pages that match the topic of the note, at least as good as today.
89. (G, X) As the business owner, I want Plausible analytics with the current site id and the `cta_clicked` event, so that my numbers stay comparable.
90. (G, X) As the business owner, I want the newsletter signup in view on every page, as today.
91. (G, X) As the business owner, I want the Knowii brand on every page.
92. (G, St) As the business owner, I want `products-light.json` to keep its URL and shape.
93. (G, X) As the business owner, I want a baseline of search traffic, ad clicks and signups before the switch, and the same numbers after it.
94. (M, N) As the business owner, I want to count how often an ad is seen, so that I can compute a click rate.
95. (M, N) As the business owner, I want links to the store to carry campaign parameters and to reach the product page without a redirect.
96. (M, N) As the business owner, I want an ad for the newsletter or a free resource when no product matches, so that no note ends without a next step.
97. (M, N) As the business owner, I want no irrelevant ad on a media note because one word of its title matched a product.
98. (S, N) As the business owner, I want more than one ad position (end of note, side column, inside long notes), each tracked apart.
99. (S, X) As the business owner, I want events for search, downloads, graph use, signups and outbound links.
100.    (G, N) As the business owner, I want the stats page and the stats tooling to keep working at the switch.
101.    (S, X) As the business owner, I want one navigation across notes, blog and store, and one analytics view of the path from a note to a purchase.
102.    (S, B) As the business owner, I want each article to exist one time.
103.    (C, X) As the business owner, I want to test variants of an ad.
104.    (C, N) As the business owner, I want the most visited notes listed on the site.

### 8.5 Operator

105. (G, X) As the operator, I want a preview host with the new site while the old one stays live.
106. (G, X) As the operator, I want an automated URL parity test, variants included.
107. (G, X) As the operator, I want the switch to be one DNS change that I can revert, and I want to know when that window ends.
108. (G, X) As the operator, I want a deployment to be one switch between releases, with a revert command.
109. (G, X) As the operator, I want the build to fail on a privacy gate violation.
110. (G, X) As the operator, I want CI to fail when a page type exceeds its performance budget.
111. (M, X) As the operator, I want a link check and an HTML check in CI.
112. (M, X) As the operator, I want a Content Security Policy that is as strict as the features allow.
113. (M, X) As the operator, I want crawlers, also AI crawlers, to be unable to overload the origin.
114. (S, X) As the operator, I want build and deployment reports.

## 9. Implementation decisions (first take)

### 9.1 Content pipeline

1. The build reads the content store, never the vault.
2. Properties: an allow list per note type decides what reaches any output. A typed core (title, type, tags, topics, dates, aliases, description, cover, language) is validated with a schema.
3. The note type comes from the type tags and from the export of the type registry (section 6.4, step 2).
4. Title: `title` property, else the first heading, else the file name.
5. Language: a property on the note, else the default language.
6. The 10,459 media notes are mostly data. They get a data-driven layout: a header from properties, then the author's own text ("My take") when it exists.

### 9.2 Markdown rendering

1. Features: wikilinks with aliases, heading and block links, note and block transclusion (with a depth limit and cycle detection), image embeds with a size suffix, audio, video and PDF embeds, callouts with folding, highlights, footnotes, tables, task lists, math, code highlight.
2. Links resolve at build time against the set of live notes. A target that goes live later becomes a link without a change to the linking note. A takedown re-renders every note that embeds the target.
3. Link resolution uses the export from Obsidian, so that the site and Obsidian always agree on the target.
4. Output is class-based: no inline styles from code highlight, math, diagrams or music. This is a condition of the security policy (9.15).
5. Mermaid renders to SVG at build time, in both themes. Decision D20.
6. Frozen Dataview output: markers removed, static Markdown kept. The query source can stay as a folded block for teaching (backlog 116), by decision.
7. Canvas and Excalidraw references: a link, or a static image if one exists.
8. External links open in the same tab. Decision D21.
9. Times render in one fixed time zone.
10. Paragraph style: the current site justifies and hyphenates text. The new default is decided with the design.

### 9.3 Properties panel

1. Rendered at build time, closed by default as today, from allowed properties only.
2. Same display rules as today (research 1.7, feature 1), with the known gaps decided: the heading part of a link property is kept.
3. A per-type configuration: order, labels, which properties go into the page header.
4. Tags link to tag pages. Link properties link to their note when it is live.

### 9.4 Navigation and layout

1. Header shared by all sections: logo (leads home), sections, search, theme switch.
2. Note page: context line, title with dates, type badge, "part of" (maps that hold the note), properties, content, ads, backlinks with context, local graph, newsletter.
3. Outline in a side column on wide screens.
4. Folder tree: loaded on demand. It is a secondary way in. Type hubs, tags and maps of content are the primary ways.
5. A folder URL shows the folder note when one exists, with a generated list of children. A note and a folder with the same name: the note wins, as today.
6. Home page: designed, with hero, stats, entry points by topic and type, recent notes.
7. Stacked pages: a progressive enhancement on plain links. Without JavaScript a link opens a page. With it, the note opens as a column, the URL records the stack, and small screens fall back to normal navigation.

### 9.5 Graph

1. One link index per build: nodes (id, title, type, URL), edges (body links and property links, marked apart). Only live notes. Unresolved and private targets never become nodes.
2. Global graph page: layout computed at build time with fixed start positions, so that the picture and the file hash are stable between builds. WebGL drawing, colors by type, filters, search. Compact data format. A lighter view on phones.
3. Local graph: drawn from the neighbor list that the page already holds, or as a static SVG made at build time. No extra file per note.
4. The global graph opens from a visible control. The old shortcut and the click on the site name are decided in D54.
5. A list view of neighbors exists for screen readers and small screens.
6. An event records graph use, so that later work on the graph has data.

### 9.6 Search

1. Pagefind, rebuilt at each build.
2. One index for all languages, so that a French note is found from an English page.
3. Titles and aliases weigh more than body text. A small index of titles and aliases loads first for instant jumps.
4. Allowed properties are searchable as filters (type, tag, year, rating, author).
5. Known limits, decision D45: no typo tolerance, no semantic search.
6. Search UI: a page under the reserved prefix, and later a command palette.

### 9.7 Recent pages and feeds

1. "Recently added" and "Recently updated" pages, with filters by type. Today both lists cover the knowledge area only and skip notes with an "ignore" tag. The new scope is decided with D14.
2. RSS, Atom and JSON feeds. Item ids are stable for all time.
3. A change log page per day or week.

### 9.8 Stats

1. `stats.json` stays the data contract. The stats script continues to produce it, because its `overall` block covers private notes that the build never sees.
2. The script reads the published list, attachments included, from the manifest.
3. The site renders the stats page with the design system and the chart rules of the brand.
4. The build adds public metrics: most linked notes, hubs, orphans, notes per type.
5. Each `stats.json` is kept with its date.
6. The stats site retires. Its host redirects (U14). The "Stats" note keeps its URL (U7).

### 9.9 Analytics

1. Plausible through the existing proxy, with the current site id. The preview host uses a test site id.
2. `cta_clicked` keeps its property names. Its values are recorded in the research (1.7), and the `page` value keeps its form.
3. New events: ad seen, search used, search without result, Markdown downloaded or copied, graph opened, newsletter subscribed, outbound link, 404 shown, theme switched, link to an unpublished note clicked.
4. A rollup view across the three hosts, so that the path from a note to a purchase is visible.
5. No cookies.

### 9.10 Ads

The author calls these "ads". The current behavior is the floor.

1. The build picks the product ids per note. The card data (name, price, badge, image) comes from one small versioned file at view time, so that a product change does not rebuild the notes.
2. Matching starts from the current rules (research 1.7), with one fix before the reference test is written: single title words no longer match products, and media types get their own rule.
3. The alias map and the phrase list move to a data file with tests.
4. A note can override: `cta: none`, or product ids.
5. Rotation among the top matches with a seed per note, so that not every note shows the same two products.
6. Fallback when no product matches: an ad for the newsletter or a free resource.
7. Positions: end of note at the first release. Side column and in-note position after that, each with its own `position` value.
8. Links carry campaign parameters and point to the final store URL.
9. Space for ads is reserved in the layout. Ads never shift content.
10. A "why this ad" link explains: own products only, matched by topic, no tracking.
11. Exclusions per note type, configurable. Today: person and quote notes, and the home page.

### 9.11 Newsletter

1. Parity with today: a bar fixed to the bottom of the screen, with the states "error", "sent", "already subscribed" and "do not show again". Decision D51 covers position and form.
2. The form is rewritten without inline handlers and inline styles. The script is pinned and self-hosted.
3. It calls the Ghost API of the main site, as today. The component hides the back end, so that decision D5 can change it.

### 9.12 Music notation

1. Same ten block languages as today.
2. First release: the library loads in the browser on pages with music blocks only, pinned and self-hosted. Page properties reach it through a data block. Music pages have their own, named performance budget.
3. Target: diagrams as SVG at build time, the player at the first Play. Needs a prototype.
4. The build runs the `check` command of the library on all music blocks.

### 9.13 SEO and sharing

1. Per page: title, description (property, else generated per type), canonical URL, language, Open Graph and Twitter tags.
2. Open Graph image: the cover for media notes, a generated brand card for the others, cached by content hash.
3. JSON-LD by note type. Person notes: name and public role only.
4. Sitemap index per host, one sitemap per type, an image sitemap by decision (D47). `lastmod` from the cleaned-note hash. Notes set to `noindex` stay out.
5. Indexing rule (decision D46): a note is indexed when its type is indexable and it has enough own text or a description. Thin notes are `noindex` by default, with an override per note. About 69 percent of the notes are thin today: media, quotes, people.
6. Indexable list pages over thin notes ("quotes about X", "best cooperative board games I own") carry the search value of those types (backlog 84, 85).
7. Articles, newsletters and news notes also exist on the main site. Until the blog section is live, they are `noindex` on the notes host, or they carry a canonical URL to the main site once the real slugs are known (decision D24).
8. After the switch: sitemaps released in stages (permanent notes, maps and books first), IndexNow at each publication, one success metric.

### 9.14 Performance and accessibility

Performance is the reason for this project.

1. The default note page is the blocking budget: HTML, one small CSS file, one small script for theme and analytics. Exempt page types (music, graph, search) are named, each with its own budget. Decision D30.
2. No client-side framework on note pages. No layout shift from late content.
3. Images: responsive sizes, modern formats, lazy loading, dimensions set, dominant color as placeholder.
4. Fonts self-hosted, subset.
5. Theme: light and dark. Follow the system. Without a system preference, the default of decision D7. A manual switch is stored. No flash before the first paint.
6. Themes: every color, font, radius and shadow is a design token. A theme is one set of token values with a light and a dark mode. One theme at the first release. More themes are additive.
7. Colors: the brand magentas fail contrast as text on the dark background (research 5). Links and focus rings get a color that passes. The light palette is completed.
8. Caching: hashed asset URLs with a long cache time. HTML with a short browser cache and a long edge cache, purged by diff (5.6).
9. Large data (folder tree, backlinks of hub notes, graph) never sits in the page HTML.
10. Accessibility: semantic HTML, keyboard access, visible focus, WCAG AA, reduced motion respected.

### 9.15 Security

1. A Content Security Policy based on hashes. Known needs: the search library needs WebAssembly, tabs and scores need workers and fonts.
2. Third-party scripts are self-hosted and pinned. Edge features that inject scripts are switched off.
3. Deployment credentials never sit in the vault or in this repository. CI holds them. This repository is public, the content store is private.
4. Rate limits and bot rules at the edge protect the origin.

### 9.16 Agent readiness

The scanner publishes its criteria (in its own `llms-full.txt`). It tests `Link` headers and Markdown on request on the home page.

| Level      | What                                                                                         | Value for this site                                  | When                      |
| ---------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------- |
| Basics     | `robots.txt` with sitemap and AI bot rules, sitemap, Content Signals, `Link` headers         | High: clear rules, correct discovery                 | First release             |
| Markdown   | Markdown on request (`Accept: text/markdown`), a Markdown URL per note                       | High: assistants read and cite the notes at low cost | First release             |
| `llms.txt` | An index, and full-text files split by type or topic (one file for all notes would be 71 MB) | Medium. It is not a scanner check                    | First release             |
| Tools      | API catalog, agent skills, MCP server card, WebMCP tools, ARD manifest                       | Medium: only with real tools behind them             | Second wave               |
| Server     | Remote MCP server, A2A card for an "ask" agent                                               | To decide                                            | Later                     |
| Access     | OAuth discovery, protected resource, Auth.md                                                 | None for a public static site                        | Not planned               |
| Commerce   | x402, MPP, UCP, ACP                                                                          | Store only                                           | Store phase, decision D34 |
| Other      | DNS discovery, Web Bot Auth, Personal Agent Protocol                                         | To investigate                                       | Later                     |

Design notes:

1. Markdown on request must happen before the cache: the edge rewrites the request to the Markdown URL when the `Accept` header asks for it.
2. Agents get the cleaned artifact: allowed properties, site URLs for links, no private text.
3. Every discovery file is generated from the manifest and the site configuration.
4. The policy for AI use is a decision per content class (D33): own text, quotes from other people, cover images, tabs and arrangements. One policy across the three hosts. The store allows AI training today.

### 9.17 Legal and content rights

Not legal advice. These are decisions that the author must make, because a fast, indexable, agent-readable site exposes more than the current one.

1. Person notes: which properties are public, and a contact and removal path (D40).
2. Third-party material: about 10,000 cover images, quotes from books and people, tabs and arrangements. Policy per class for indexing, image sitemaps, files for agents and downloads (D47).
3. Content license for the notes, apart from the license of this code (D29).
4. Legal pages, and consent for embeds that load from other sites.
5. Overlap between public notes and paid products: bulk downloads, topic packs and agent access must not hand out what is sold (D47).

## 10. Testing decisions

1. A good test checks external behavior through a module interface. It does not check internals.
2. **Fixture vault**: a small vault with invented notes, one per feature and per trap: private link, private attachment, deny-listed folder, move into a deny-listed folder, private property, person data, frozen query with a private row, rename with a link cascade, duplicate name, alias collision, names with `+`, `%`, `&`, apostrophes, dots and non-ASCII characters, a name that ends like a file extension, a French note, music blocks. Fake secrets are built at run time, so that the repository holds no string that looks like a real key.
3. **Privacy gate**: one test per row of section 7 that tries to leak. Each must fail closed, in the HTML, in the Markdown output, in the search index, in the graph data and in the feeds.
4. **Resolver**: table tests with the name patterns of the real corpus (generated, not copied), and the parity tests of section 5.4 against the preview host.
5. **Markdown**: one snapshot per feature.
6. **Ads**: the matching rules as tests, written after the fix of 9.10.2.
7. **Publish core**: queue (new, changed, removed, renamed, skipped, forced removal), failed and repeated publication, lock, takedown.
8. **Build output**: every written URL is canonical (U13), link check, HTML validation, accessibility check and performance budget on a sample of each note type.
9. **Agent readiness**: tests for each discovery file and for Markdown on request, plus a recorded scanner run per release.
10. All code is built test first, one red-green slice at a time. `astro check` joins the definition of done with the first Astro code.

## 11. Migration and switch

### 11.1 Order

1. **Baseline and inventory**: export of search and analytics data per note type. Ghost URL and slug inventory. Inbound link crawl. List of links to images on the Publish host.
2. **Prototypes**: full-size build, resolver at the edge, Markdown on request behind the cache, global graph on a phone.
3. **Foundations**: repository tooling, design system, fixture vault, publish core with the privacy gate, resolver.
4. **Notes, to the switch gate**.
5. **Notes, after the switch**: M stories, then S, then C.
6. **Blog**: with its own switch gate (11.4).
7. **Store**.
8. **Optional**: one host name.

### 11.2 Switch gate of the notes section

1. All G stories pass on the preview host.
2. Privacy gate report over the whole corpus: clean.
3. URL parity tests of section 5.4: pass.
4. Performance budgets: pass.
5. Baseline recorded (story 93).
6. The stats script and the Ghost Publish plugin no longer need the Publish API, or the bridge of 6.5 keeps Publish alive.
7. Images that the main site, the store or the wiki load from the Publish host are found and moved. Images in newsletters that were already sent cannot be fixed. The author accepts that or keeps Publish.
8. TLS setting for the notes host is changed for that host only.
9. The preview host is `noindex` and uses a test analytics id.

### 11.3 Switch of the notes domain

1. The DNS record of `notes.dsebastien.net` moves to the new origin.
2. Rollback window: Obsidian Publish stays active and receives every publication until the window ends, so that a revert loses nothing. The window ends by a decision of the author, not by itself.
3. Sitemaps are submitted in stages. Search and analytics numbers are compared with the baseline.
4. The 404 report of the first days feeds the redirect list.
5. After the window: Obsidian Publish is cancelled, `TPL Publish` is reduced or retired.

### 11.4 Blog section, in short

The blog phase carries more search and revenue risk than the notes phase. Its gate needs: every Ghost path (also email click-tracking links, unsubscribe links, images, feeds, member pages), canonical tags, structured data, stable feed item ids, a decision on native comments (D48), on members and the paid tier, on newsletter delivery, and on where Ghost lives when the main host is static (D5). Details come in their own spec.

### 11.5 First tracer bullet

One note from the fixture vault through every layer: export, publish core, content store, build, deployment to the preview host, at its current URL, through the resolver, with the brand layout. Every later ticket widens this path.

## 12. Out of scope for now

1. Accounts, gated notes and paid content on the site.
2. A new newsletter delivery system.
3. Canvas and Excalidraw rendering.
4. Translations of the site interface.
5. A change of the vault structure or of note types.
6. A hosted publishing service.

## 13. Open decisions (design tree)

Each decision has a first recommendation. The interview settles them in rounds: a round holds the decisions whose prerequisites are settled.

### Round 1: roots

| Id      | Decision                                                                                                                                                            | First recommendation                                                                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1 + D5 | End state: one host or three, and the future of Ghost. One decision: one host is not possible while Ghost(Pro) owns the main host, and keeping Ghost keeps its cost | Three hosts through the store phase. Ghost stays for members and email until the blog phase, where it is replaced or reduced. Say now whether one host is the wanted end state |
| D2      | Order of the sections                                                                                                                                               | Notes, then blog, then store                                                                                                                                                   |
| D4      | Publication model                                                                                                                                                   | Content store with a review step. The property becomes the intent (6.2)                                                                                                        |
| D37     | Selection at the first release                                                                                                                                      | Bridge: keep the Obsidian Publish panel as selection until the own tool exists (6.5, route 1)                                                                                  |
| D3      | Hosting                                                                                                                                                             | Candidate B (object storage and an edge function), confirmed by a prototype                                                                                                    |
| D6      | What must be true at the switch                                                                                                                                     | The G stories of section 8 and the gate of 11.2. M stories follow right after                                                                                                  |
| D7      | Theme when the system states no preference                                                                                                                          | Dark (brand)                                                                                                                                                                   |
| D46     | Which notes search engines may index                                                                                                                                | By rule: indexable type, and enough own text or a description. Thin notes `noindex`, with an override per note, and indexable list pages on top                                |
| D8      | Media notes (10,459)                                                                                                                                                | Same site, own library section, data-driven layout                                                                                                                             |
| D40     | Person notes                                                                                                                                                        | Name, role, public links and the author's own text only. No email, birth date or location. `noindex` by default. A contact link for removal                                    |
| D33     | AI use, per content class                                                                                                                                           | Own text: search yes, AI input yes, training is the author's call. Quotes, covers and tabs from other people: search yes, AI input and training no                             |
| D47     | Public notes against paid products, and third-party material                                                                                                        | The author lists which public notes are part of a paid product. No bulk download of those. Covers stay out of image sitemaps                                                   |
| D42     | Canonical URL form                                                                                                                                                  | The long vault path now. A shorter form only if and when the hosts merge, so that URLs change one time at most                                                                 |
| D12     | Who may start a publication                                                                                                                                         | The author, and automation that the author started. Never a scheduled job alone                                                                                                |

### Round 2: depends on round 1

| Id  | Decision                                | First recommendation                                                                        | After   |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------- | ------- |
| D9  | Content store shape                     | Private git repository for Markdown and manifest. Attachments in object storage by hash     | D3, D4  |
| D39 | Diff engine                             | Git as the engine, a thin manifest on top                                                   | D9      |
| D10 | Content store visibility                | Never public. An open data set is a fresh export                                            | D9      |
| D43 | Where the build runs                    | A CI runner, with read access to the content store and the attachments                      | D3, D9  |
| D13 | Note identity and renames               | Ids in the manifest. Rename events from Obsidian. No id written into notes                  | D4      |
| D14 | "Recently added": meaning and scope     | First publication date, seeded from `created`. All types, with a filter. Bulk imports out   | D4      |
| D55 | Link-only changes after a rename        | Published with the renamed note, without a selection                                        | D4      |
| D41 | Reserved prefix for generated pages     | One short prefix, chosen after a check against all names and aliases                        | D42     |
| D11 | Markdown URL                            | Under the reserved prefix. `<url>.md` redirects to the page, as today                       | D41     |
| D50 | How a link to an unpublished note looks | "Not published" style on the text. Deny-listed targets show the alias or nothing            | D40     |
| D44 | One build or one per section            | One notes build. Split later, with a measured reason                                        | D2      |
| D16 | Search scope at the first release       | Notes only                                                                                  | D2      |
| D45 | Search limits                           | Accept no typo tolerance at first. Titles and aliases index first. Revisit with search data | D6      |
| D30 | Performance budgets                     | Numbers after the note page prototype. The default note page blocks a release               | D6      |
| D32 | Agent readiness at the first release    | Levels "Basics", "Markdown" and `llms.txt` of 9.16                                          | D3, D6  |
| D36 | Stacked pages                           | Right after the switch, before the other S stories                                          | D6      |
| D51 | Newsletter form                         | Fixed bar as today, plus one position inside long notes                                     | D6      |
| D31 | Ads: positions and fallback             | End of note and the fallback ad at the first release. Other positions after                 | D6      |
| D54 | Site name click and `Ctrl+G`            | Site name leads home. A visible graph button. No override of a browser shortcut             | D6      |
| D24 | Ghost slug inventory                    | In the baseline step, not in the blog phase                                                 | D1 + D5 |

### Round 3: tools and details

| Id  | Decision                 | First recommendation                                                                                | After |
| --- | ------------------------ | --------------------------------------------------------------------------------------------------- | ----- |
| D49 | Adopt check              | Evaluate `astro-loader-obsidian` and the Quartz transformers before writing the Markdown package    | D4    |
| D17 | Publishing tool          | CLI and the bridge first. Publication center plugin after the switch, from the plugin template      | D37   |
| D18 | Plugin for the community | Personal tool. Review after the store phase                                                         | D17   |
| D19 | Image optimization       | At build, cached by content hash                                                                    | D43   |
| D20 | Mermaid                  | SVG at build time, both themes                                                                      | D6    |
| D21 | External links           | Same tab, except ads                                                                                | D6    |
| D22 | Publication from a phone | Not in the first release                                                                            | D17   |
| D35 | Themes                   | Tokens from the first commit. One theme at the first release                                        | D7    |
| D27 | Gumroad script           | Drop it                                                                                             | none  |
| D28 | Issue tracker            | GitHub issues on this repository, with blocking links                                               | none  |
| D29 | Licenses                 | Code license and content license, before the first code lands                                       | none  |
| D53 | Canonical store host     | Fix now, in the store: one host and slash form in canonical tags, sitemap and `products-light.json` | none  |

### Round 4: later sections

| Id  | Decision                                      | First recommendation                                        | After   |
| --- | --------------------------------------------- | ----------------------------------------------------------- | ------- |
| D15 | Blog URLs                                     | Keep root-level slugs                                       | D1 + D5 |
| D23 | Articles: one page, on which section          | Blog section is canonical                                   | D15     |
| D48 | Comments on articles (Ghost shows them today) | To decide with the blog spec                                | D1 + D5 |
| D25 | Store migration                               | Static product pages, existing interactive parts as islands | D2      |
| D26 | Related notes                                 | Links and shared tags first                                 | D6      |
| D34 | Agentic commerce                              | Decide in the store phase                                   | D25     |

## 14. Ideas

`documentation/plans/ideas-backlog.md` holds all ideas: S1 to S74 from the first take, 1 to 158 from the ideation pass. Ideas that this spec already took in:

| Idea                                               | Where             |
| -------------------------------------------------- | ----------------- |
| Bulk import quarantine (backlog 92)                | 6.7, story 64     |
| Significant update flag (backlog 93)               | 6.7, story 63     |
| "Part of" chips (backlog 2)                        | 9.4, story 8      |
| Contextual backlinks (backlog 57)                  | Story 6           |
| "The data and my take" indexing rule (backlog 125) | 9.13.5, D46       |
| Indexable lists over thin notes (backlog 84, 85)   | 9.13.6            |
| Private link honesty (backlog 53)                  | Story 42, D50     |
| "Why this ad" (backlog 80)                         | 9.10.10           |
| Reader demand note (backlog 89)                    | Story 74          |
| Themes, stacked pages                              | Stories 44 and 34 |

## 15. Risks

### 15.1 Risk table

| Risk                                                       | Effect                                   | Answer                                                                             |
| ---------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------- |
| A private note, a private title or personal data goes live | Serious, and not reversible once crawled | Section 7, full-corpus gate, allow lists, tests that try to leak, takedown command |
| A URL form that works today is missed                      | Broken inbound links                     | Resolver, parity tests with variants, 404 report after the switch                  |
| A full build is too slow or too heavy                      | Slow publications                        | Prototype first, render cache, build outside shared servers                        |
| Crawler load after the switch                              | Origin overload                          | Hosting candidate B, or rate limits and tiered cache with A                        |
| Markdown on request serves the wrong format from the cache | Readers get Markdown                     | Rewrite before the cache, prototype                                                |
| A publication fails halfway                                | Manifest and site disagree               | `committed` and `deployed` states, repeatable publication                          |
| A half-synchronized vault looks like a mass removal        | Site emptied                             | Confirmation threshold, lock, vault check                                          |
| Search traffic drops after the switch                      | Fewer readers                            | Baseline, staged sitemaps, indexing rule, one metric                               |
| Thin pages lower the quality signals of the host           | Less search traffic                      | D46                                                                                |
| The publishing tool delays the switch                      | Publish stays slow longer                | Bridge (6.5)                                                                       |
| Ghost paths outside the sitemap break                      | Broken links in sent emails              | Full Ghost route inventory before the blog phase                                   |
| Ad matching defect becomes a contract                      | Irrelevant ads                           | Fix before the reference test                                                      |
| Scope grows without end                                    | Nothing ships                            | Switch gate list. Ideas go to the backlog                                          |
| Agent standards change                                     | Checks fail later                        | Generated discovery files, scanner run per release                                 |
| Images on the Publish host disappear                       | Broken images in old posts and emails    | Inventory before the cancellation                                                  |

### 15.2 Prototypes that decide

| Prototype                                        | Question                                                             | If the answer is bad                            |
| ------------------------------------------------ | -------------------------------------------------------------------- | ----------------------------------------------- |
| Full-size build (20,735 notes, real attachments) | Time and memory for a cold build, a one-note change, a layout change | Change the build design before any feature work |
| Resolver                                         | All variants in one redirect, with the real name patterns            | Hosting B becomes required                      |
| Markdown on request                              | Correct format behind the cache, for readers and agents              | Use a Markdown URL only                         |
| Global graph                                     | Usable on a phone with 20,000 nodes                                  | Lighter view, or desktop only                   |
| Music at build time                              | SVG output without a browser                                         | Keep browser rendering                          |

### 15.3 Kill criteria

1. The privacy audit of the whole corpus finds leaks that a machine cannot detect, at a rate that needs a person to review thousands of notes: the switch waits for that review.
2. Links cannot stay correct without private titles in the content store: the content store model changes before the publish core is written.
3. A one-note publication needs a full render, a full index and an upload of most files, and that is too slow for daily use: the build design changes.
4. The publishing tool blocks the switch: the bridge route ships the switch.

## 16. Working method

The build follows the skill flow of Matt Pocock (`mattpocock/skills`):

1. **Grill with docs**: interview in rounds on section 13. Terms go to `GLOSSARY.md`. Hard-to-reverse decisions with real trade-offs become ADRs in `documentation/adr/`.
2. **Prototype** when a question needs running code (15.2).
3. **To spec**: spec v2 from the settled decisions.
4. **To tickets**: tracer-bullet tickets with blocking links, as GitHub issues.
5. **Implement** each ticket in a fresh context, test first, with a code review.
6. **Retro** after each build session.

## 17. Follow-ups outside this repository

These happen in the vault. They are listed so that they are not forgotten.

1. At the end of the project: a note about this website in the infrastructure notes of the business.
2. At the end of the project: update the infrastructure notes about the notes website and the stats website. Check first whether such notes exist.
3. Update the publishing process note, the activity note of the public notes and the project note when the publishing workflow changes. Add this repository to the project note.
4. Update the list of consumers of `products-light.json` when a consumer changes or retires.
5. Retire or reduce `TPL Publish`, and change `TPL Stats` and the Ghost Publish plugin, before Obsidian Publish is cancelled.

## 18. Open flags from the planning session

| Flag | Kind      | What                                                                                                                          | Where it is handled                | Closes when                                                                     |
| ---- | --------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------- |
| F2   | Issue     | The current notes site serves an empty sitemap, status 200 for pages that do not exist, and a wrong canonical URL to crawlers | Problem 2, stories 75 and 76, 9.13 | The new site is live with correct canonical URLs, a full sitemap and a real 404 |
| F4   | Question  | The author must settle the root decisions                                                                                     | Section 13, round 1                | Interview rounds 1 and 2 are done                                               |
| F5   | Warning   | The `slug` of a vault note often differs from the live Ghost slug                                                             | D24, 9.13.7, 11.1 step 1           | The real slug of each article is written into its note                          |
| F6   | Follow-up | Infrastructure notes at the end of the project                                                                                | Section 17, items 1 and 2          | Those vault notes exist and are current                                         |
| F7   | Follow-up | Vault bookkeeping: add this repository to the project note                                                                    | Section 17, item 3                 | The project note lists the repository                                           |
| F8   | Warning   | Public person notes carry personal data of other people that the new site would make indexable                                | Section 7, 9.17, D40               | D40 is decided and the allow list for person notes is tested                    |
| F9   | Issue     | The first fact base was wrong about crawlers                                                                                  | Research 1.6, corrected            | Closed: corrected in the research                                               |
| F10  | Issue     | The main site links from its posts to a notes URL that is dead today                                                          | 5.4 acceptance test 3              | The dead targets have a decided redirect, or the links are fixed                |
| F11  | Issue     | Each store product link takes two redirects, and the store uses the redirecting host as canonical                             | D53                                | The store uses one host form everywhere                                         |
| F12  | Question  | The new flow turns `public_note` from a mirror into the trigger. Does the author accept that                                  | 6.2, D4                            | D4 is decided                                                                   |

F3 (browser test of the URL variants) is closed: the variants are verified and recorded in the research (1.6).

## 19. Review record

What the reviews changed in this document, compared with the first draft:

1. **Publication model**: the property was described as today's switch. It is a mirror today. The spec now states the inversion and its guards (6.2).
2. **Selection**: the first draft had no way to select notes at the first release. Three routes now exist, with the bridge as the first recommendation (6.5).
3. **Obsidian dependency**: query freezing, link resolution and note types need the running application. A publication now starts in Obsidian (6.4).
4. **Links**: they resolved at publication. They now resolve at build, so that a late publication or a takedown is reflected everywhere (9.2).
5. **Privacy**: properties passed through. They now need an allow list. New checks: frozen query rows, personal data, attachment metadata, forced removal, full-corpus runs. Takedown is a designed command (sections 6.8 and 7).
6. **URLs**: the encoding rule was incomplete, the variants were unverified, a static redirect map could not do one hop, generated pages could collide with notes, and `<url>.md` conflicts with today's behavior. Section 5.4 is rewritten around one resolver and a reserved prefix.
7. **Hosting and build**: `Vary: Accept` does not work behind the cache, the file count was far too low, the build is not incremental, the deployment was not atomic. Sections 5.5 and 5.6 are rewritten, with prototypes that decide.
8. **Search engines**: crawlers do see the notes today, with a wrong canonical URL. The switch repairs an index. A baseline, an indexing rule and a staged release are added.
9. **Scope**: "must" stories are split into a switch gate (G) and the first release (M). Tag pages, takedown, allowed properties and the stats tooling joined the gate. Stacked pages moved up.
10. **Ads and newsletter**: the newsletter form is a fixed bar today. Ad matching has a defect to fix first. Impressions and campaign parameters are added so that revenue can be measured.
11. **One build**: one build per section was dropped as a start, because its reason did not hold.
12. **Community plugin**: the claim of a gap was wrong. It is now a later decision.
13. **Public repository**: infrastructure details and private vault names were removed from all files.
