# Spec v2: the notes website and its publishing tool

- **Status**: approved by the author (decisions R18). It is adjusted during the build and the tests when needed. Last large change: the first version has two guards and no content check (ADR 0011, decisions R22).
- **Replaces**: `documentation/plans/spec-v1.md`, which stays as the record of the first take.
- **Scope**: the notes website and its publishing tool, and nothing else (ADR 0001).
- **Form**: the output of the "to spec" step of the working method. It keeps the sections of that template: Problem Statement, Solution, User Stories, Implementation Decisions, Testing Decisions, Out of Scope, Further Notes. It lives in the plans folder of this repository and is not published as an issue (`AGENTS.md`).
- **Next**: the prototypes of section 21, then tickets (tracer bullets with blocking links).
- **Ideas**: GitHub issues 1 to 13 and `documentation/plans/ideas-backlog.md` hold ideas that are not part of this plan. This spec names an issue where it leaves something open.
- **Rule**: no timing information in this plan.

## 0. How to read this spec

### 0.1 Sources and precedence

1. The ADRs (`documentation/adr/0001` to `0010`) and the decision log win over everything else. Where a later answer changed an earlier one, the later one wins.
2. The research files give the facts and the numbered items that the decisions refer to. A research item is a requirement where the decision log accepted it, alone or as part of a group.
3. Two parts of the research are used more widely, and each row names its source. The requirement list of the SEO research (its section F) is the base of section 12, because the author named that file as the requirements (decisions, round 2, requirement 3). The detailed design of the publishing tool study is used where it describes the first version that decision R5 settled. Later decisions change both, and a prototype can change the second.
4. Spec v1 holds only where nothing above changed it.

Source keys in this spec:

| Key         | File                                                              |
| ----------- | ----------------------------------------------------------------- |
| `decisions` | `documentation/plans/decisions.md`                                |
| `v1`        | `documentation/plans/spec-v1.md`                                  |
| `state`     | `documentation/research/2026-11-17-current-state.md`              |
| `hosting`   | `documentation/research/2026-11-17-hosting-options.md`            |
| `tool`      | `documentation/research/2026-11-17-publishing-tool-study.md`      |
| `seo`       | `documentation/research/2026-11-17-seo-and-ai-search.md`          |
| `sites`     | `documentation/research/2026-11-17-existing-sites-inspiration.md` |

"decisions D14" is row D14 of the decision log. "decisions consequence 22" is item 22 of its section "Consequences for spec v2". "seo item 179" and "sites item 255" are numbered items of the research files. "tool K12" is an id of the publishing tool study.

### 0.2 Ids, release labels and numbers

1. Every requirement has an id (`PUB-13`, `URL-03`), and every user story has a number that stays ("story 76"). A ticket cites the stories and the ids that it covers.
2. Release labels:
    - **G**: switch gate. It must be true before the notes domain moves.
    - **M**: first release. A must-have that follows right after the switch (decisions D6).
    - **W2**: second wave.
    - **Later**: decided as a direction, in no release yet.
3. The decision log often says "at the first release" and does not say if a feature is a condition of the switch gate. This spec gives the label G only where a source says so: a G story of spec v1 that is still in scope, ADR 0003, a G priority in the SEO research, or a decision that names the switch gate. Every other feature of the first release is M. The author confirms the split when the tickets are cut.
4. Where the decision log accepts an item and gives no release, the priority of the research item holds.
5. "To set from the prototype" marks a number that no decision gave. The prototype measures first, then the author sets the number.

### 0.3 Conflicts that this spec resolves

| Id  | Conflict                                                                                                                                                                                        | Resolution                                                                                                                                                                                                                     | Where      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| C1  | ADR 0002 makes the `public_note` property the intent. ADR 0008 reverses that part                                                                                                               | The property is the recorded state. The manifest says what is live. The tool never reads the property as an input and corrects it after each publication. The content store, the manifest and the review step of ADR 0002 stay | 8.2, 8.4   |
| C2  | Decision D17 says "one publish core with two hosts". ADR 0009 says two implementations                                                                                                          | The publishing logic exists two times, under the parity rule. The command line handlers of decision R5 become commands of the Rust command line program. The headless slice (tool K1) is that program                          | 7.3, 18.5  |
| C3  | Decision D12 lets an agent apply a publication plan "under the confirmation limits". Decision K6 removes the limits from the first version                                                      | The author settled it (decisions R16): an agent may publish alone new versions of notes that are already published. A first publication of a note, an unpublish and a takedown need the author. Issue 9 stays for size limits  | 8.6        |
| C4  | ADR 0010 hands the search ranking of some notes to the main site. The success metric (seo item 195) counts search clicks to the notes with own text                                             | The metric leaves out the notes whose original is on the main site. They are reported as their own group                                                                                                                       | 12.8       |
| C5  | Decision D33 refuses AI training on material of other people. No AI crawler is blocked at the first release (seo items 188 and 189)                                                             | The training rule is stated in the policy outputs only: response headers, `robots.txt` signals, the Markdown header block, the license line. It has no technical effect. Issue 8 keeps the question                            | 12.6       |
| C6  | The breadcrumb follows the type hub (seo item 184, accepted). Round 5 asks for breadcrumbs with folder notes and reopens that item                                                              | The author settled it (decisions R16): the breadcrumb follows the note type. Home, type hub, note. Folder notes are normal notes and are not in the breadcrumb. Breadcrumbs exist on all pages                                 | 11.2.4     |
| C7  | Finding 1 of the exploration proposed a canonical direction per note type. ADR 0010 sets one rule                                                                                               | The main site is the original of everything that also exists there, news posts included                                                                                                                                        | 12.2       |
| C8  | Decision D54 kept `Ctrl+G` for the graph. Round 5 changed it (sites item 147)                                                                                                                   | The graph opens with the sequence `g` then `g`, from a button and from the command palette. No key of the browser is taken                                                                                                     | 11.2.5     |
| C9  | Rules U2, U4 and U14 of spec v1 against seo items 174 and 175 and decision R20                                                                                                                  | 301 for syntax variants and bare file names, 302 for aliases only. A query never redirects. The stats are pages of the notes site, and the former stats host redirects to them                                                 | 10.1, 10.2 |
| C10 | Spec v1 dropped every property that is not on an allow list. The allow list is not decided (decisions consequence 11)                                                                           | No property is dropped at the first release: every property of a published note is public until an allow list exists (business rule 14). Issue 6 holds the allow list                                                          | 9.4        |
| C11 | Spec v1 kept Obsidian Publish updated during a rollback window, and the SEO research proposed end conditions. Decisions R6 and seo item 196 changed both                                        | Obsidian Publish is a frozen backup from the day of the switch. The author cancels it when he decides, with no condition and no metric                                                                                         | 19.4       |
| C12 | The exploration proposed that analytics never get the search text (sites item 272). The author decided the reverse (sites item 292)                                                             | The analytics receive the text of every search, and the page "what this site records" says so plainly                                                                                                                          | 13         |
| C13 | The publishing tool study assumes the intent property, confirmation limits and one core (tool R1, R3, GU4 to GU7, H33)                                                                          | ADR 0008, ADR 0009 and decision K6 win. The other parts of the study stand where no decision changed them                                                                                                                      | 7.3, 8     |
| C14 | The SEO research recommended to keep the current site name in titles at the switch (seo item 183). The author decided a new name from the first day                                             | Titles carry the new site name from the first day. The name is decided on the mockups, so it is a condition of the switch gate                                                                                                 | 12.1, 19.2 |
| C15 | Spec v1 and the first form of this spec had a privacy gate: automatic checks on the content of each note, with a blocked state and allow marks. The author removed it (ADR 0011, decisions R22) | The first version has two guards only: the deny list of folders and the `publish_ignore` property. A selected note that no guard excludes is published as it is in the vault. The checks are an idea for later (issue 15)      | 9          |

## 1. Problem Statement

### 1.1 For a reader of the site

1. A first visit downloads the whole site cache before any note shows. The wait grows with each published note, and the site holds more than 20,000 notes (state 1.1, 1.2).
2. A reader who searches often does not find a note. Search engines get a damaged picture of the site: a canonical URL that is cut at the first dot of the path, an empty sitemap, and status 200 for pages that do not exist (state 1.6).
3. A reader who asks an AI assistant gets little from the site. It offers no sitemap, no Markdown form of a note and no tool for an agent.
4. Reading aids are fragile or missing. Each custom feature (properties panel, ads, music notation) is a script that fights the renderer of Obsidian Publish (state 1.7). New ones cannot be added.

### 1.2 For the author

1. To publish is slow. The author waits for Obsidian before he can see what can be published, and the panel blocks the application. This is a major reason for the project (decisions, round 5, requirement 1).
2. The author drives Obsidian with AI assistants. The publishing step has no interface for them: no dry run, no plan to review, no result to read (state 1.9).
3. The author cannot tell what works. No count exists of how often an ad is seen, so no click rate exists (state 1.7).
4. The stack is rented and closed. The author wants a site and a publishing tool that he owns.

## 2. Solution

### 2.1 For a reader of the site

1. Each note is a static page. It shows at once and reads without JavaScript. Every link that works today continues to work.
2. Search with results as the reader types, a command palette, a graph, type hubs, tag pages, breadcrumbs and link cards make the notes easy to explore.
3. Search engines and AI agents get correct signals, a Markdown form of each note and a remote MCP server, so that the notes are found and cited.

### 2.2 For the author

1. The author continues to write in Obsidian and decides there what is published, skipped or unpublished. A publication center shows the publication queue fast and never blocks Obsidian.
2. The publishing tool is his own, with four faces: an Obsidian plugin, a Rust command line program, an MCP server and a skill. The author, or an AI assistant that the author started, drives a publication.
3. A git commit and push is enough to put content online. The build runs behind the scenes.
4. The author selects every note that is published. Two guards say "never": a deny list of folders and the `publish_ignore` property. The `public_note` property shows what is live.
5. The site is a static site that the author owns, built with Astro, TypeScript and Tailwind from a content store. It replaces Obsidian Publish on the same host.
6. The main site and the store stay as they are, on their own hosts (ADR 0001).

## 3. Goals, non-goals, principles

### 3.1 Goals

| Id      | Goal                                                                                                                            | Source                               |
| ------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| GOAL-01 | A note page loads as plain HTML and is readable without JavaScript                                                              | v1 3.1                               |
| GOAL-02 | Every URL that works today works after the switch: same URL, or one redirect                                                    | ADR 0005, decisions D42              |
| GOAL-03 | Feature parity with the current notes site at the switch, then more                                                             | v1 3.1, decisions D6                 |
| GOAL-04 | Publishing stays a decision per note, made in Obsidian, with a review step. Nothing goes live by itself                         | ADR 0002, ADR 0008                   |
| GOAL-05 | To see what can be published, to select and to start a publication is quick and never blocks or slows Obsidian                  | decisions, round 5, requirement 1    |
| GOAL-06 | A note that the author did not select, or that a guard excludes, never reaches the content store, the site or this repository   | business rules 2 to 4, ADR 0011      |
| GOAL-07 | Search engines and AI answers find the notes. Search traffic to the notes with own text reaches the level of January 2026 again | decisions R10, round 2 requirement 3 |
| GOAL-08 | The site is ready for agents: all agent-facing parts and a remote MCP server exist at the first release                         | decisions D32                        |
| GOAL-09 | Ads and newsletter signups work at least as well as today, and the author can see what works and what leads to sales            | decisions D31, R12                   |
| GOAL-10 | The switch of the domain is one DNS change                                                                                      | v1 3.1                               |
| GOAL-11 | Performance is a release criterion, for the pages and for the publishing tool                                                   | decisions D30, consequence 22        |
| GOAL-12 | An AI can drive the whole publication process through the command line program or the MCP server                                | decisions, round 5, requirement 3    |

### 3.2 Non-goals

1. Any change to the main site or to the store (ADR 0001).
2. One host name for everything (decisions D1).
3. A bridge through Obsidian Publish, in any form (ADR 0003).
4. Accounts, limited access and paid content on the site (issue 1).
5. A publishing plugin for the community. The tool is for the author first, with a review after the switch (decisions D18).
6. Publication from a phone (decisions D22).
7. A shorter URL form (ADR 0005).

Section 24 has the full list.

### 3.3 Principles

1. **Static first**. HTML at build time. JavaScript only where a feature needs it, loaded when used.
2. **The vault is the only source**. No content is written in this repository.
3. **The author selects, the guards exclude**. Nothing is published that the author did not select. A deny list folder or the `publish_ignore` property always wins. The first version runs no content check on a selected note (ADR 0011).
4. **One cleaned note per note**. The page, the Markdown form, the search index and the files for agents all derive from it. Nothing reads the vault after the publication.
5. **Deep modules**. A lot of behavior behind a small interface, testable alone with the fixture vault.
6. **Contracts are tested**. The guards, the URL contract, the parity rule, the shape of the store catalog and the performance budgets each have a test that blocks a release.
7. **Measure first**. A baseline exists before the switch. "Better" needs a number.
8. **Prototype the risky parts** before tickets are cut (section 21).
9. **The interactive part comes first**. Work that takes long runs in the background (decisions, round 5, requirement 1).

## 4. Vocabulary

`GLOSSARY.md` holds the domain language, and this spec uses its terms exactly. Terms that this spec needed and added there: publication plan, publication report, cleaned note, rename journal, generated page, reserved prefix, type hub, link card, store catalog, URL contract, fixture vault.

Two words that are not glossary terms:

1. **Markdown form**: the cleaned note of a published note, served as Markdown.
2. **Preview host**: a host that serves the new site while the old site stays live. It is never indexed.

## 5. User Stories

### 5.1 How to read the stories

1. Actors: a reader of the site, the author, an AI assistant that the author started to drive the publishing tool, a search engine or an AI agent that reads the site. "The author" also covers his roles as business owner and operator.
2. The label in brackets is the release of section 0.2: G, M, W2 or Later.
3. The numbers are stable. A new story gets the next free number. Section 25.3 maps the story numbers of spec v1 to these.
4. A story says what an actor needs. The requirement tables of sections 7 to 19 say how it is met.

### 5.2 Reader: reading a note

1. (G) As a reader, I want a note to show at once, so that I do not wait for the site to load.
2. (G) As a reader, I want to read a note without JavaScript, so that the site works in any browser and reader tool.
3. (G) As a reader with an old link, I want it to open the right note, so that links in articles and newsletters keep their value.
4. (G) As a reader, I want wikilinks, embeds, images, tables, callouts, code, footnotes, math and diagrams to render as in Obsidian, so that a note looks as its author wrote it.
5. (G) As a reader, I want to see the properties of a note in a tidy panel, so that I get its metadata at a glance.
6. (G) As a reader, I want to see which notes link to this note, with the sentence around each link, so that I can explore in both directions.
7. (G) As a reader, I want an outline of the note, so that I can jump to a section.
8. (M) As a reader on a small screen, I want a bar that shows the current section, so that I know where I am in a long note.
9. (G) As a reader, I want the created and updated dates of a note near the title, so that I know how fresh it is.
10. (G) As a reader, I want to see that a link target is not published, so that plain text in the middle of a sentence does not look like a mistake.
11. (G) As a reader of a music note, I want chord diagrams, tabs and scores to render and to play, so that I can learn the piece.
12. (G) As a reader, I want a dark and a light mode that follow my system and that I can switch, so that the page is comfortable to read.
13. (G) As a reader on a phone, I want the layout, the navigation and the search to work on a small screen, so that I can read anywhere.
14. (M) As a reader, I want an "In short" box under the title, so that I get the answer of the note first.
15. (M) As a reader of a media note, I want the key facts and the opinion of the author first, so that I see what only this site has.
16. (M) As a reader, I want a `LINK` line to show as a card with the title, the site name and a small image, so that I can judge a source before I open it.
17. (M) As a reader, I want a video to show as a card that loads the player only when I press play, so that no other site tracks me before I choose.
18. (M) As a reader, I want a reading progress bar, so that I see how far I am in a note.
19. (M) As a reader, I want a link button on each heading, so that I can share a section.
20. (M) As a reader, I want to download a note as Markdown, so that I can keep it in my own vault.
21. (M) As a reader, I want to copy a note as Markdown, so that I can paste it into my notes or an AI chat.
22. (M) As a reader, I want a copy button on code blocks, a scroll box for wide tables, galleries and image captions, so that technical notes are easy to use.
23. (M) As a reader of a French note, I want the page marked as French and linked to its English twin, so that I get my language.
24. (M) As a reader, I want to see a clear line on a note that an AI wrote, so that I know how much to trust it.
25. (M) As a reader, I want a line with a link when a note first appeared on the main site, so that I can read it in its first home.
26. (M) As a reader, I want a "cite this note" block with the license, so that I can quote the note in the right way.
27. (M) As a reader, I want a share row, so that I can send a note to another person.
28. (M) As a reader, I want one line of context on each page (whose site this is, what a note is, where to start), so that I am not lost when I arrive from a search.
29. (M) As a reader who uses a keyboard or a screen reader, I want a skip link, visible focus and dialogs that return the focus, so that I can use every feature.
30. (M) As a reader who asked for less motion, I want the site to stop its animations, so that the page does not disturb me.

### 5.3 Reader: finding notes

31. (G) As a reader, I want full-text search with results as I type, so that I find a note fast.
32. (M) As a reader, I want to filter search results by note type and tag, so that I narrow a large result list.
33. (M) As a reader, I want a command palette that opens with `/` or `Ctrl+K`, so that I reach any note or command from the keyboard.
34. (M) As a reader, I want a sheet with the keyboard shortcuts that opens with `?`, so that I can learn them.
35. (M) As a reader, I want to open a random note from the palette, so that I discover notes by chance.
36. (M) As a reader, I want to report a problem with a note from the palette, so that the author can fix it.
37. (G) As a reader, I want a global graph that I can zoom, filter and search, so that I see how the notes connect.
38. (G) As a reader, I want a local graph of the note, so that I see its neighborhood.
39. (M) As a reader, I want to open the graph with a button, from the palette, or with `g` then `g`, so that no shortcut of my browser is taken.
40. (G) As a reader, I want a home page with a search, entry points by topic and by note type, and the recent notes, so that I know where to begin.
41. (G) As a reader, I want a hub page per note type, so that I can browse all notes of one kind.
42. (M) As a reader, I want the media notes in a library section with covers, ratings and status, so that I can browse them like a collection.
43. (G) As a reader, I want a tag to lead to a page with its notes, so that I can follow a topic.
44. (G) As a reader, I want a page with the recently added notes, so that I see what is new.
45. (G) As a reader, I want a page with the recently updated notes, so that I see what changed.
46. (M) As a reader, I want a breadcrumb on every page (home, type hub, note), so that I know what kind of note I read and can go up.
47. (M) As a reader, I want to see the maps of content that hold a note ("part of"), so that I can go to its topic.
48. (M) As a reader, I want related notes under a note, so that I can continue to read.
49. (M) As a reader of a note that belongs to an ordered set, I want a strip with "you are here", so that I can read the set in order.
50. (M) As a reader, I want a complete index of all notes, so that every note is a few links away.
51. (M) As a reader, I want RSS feeds (all notes, per note type, per tag) and a page that lists them, so that I can follow the site in my reader.
52. (M) As a reader, I want a folder tree, so that I can browse the notes by their place in the vault.
53. (M) As a reader, I want internal links to open at once, so that browsing feels instant.
54. (G) As a reader, I want a useful 404 page with search, so that a wrong link is not a dead end.
55. (G) As a reader, I want the stats page of the notes, so that I see how the site grows.
56. (M) As a reader, I want a footer with links to the main site and to the store, so that I can find the other sites of the author.
57. (W2) As a reader, I want stacked pages, where a click on a link opens the note in a new column next to the open ones, so that I keep my context. The current site has this.
58. (W2) As a reader, I want curated lists with an intro of the author (for example the owned games by mechanic), so that I find the best notes of a kind.
59. (W2) As a reader, I want a link library with every link card of the site, so that I can browse the sources that the author reads.
60. (W2) As a reader, I want to choose a second theme, `classic`, with a light and a dark mode, so that the site looks as I like.

### 5.4 Reader: newsletter, ads and products

61. (G) As a reader, I want the newsletter bar to wait until I read a part of the note, to leave before the footer and to stay closed after I signed up, so that it does not cover what I read.
62. (M) As a reader of a note about a product, I want a buy box with the name, the price and a button at the top, so that I can get the product without a search.
63. (M) As a reader, I want an ad to show one product and one free resource for the topic of the note, so that I have one clear next step and a free way in.
64. (M) As a reader, I want a "why this ad" link and a page that says what the site records, so that I can trust the site.
65. (Later) As a customer of the PKM Library, I want to log in and read it on the notes site, so that the product and the notes are one place. Later: it waits for the login (issue 1).

### 5.5 Author: publishing

66. (G) As the author, I want to see in Obsidian what can be published, fast and without a block of Obsidian, so that publishing does not stop my writing.
67. (G) As the author, I want to select the candidates to publish in the view of the tool, so that no property and no script can publish a note for me.
68. (G) As the author, I want to review the lists of new, changed, to remove and unchanged notes before anything goes live, so that I know what a publication does.
69. (G) As the author, I want to select which changes go live and to skip the others, so that a note that is not ready keeps its live version.
70. (G) As the author, I want changed notes and removals selected by default and new candidates never selected, so that the common case is one click and a new note never goes live by accident.
71. (G) As the author, I want text and folder filters in the publication queue, so that I find a note among many candidates.
72. (G) As the author, I want a dry run that shows the publication plan and writes nothing, so that I can check before I publish.
73. (G) As the author, I want to unpublish a note, so that it leaves the site with the next publication.
74. (G) As the author, I want to take a note down fast and completely, with everything derived from it, so that a mistake or a request of a person is handled at once.
75. (G) As the author, I want a deny list of folders whose notes can never be published, whatever I do, so that private parts of the vault stay private.
76. (G) As the author, I want an ignore property (`publish_ignore`) on a note, so that I can say "never publish this note" on the note itself.
77. (G) As the author, I want the `public_note` property to show which notes are live, written by the tool only and corrected when it is wrong, so that my other tools can trust it.
78. (G) As the author, I want a new note that carries the property by mistake to stay private, so that an assistant or a template cannot publish a note.
79. (G) As the author, I want a note that was never published to stay private until I select it, so that nothing new appears on the site without me.
80. (G) As the author, I want a published note that enters a deny list folder or gets `publish_ignore` to be removed by the next publication without a selection, so that a move into a private folder is enough.
81. (Later) As the author, I want a published note whose new version fails a content check to keep its live version, so that a problem in an edit does not remove the page. Later: the content checks are issue 15 (ADR 0011).
82. (G) As the author, I want a link to a note that is not published to show as plain text and to lead to no page, so that no reader lands on a page that does not exist.
83. (G) As the author, I want only the attachments that published notes use to be published, so that no other file of the vault goes live.
84. (G) As the author, I want Dataview results frozen into the published note, so that lists work on the site.
85. (G) As the author, I want Meta Bind buttons and query markers removed from the page, and comments not shown on it, so that a note reads as in Obsidian.
86. (Later) As the author, I want a check for secrets and personal data before a publication, so that a key or an address does not go live. Later: issue 15 (ADR 0011).
87. (G) As the author, I want a renamed or moved note to keep its old URL as a redirect, so that I can reorganize the vault without broken links.
88. (G) As the author, I want to confirm a pairing when a note was renamed while Obsidian was closed, so that the old URL still becomes a redirect.
89. (G) As the author, I want the notes that changed only in a link after a rename to be published with the renamed note, so that I do not select them one by one.
90. (G) As the author, I want a publication to continue in the background while I write, so that I never wait for it.
91. (G) As the author, I want a git commit and push to be enough to put content online, so that the build needs no machine of mine.
92. (G) As the author, I want a publication to finish with a clear report (live with URLs, failed, warnings), so that I know the result.
93. (G) As the author, I want a failed publication to leave a state that I can see and repeat safely, so that a failure never leaves half of a publication live.
94. (G) As the author, I want the state of the open note in the status bar, so that I see if it is live, changed or not published.
95. (G) As the author, I want to publish from a command line with Obsidian closed, on Linux and on Windows, so that I do not depend on the application.
96. (G) As the author, I want publishing to be an opt-in per device, so that a new machine cannot publish before I allow it.
97. (G) As the author, I want two devices to be unable to publish at the same moment, so that the content store stays consistent.
98. (G) As the author, I want the first publication to keep the dates of my notes, so that the day of the switch does not make every note "new".
99. (G) As the author, I want the content store to be private, so that the history of unpublished notes is not public.
100.    (G) As the author, I want search engines to index every note, with an override per note, so that all my notes can be found.
101.    (M) As the author, I want a diff per note in the publication center, so that I see what readers will see.
102.    (M) As the author, I want a history of publications, more filters and file menus, so that the tool covers my daily cases.
103.    (M) As the author, I want only real edits to move a note up in "recently updated", so that the list shows real news.
104.    (M) As the author, I want a bulk import to stay out of the feeds and the recent pages, so that a large import does not flood them.
105.    (M) As the author, I want warnings for missing descriptions, missing alternative text and very large images, so that I can improve notes over time.
106.    (M) As the author, I want the publication report to count the stubs per note type and to list the notes without a verified URL on the main site, so that I know what to fix.
107.    (M) As the author, I want images optimized at build time, so that I do not prepare them by hand.
108.    (M) As the author, I want a local preview of the site, so that I can check a page before a publication.
109.    (M) As the author, I want a license line on each note, by a rule per note type or folder, so that readers know what they may do.
110.    (M) As the author, I want to set per note "no ad" or named products, so that I control the ad on a special note.

### 5.6 AI assistant that drives the publishing tool

111. (G) As an AI assistant that the author started, I want a `status` command, so that I know the state of the publication queue.
112. (G) As an AI assistant that the author started, I want a `plan` command that returns a publication plan with an id and writes nothing, so that I can show the author what would change.
113. (G) As an AI assistant that the author started, I want a `publish` command that applies exactly one plan by its id, so that I can publish alone the new versions of notes that are already published, and nothing that the plan did not show.
114. (G) As an AI assistant that the author started, I want to name in a plan the notes that the author asked me to publish for the first time or to unpublish, so that such a change happens only when the author named the note or confirmed it in the view.
115. (G) As an AI assistant that the author started, I want a clear answer when a plan is stale, a guard excludes a note or the device is not allowed, so that I can report it and stop.
116. (G) As an AI assistant that the author started, I want the same operations through an MCP server and through the command line program, so that I can use the one that my environment offers.
117. (G) As an AI assistant that the author started, I want a skill that explains the publication process, so that I drive it the way the author wants.
118. (G) As an AI assistant that the author started, I want a `takedown` command, so that I can remove a note at once when the author named it.

### 5.7 Search engines and AI agents

119. (G) As a search engine, I want a unique title, a description and a correct canonical link on each page, so that I index the right URL.
120. (G) As a search engine, I want sitemaps under one sitemap index, a correct `robots.txt`, and a real 404 status for pages that do not exist, so that I crawl the site well.
121. (G) As a search engine, I want every other form of a URL to reach the canonical URL in one redirect with the right code, so that I keep one URL per note.
122. (G) As a search engine, I want a note that also exists on the main site to name the post there as the original, so that I rank one page.
123. (G) As a search engine, I want the text of a note in the HTML that the server sends, so that I can read it without scripts.
124. (G) As a search engine, I want a 304 answer for an unchanged page and never a block or a rate limit, so that I can crawl the whole site.
125. (G) As a search engine, I want a notice of the new, changed and removed URLs at each publication, so that my index is current.
126. (G) As a social network, I want Open Graph and Twitter card tags with an image, so that a shared note shows a good preview.
127. (M) As a search engine, I want structured data that fits the note type, with breadcrumb data, one author entity and the ratings of the author as reviews, so that I understand the page.
128. (M) As a search engine, I want an author page with profile markup, so that I connect the notes to their author.
129. (M) As a search engine, I want the sources of a note as citations and its videos as video data, so that I see what a note builds on.
130. (M) As a search engine, I want a French note and its English twin to point to each other, so that I show the right language.
131. (M) As an AI agent, I want the Markdown of a page when I ask with `Accept: text/markdown`, so that I read a note at low cost.
132. (M) As an AI agent, I want the raw Markdown of each note at a stable URL, and `llms.txt` as a small index, so that I can find and fetch notes.
133. (G) As an AI agent, I want `robots.txt` to state what I am allowed to do, so that I follow the rules of the author.
134. (M) As an AI agent, I want each response to state its content class and its training rule, so that I know that material of other people is not for training.
135. (M) As an AI agent, I want `Link` headers that point to the sitemap, the Markdown form and the feeds, so that I discover them from any page.
136. (M) As an AI agent, I want an API catalog, an agent skills index, an MCP server card and an ARD manifest, so that I discover the tools of the site.
137. (M) As an AI agent in a browser, I want the page to register tools (search notes, get this note as Markdown), so that I can act for the reader.
138. (M) As an AI agent, I want a remote MCP server with a `search` and an `execute` tool, without a login, so that I can query the notes with one short script.
139. (M) As an AI agent, I want a clear error when the daily budget or a limit of the MCP server is reached, so that I can stop and tell the person.
140. (M) As an AI agent, I want a visible mark and markup on a note that an AI wrote, so that I weigh it correctly.

### 5.8 Author: business

141. (G) As the author, I want an ad at the end of a note that matches its topic, at least as good as today, so that readers find my products.
142. (G) As the author, I want no ad on a note because one word of its title matched a product, so that ads stay relevant.
143. (G) As the author, I want Plausible analytics with the current site id and the `cta_clicked` event, so that my numbers stay comparable.
144. (G) As the author, I want a baseline of search traffic, ad clicks and signups before the switch, and the same numbers after it, so that "better" is a number.
145. (G) As the author, I want the Knowii brand on every page, so that my sites look like one family.
146. (G) As the author, I want the ads to read the store catalog, with a test of its shape, so that a product change in the store shows on the notes without a copy.
147. (G) As the author, I want the stats page and the stats tooling to keep working at the switch, so that I lose no data.
148. (M) As the author, I want several ad positions (end of note, side column, inside long notes), each tracked apart, so that I learn which position works.
149. (M) As the author, I want to count how often an ad is seen, so that I can compute a click rate.
150. (M) As the author, I want a fallback ad for the newsletter or a free resource when no product matches, so that no note ends without a next step.
151. (M) As the author, I want an offer map that I set by hand (topic to product and free resource), so that my choice wins over the matching score.
152. (M) As the author, I want live prices from the store catalog, so that a price change needs no publication of the notes.
153. (M) As the author, I want no ad on stubs, person notes and quote notes, so that thin pages stay clean.
154. (M) As the author, I want links to the store to carry campaign parameters and to reach the product page without a redirect, so that I see which note led to a sale.
155. (M) As the author, I want a newsletter position inside long notes and a dialog for a reader who leaves, so that more readers subscribe.
156. (M) As the author, I want events for search, downloads, graph use, signups, outbound links, link cards, scroll depth and the palette, under one naming rule, so that I see what works and what does not.
157. (M) As the author, I want the text of every search in the analytics, so that I learn what readers look for and do not find.
158. (M) As the author, I want to see a change of the store catalog before it breaks an ad, so that prices on the notes are never wrong.
159. (M) As the author, I want search clicks to the notes with my own text as the success metric, with the thin types and the notes whose original is on the main site counted apart, so that I judge the switch on the right pages.

### 5.9 Author: operations

160. (G) As the author, I want a preview host with the new site while the old one stays live, so that I can test before the switch.
161. (G) As the author, I want an automated URL parity test, with the variants and the first redirect list, so that no link breaks at the switch.
162. (G) As the author, I want the switch to be one DNS change, with Obsidian Publish as a frozen backup that I cancel when I decide, so that I can go back if the new site is broken.
163. (G) As the author, I want a deployment to be one switch between releases, with a revert command, so that a bad release is undone at once.
164. (Later) As the author, I want the build to check the content store a second time, so that a leak cannot pass. Later: issue 15 (ADR 0011).
165. (G) As the author, I want CI to fail when a page type exceeds its performance budget, so that the site stays fast.
166. (G) As the author, I want the publishing tool to have speed budgets that are measured on the real vault, so that it stays fast as the vault grows.
167. (G) As the author, I want parity tests of the two implementations to block a release, so that the plugin and the command line program never disagree.
168. (G) As the author, I want the same resolver to run on a plain server, so that I can leave the hosting provider.
169. (M) As the author, I want a link check and an HTML check in CI, so that broken pages do not ship.
170. (M) As the author, I want a Content Security Policy that is as strict as the features allow, so that the site is safe for readers.
171. (M) As the author, I want crawlers, also AI crawlers, to be unable to overload the site, so that readers are always served.
172. (M) As the author, I want a rate limit and a daily budget on the remote MCP server, so that an anonymous caller cannot create a large bill.
173. (M) As the author, I want a contrast gate and a theme lab page, so that a theme cannot ship unreadable text.
174. (M) As the author, I want build and deployment reports, so that I can see what a release changed.
175. (M) As the author, I want the 404 report after the switch to feed the redirect list, so that missed URLs get a redirect.

### 5.10 Added after the answers of the author

176. (G) As the author, I want an AI assistant to publish alone only new versions of notes that are already published, and to need me for a first publication, an unpublish and a takedown, so that nothing new appears and nothing leaves the site without me.
177. (G) As the author, I want the command line program to publish a frozen list as it is saved when Obsidian is closed, with a mark "lists not refreshed" in the plan, so that I can publish without the application and know what was not refreshed.
178. (Later) As the author, I want my own addresses and domains allowed from the start in a check for secrets and personal data, so that the check does not stop me for harmless text. Later: issue 15 (ADR 0011).
179. (Later) As the author, I want to feature notes with a property, so that the home page gets a "start here" part (issue 2).
180. (G) As the author, I want an AI assistant to read and edit the guards through the command line program and the MCP server, alone when the edit makes the tool stricter (add a deny list folder, set `publish_ignore`) and with my confirmation when it makes it looser, so that an AI can help me and cannot open a private folder.
181. (G) As a reader, I want a page that tells me that a note was removed, and a page that tells me that the site has a problem, each with a way to go on, so that an error answer is not a dead end (decisions R24, issue 62).

## 6. Implementation Decisions

The decisions are in sections 7 to 17 and 19 to 23. This section names the modules and their interfaces in words. No file path and no code is given, because both go out of date.

### 6.1 Modules

| Id     | Module                   | What it hides                                                                                                                                             | Interface, in words                                                                                                                                                                                                                 |
| ------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MOD-01 | Publishing logic         | Change detection, the guards, the cleaning step, the write to the content store, the correction of the property                                           | In: a state of the vault, the manifest, the configuration of the tool, a selection. Out: a publication plan as data. On apply: cleaned notes, manifest entries and the list of property corrections. It exists two times (ADR 0009) |
| MOD-02 | Guards                   | The deny list of folders and the `publish_ignore` property                                                                                                | In: the path and the properties of a note, the configuration of the tool. Out: excluded or not. Nothing reads the content of a note                                                                                                 |
| MOD-03 | Cleaning step            | What is removed for rendering (Meta Bind code, query markers) and how each link and embed is resolved to the path of a note. It is rendering, not privacy | In: a selected note. Out: one cleaned note and the list of its attachments                                                                                                                                                          |
| MOD-04 | URL function             | The encoding rule of the canonical URL                                                                                                                    | In: the path of a note or the id of a generated page. Out: its canonical URL. Every output uses it                                                                                                                                  |
| MOD-05 | Resolver                 | Variants, precedence, former paths, the redirect list                                                                                                     | A pure function. In: a requested path and the resolver map. Out: the page to serve, a redirect with its code, "gone", or "not found" with suggestions                                                                               |
| MOD-06 | Link index               | Links, backlinks, neighbors, graph data                                                                                                                   | In: the cleaned notes and the manifest. Out: for a note, its links, its backlinks with context and its neighbors                                                                                                                    |
| MOD-07 | Markdown conversion      | Every Obsidian form, link cards included                                                                                                                  | In: a cleaned note, the link index, the link card cache. Out: the HTML of the content and the Markdown form                                                                                                                         |
| MOD-08 | Site build               | Layouts per note type, generated pages, the search index, feeds, sitemaps, structured data, files for agents                                              | In: the content store, the stats data, the link card cache, the store catalog. Out: the static site, the resolver map and the data of the remote MCP server                                                                         |
| MOD-09 | Edge adapter             | The hosting platform                                                                                                                                      | In: a request. It calls the resolver, selects the HTML or the Markdown form and sets the headers. A second adapter serves the same output from a plain server                                                                       |
| MOD-10 | Remote MCP server        | The executor, the limits, the data access                                                                                                                 | Two tools, `search` and `execute`, over a typed interface of the notes: search, get a note, backlinks, neighbors, recent notes, tags                                                                                                |
| MOD-11 | Ad selection             | The matching rules, the offer map, the exclusions                                                                                                         | In: a note (type, topics, tags), the offer map, the store catalog. Out: per position, one product and one free resource, or the fallback ad, or nothing                                                                             |
| MOD-12 | Catalog reader           | The shape of the store catalog                                                                                                                            | In: the store catalog. Out: validated product data, or a clear failure                                                                                                                                                              |
| MOD-13 | Command registry         | Commands, keys and scopes                                                                                                                                 | One list of commands. The command palette, the key handler, the shortcuts sheet and the tools for agents read it                                                                                                                    |
| MOD-14 | Event dictionary         | Event names and properties                                                                                                                                | One list of events. The analytics calls and the page "what this site records" read it                                                                                                                                               |
| MOD-15 | Design tokens and themes | Colors, fonts, shapes, motion                                                                                                                             | A theme is one set of token values with a light and a dark mode. Components use tokens only                                                                                                                                         |
| MOD-16 | Faces of the tool        | The view, the commands, the MCP server, the skill                                                                                                         | Thin layers over MOD-01. No rule of the publishing logic lives in a face                                                                                                                                                            |

### 6.2 Where the decisions are

| Section | Holds                                                                                  |
| ------- | -------------------------------------------------------------------------------------- |
| 7       | Architecture: vault, publishing tool, content store, build, hosting, remote MCP server |
| 8       | Publication flow under ADR 0008                                                        |
| 9       | Guards                                                                                 |
| 10      | URL contract and redirects                                                             |
| 11      | Site features by release                                                               |
| 12      | SEO and AI search                                                                      |
| 13      | Analytics and events                                                                   |
| 14      | Ads and the store relationship                                                         |
| 15      | Design                                                                                 |
| 16      | Performance and speed                                                                  |
| 17      | Security, licenses and legal                                                           |
| 19      | Migration and switch                                                                   |
| 20      | Dependencies outside this project                                                      |
| 21      | Prototypes that decide                                                                 |
| 22      | Risks                                                                                  |
| 23      | Open decisions                                                                         |

## 7. Architecture

### 7.1 Flow

```
Vault (private)
   |  publishing tool: find what changed, guards, select, clean
   |  faces: plugin, Rust command line program, MCP server, skill
   v
Content store (private git repository)      Attachment storage (object storage)
   cleaned notes, manifest,                  attachments, addressed by content hash
   configuration of the tool
   |  a git push starts the build in CI
   v
Build: link index, pages, Markdown forms, search index,
       feeds, sitemaps, files for agents, resolver map, data of the MCP server
   |  deployment: one new release, one switch
   v
Hosting: static files, resolver and Markdown on request at the edge
   |                                   |
   v                                   v
reader, crawler, agent              remote MCP server of the site
```

### 7.2 Parts

| Id     | Part                              | Role                                                                                                                                                | Source                                 |
| ------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| ARC-01 | Vault                             | The only source of content. It never leaves the machines of the author                                                                              | `GLOSSARY.md`                          |
| ARC-02 | Publishing tool                   | Finds what changed, applies the guards, cleans the notes for rendering, writes the content store, corrects the `public_note` property (section 7.3) | ADR 0003, ADR 0008, ADR 0009, ADR 0011 |
| ARC-03 | Content store                     | The private snapshot of everything that is published (section 7.4)                                                                                  | ADR 0002, ADR 0006                     |
| ARC-04 | Attachment storage                | Object storage that holds the attachments by content hash                                                                                           | decisions D9, D3                       |
| ARC-05 | Build                             | Turns the content store into the site, in CI after a push of the content (section 7.5)                                                              | decisions D43, R16                     |
| ARC-06 | Hosting                           | Serves the site, runs the resolver and Markdown on request (section 7.6)                                                                            | decisions D3                           |
| ARC-07 | Remote MCP server of the site     | A public service for agents with the tools `search` and `execute` (section 7.7)                                                                     | decisions D32, Q7, Q8                  |
| ARC-08 | Stats pages                       | Pages of the notes site under the reserved prefix, built at each publication. The former stats host answers with one redirect to them               | decisions R20                          |
| ARC-09 | Store catalog (outside the scope) | The product data that the store publishes. The site reads it. Its shape is a contract (section 14.2)                                                | decisions, round 5, req. 2             |
| ARC-10 | Main site (outside the scope)     | The original of every note that also exists there (section 12.2)                                                                                    | ADR 0010                               |

### 7.3 Publishing tool

Four faces (ADR 0009, decisions round 5, requirement 3):

| Id      | Face                      | What it is                                                                                                                                                                                                                                                                                                    |
| ------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TOOL-01 | Obsidian plugin           | Built from the author's plugin template. Its code lives in this repository (decisions D17). Desktop only. It holds the publication center, the status of the open note, the rename journal and the refresh of frozen lists                                                                                    |
| TOOL-02 | Rust command line program | Runs on Linux and Windows with Obsidian closed. It follows the model of the command line program of the Obsidian Starter Kit plugin. Its code lives in this repository from the start, next to the plugin code (decisions R19). It is the headless slice: it comes first and runs on the real vault (tool K1) |
| TOOL-03 | MCP server                | Gives an AI the same operations. What the MCP server can do, the command line program can do, and the reverse. Both faces host it with the same tools: the plugin when Obsidian runs, the Rust program when Obsidian is closed                                                                                |
| TOOL-04 | Skill                     | Instructions with which an AI drives a publication through the command line program or the MCP server                                                                                                                                                                                                         |

Rules:

| Id      | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Source                                              |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| TOOL-05 | The publishing logic exists two times: in TypeScript inside the plugin, and in Rust inside the command line program. The logic is: find what changed, apply the guards, clean the notes, write the content store, correct the `public_note` property                                                                                                                                                                                                                                                                                             | ADR 0009, ADR 0011                                  |
| TOOL-06 | Parity rule: for the same state of the vault, the same manifest, the same configuration of the tool, the same selection and the same time of the run, both implementations give byte-identical output under a written canonical form. The output is: the publication plan as data without its id and its time, the cleaned notes, the manifest. The parity rule of the Obsidian Starter Kit plugin is the model. Parity tests on the fixture vault block a release, and a parity run on the real vault is a condition of the switch gate (SW-19) | ADR 0009                                            |
| TOOL-07 | Both implementations resolve links and note types with the same result. The Rust program cannot ask Obsidian, so the rules are written out and tested in both                                                                                                                                                                                                                                                                                                                                                                                    | follows from ADR 0009                               |
| TOOL-08 | The command line program and the MCP server can build a selection, so that an AI can drive the whole process. `status` shows the publication queue. `plan` accepts paths to include, paths to hold and paths to remove, and returns a publication plan with an id. The plan is stored outside the vault. `publish` applies exactly one plan by its id. `unpublish` and `takedown` exist too. The exact syntax follows the model of TOOL-02                                                                                                       | decisions R5, consequence 21, round 5 requirement 3 |
| TOOL-09 | The plugin and the command line program never run a publication at the same moment (section 8.4, PUB-27)                                                                                                                                                                                                                                                                                                                                                                                                                                         | tool GU16                                           |
| TOOL-10 | Two plugins: this tool for the notes site, and the Ghost Publish plugin for the main site. No merge now                                                                                                                                                                                                                                                                                                                                                                                                                                          | decisions K21                                       |
| TOOL-11 | Publishing is an opt-in per device, off by default                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | tool K9                                             |
| TOOL-12 | The git engine is the system `git` program. The tool stores no git credential                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | tool K16                                            |
| TOOL-13 | The plugin uploads the attachments, with a credential in the secret storage of Obsidian. The credential never sits in the vault or in this repository                                                                                                                                                                                                                                                                                                                                                                                            | tool K17                                            |
| TOOL-14 | The name is `dsebastien-vault-publish` for now: the id of the plugin and the name of the Rust command line program. It can change before any public release                                                                                                                                                                                                                                                                                                                                                                                      | decisions R4, R16                                   |
| TOOL-30 | Outside the parity rule: the view, the order of the writes into the vault, ids (plan id, run id), the time of a run, and the text of logs and reports                                                                                                                                                                                                                                                                                                                                                                                            | ADR 0009                                            |
| TOOL-31 | The canonical form is written down before the second implementation starts: encoding, line ends, the order of keys and of lists. The time of a run is an input of the logic, so that the dates in the manifest are the same in both                                                                                                                                                                                                                                                                                                              | follows from TOOL-06                                |
| TOOL-32 | Unpublish and takedown exist on every face: the view, the command line program and the MCP server                                                                                                                                                                                                                                                                                                                                                                                                                                                | round 5 requirement 3                               |

Parts that need a running Obsidian, and so exist in the plugin only: the refresh of Dataview queries, the rename journal, the view. The parity rule applies to the state of the vault on disk. With Obsidian closed, the Rust program publishes a frozen list as it is saved in the note (PUB-101). Its credential for attachments stays open for the prototype (OPEN-12).

First version of the tool (a condition of the switch gate, ADR 0003) and what comes after the switch:

| Id      | Rel | Part                                                                                                                                                                                                   | Source                 |
| ------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| TOOL-20 | G   | Publication center: a view with four lists (new, changed, to remove, unchanged), with a count per list. Decision R5 named a fifth list, "blocked". It has no content without content checks (ADR 0011) | decisions R5, R22      |
| TOOL-21 | G   | Text filter and folder filter. Check boxes. The publish button states exactly what it will do                                                                                                          | decisions R5, tool B11 |
| TOOL-22 | G   | Dry run, publish, run log, publication report                                                                                                                                                          | decisions R5           |
| TOOL-23 | G   | Status bar item with the state of the open note                                                                                                                                                        | decisions R5           |
| TOOL-24 | G   | Commands `status`, `plan`, `publish`, `unpublish` and `takedown` of the command line program (TOOL-08)                                                                                                 | decisions R5           |
| TOOL-25 | G   | Unpublish and takedown from the view too (TOOL-32). Decision R5 placed the takedown of the plugin after the switch. The author moved it before the switch (decisions R15)                              | ADR 0003, decisions R5 |
| TOOL-26 | G   | Rename journal and the pairing step (section 8.7)                                                                                                                                                      | ADR 0007               |
| TOOL-27 | G   | MCP server and skill with the same operations as the command line program                                                                                                                              | round 5, requirement 3 |
| TOOL-28 | M   | After the switch, in this order where no other order is set: diff per note, history, more filters (type, tag), file menus                                                                              | decisions R5           |
| TOOL-29 | -   | No confirmation limits and no stored hold in the first version. Issue 9 keeps the limits as an idea                                                                                                    | decisions K6, tool K5  |

Round 5 states the four faces as the shape of the tool and does not name the switch gate. This spec marks TOOL-27 as G, and the author confirms it with the tickets (OPEN-20).

### 7.4 Content store and manifest

| Id       | Rule                                                                                                                                                                                              | Source                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| STORE-01 | The content store is a git repository of its own, separate from this one, and private                                                                                                             | ADR 0006, decisions D10 |
| STORE-02 | It holds the cleaned notes, the manifest and the configuration of the tool. Its history keeps every note that was unpublished, which is why it stays private                                      | ADR 0006, tool K7       |
| STORE-03 | The manifest holds, per published note: identity, path, former paths (append-only), dates, state, the list of its attachments, and two hashes with the version of the cleaning step               | ADR 0007, tool K23      |
| STORE-04 | The manifest is one file per note, so that two machines do not conflict                                                                                                                           | v1 6.6                  |
| STORE-05 | The identity of a note lives in the manifest. Nothing writes an id into a note                                                                                                                    | ADR 0007                |
| STORE-06 | Attachments live in the attachment storage, addressed by content hash. The manifest lists them, so that totals, cleanup and takedown work                                                         | v1 6.6                  |
| STORE-07 | Git is the engine that finds what changed, with the manifest as a thin layer on top. Issue 11 collects ideas to improve it                                                                        | decisions D39           |
| STORE-08 | One deployment record says which revision of the content store is live. The site serves it as a small public file under the reserved prefix. The tool reads it to show that a publication is live | tool K12                |
| STORE-09 | The metadata of link cards lives in a cache next to the content store. It holds public data only                                                                                                  | sites item 105          |
| STORE-10 | `stats.json` enters the build as its own input with its own schema. It is not part of the content store                                                                                           | v1 6.6                  |

### 7.5 Build

| Id       | Rule                                                                                                                                                                                                                                                                                                                                                                          | Source                                    |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| BUILD-01 | The build reads the content store and the attachment storage. It never reads the vault                                                                                                                                                                                                                                                                                        | ADR 0002                                  |
| BUILD-02 | A git commit and push to the content store is enough to put content online. The site is built in CI after a push of the content. The content build runs where the private content store is, never in the public CI of this repository (BUILD-11)                                                                                                                              | decisions D43, R16, round 5 requirement 1 |
| BUILD-03 | The build has no gate and runs no check on the content of a note (ADR 0011). It builds what the content store holds                                                                                                                                                                                                                                                           | ADR 0011                                  |
| BUILD-04 | Astro renders every page at each build. Speed comes from a render cache, keyed by the cleaned note, the link state of its targets and the version of the renderer                                                                                                                                                                                                             | v1 5.6                                    |
| BUILD-05 | One link index per build. A reference to a note becomes a link when the target is published, and plain text in the "not published" style when it is not. A target that goes live later becomes a link with no change to the linking note                                                                                                                                      | v1 9.2, decisions D50, business rule 5    |
| BUILD-06 | The build opens no network connection for the content of notes. Its inputs are named: the content store, the attachment storage, the link card cache, `stats.json` and the store catalog. The store catalog is read one time per build and validated (CAT-02). A catalog that cannot be read does not stop a content build: the build uses the last valid copy and reports it | sites item 105, consequence 27            |
| BUILD-07 | A deployment is one new release and one switch. Pages, Markdown forms, the resolver map and the code switch together. A release can be reverted with one command                                                                                                                                                                                                              | v1 5.6, hosting 1                         |
| BUILD-08 | The build counts its output files per class and fails before a limit of the hosting                                                                                                                                                                                                                                                                                           | hosting 3.7                               |
| BUILD-09 | Images are optimized at build time. Mermaid diagrams become SVG at build time, in both modes                                                                                                                                                                                                                                                                                  | decisions D19, D20                        |
| BUILD-10 | Before own code is written for the Markdown conversion, `astro-loader-obsidian` and the Quartz transformers are evaluated. Issue 12 says what to test                                                                                                                                                                                                                         | decisions D49                             |
| BUILD-11 | This repository is public, and the content store is private. The content build runs with the private content store, in a private place. The public CI of this repository never sees the content store, and no log of it shows note content or the deny list                                                                                                                   | `AGENTS.md`, ADR 0006                     |

### 7.6 Hosting

| Id      | Rule                                                                                                                                                                              | Source                      |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| HOST-01 | One Cloudflare Worker with its static file hosting for the pages and the Markdown forms, plus object storage for images and media. A prototype confirms it (section 21)           | decisions D3, hosting 3.7   |
| HOST-02 | A self-managed server is the exit path. The resolver stays plain TypeScript, so that it runs in tests, at the edge and on a plain server. The URL contract tests run against both | decisions D3, consequence 9 |
| HOST-03 | The resolver, Markdown on request and the remote MCP server run at the edge. No own server is part of the first release                                                           | decisions consequence 9     |
| HOST-04 | The hosting keeps the HTML form and the Markdown form of a note apart. A reader never gets Markdown by mistake                                                                    | hosting 4.2                 |
| HOST-05 | Media answers range requests (video, audio)                                                                                                                                       | hosting 3.7                 |
| HOST-06 | The hosts of the notes and of the store stay. The former stats host answers with one redirect to the stats pages of the notes site                                                | ADR 0001, decisions D1, R20 |

### 7.7 Remote MCP server of the site

This is not the MCP server of the publishing tool (TOOL-03). It is a public service that agents use to read the site.

| Id     | Rel | Rule                                                                                                                                                                                                                                                                                                                       | Source                        |
| ------ | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| MCP-01 | M   | The server ships at the first release, with the code mode pattern: a `search` tool and an `execute` tool over a typed interface of the notes, with sandboxed execution                                                                                                                                                     | decisions D32, Q7             |
| MCP-02 | M   | Public without login, with a rate limit, a daily budget for `execute`, and row limits per call. When the budget is used up, the answer is an error that an agent can read                                                                                                                                                  | decisions Q8, issue 7         |
| MCP-03 | M   | It runs apart from the pages, so that a fault in it cannot break them. Its URL is on the own domain                                                                                                                                                                                                                        | hosting 7.2                   |
| MCP-04 | M   | Its data comes from the build, so it holds published content only. The tests of the guards cover it (TEST-01)                                                                                                                                                                                                              | hosting 7.4, v1 10            |
| MCP-05 | M   | The server is built behind one small interface for the executor. The MCP prototype measures both executors (QuickJS in WebAssembly, Dynamic Worker) with typical scripts, and the author decides with the numbers (OPEN-04). Issue 7 stays for SDKs and frameworks                                                         | decisions Q6, R16             |
| MCP-06 | M   | Until decision D47 is settled (OPEN-01), the server gives no bulk access. One call of `execute` cannot return the full text of many notes: the number of full texts per call has a small limit, to set with the row limits of MCP-02. Transcript notes and product documentation are never returned as full text in a list | decisions D47, consequence 13 |
| MCP-07 | -   | More access for customers is an idea for later. It needs the login of issue 1                                                                                                                                                                                                                                              | decisions Q8, consequence 28  |

### 7.8 Stack and repository

1. Astro, TypeScript at maximum strictness, Tailwind 4, Bun (`AGENTS.md`).
2. No client-side framework on note pages (v1 9.14).
3. The resolver is a module of plain TypeScript (HOST-02).
4. One build for the notes site. The codebase can host other sections later, but no decision here may depend on that (ADR 0001).
5. The layout of the repository is set by the first tickets. The Rust code lives in this repository from the start, next to the plugin code (decisions R19). Set by issue 16: the site is the Bun workspace `apps/site`, the Rust program is the member `cli` of a Cargo workspace at the root, and shared TypeScript code goes to `packages/`. Set by issue 17: the test data is in `fixtures/` at the root, the test support for TypeScript is the workspace `packages/testing`, and the test support for Rust is `cli/tests/support/mod.rs`. The home of the plugin is set by issue 29.

## 8. Publication flow

### 8.1 Requirements

| Id     | Requirement                                                                                                    | Source                            |
| ------ | -------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| PUB-01 | The author publishes from Obsidian                                                                             | v1 6.1                            |
| PUB-02 | The author chooses per note: publish, skip, unpublish                                                          | v1 6.1                            |
| PUB-03 | A review step shows what will change before anything goes live                                                 | ADR 0002                          |
| PUB-04 | A change in the vault never goes live by itself                                                                | v1 6.1                            |
| PUB-05 | A note that was never published is not published unless the author asks                                        | decisions Q5                      |
| PUB-06 | The interactive part is fast and never blocks Obsidian. The work behind it runs in the background (section 16) | decisions, round 5, requirement 1 |

### 8.2 Model (ADR 0008)

| Id     | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Source                                          |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| PUB-10 | The manifest says what is published: recorded in the manifest and pushed to the content store. The deployment record says what is live. The manifest is the only source for the first fact                                                                                                                                                                                                                                                                | ADR 0008, tool K12                              |
| PUB-11 | The `public_note` property is the recorded state in the vault. Only the publishing tool writes it                                                                                                                                                                                                                                                                                                                                                         | ADR 0008                                        |
| PUB-12 | The tool never reads the property as an input. A wrong value in a note (for example a value that an assistant set) changes nothing                                                                                                                                                                                                                                                                                                                        | ADR 0008, business rule 2                       |
| PUB-13 | After each publication, when the push succeeded, the tool corrects the property: true on a published note, removed on a note that is not published. It compares every note that it scanned with the manifest and writes only where the value is wrong. A file that changed during the run is skipped, reported and corrected at the next run. The tool never writes into the templates folder. Notes in deny list folders are not scanned and not written | ADR 0008, consequence 17, decisions R16         |
| PUB-14 | A correction of the property never makes a note "changed". The property is not part of the change detection                                                                                                                                                                                                                                                                                                                                               | follows from PUB-13                             |
| PUB-15 | The selection in the view is the intent. No property carries it                                                                                                                                                                                                                                                                                                                                                                                           | ADR 0008                                        |
| PUB-16 | Two guards say "never": the deny list and the ignore property (section 9.2)                                                                                                                                                                                                                                                                                                                                                                               | ADR 0008                                        |
| PUB-17 | A candidate is a note that is not published and that no guard excludes. The list of candidates is long, so the publication queue has filters                                                                                                                                                                                                                                                                                                              | ADR 0008                                        |
| PUB-18 | The publication queue has four lists: new (candidates), changed, to remove, unchanged                                                                                                                                                                                                                                                                                                                                                                     | decisions R5, R22                               |
| PUB-19 | Default selection: changed notes are selected, and the author unticks what to hold. A removal that the author asked for is selected. An entry "missing from this vault" is never selected by default (PUB-95). A new candidate is never selected by default. To confirm with the first version                                                                                                                                                            | decisions Q9, ADR 0008, tool B16                |
| PUB-20 | Skip: an entry that the author leaves unselected. The live version stays. Nothing is stored                                                                                                                                                                                                                                                                                                                                                               | tool K5                                         |
| PUB-21 | Forced removal: a published note that enters the deny list or gets the ignore property is removed by the next publication of any kind. It cannot be skipped. If it fails, the whole publication stops                                                                                                                                                                                                                                                     | decisions K11, business rule 2, tool GU1 to GU3 |
| PUB-23 | Changes that touch only a link after a rename are published together with the renamed note, without a selection                                                                                                                                                                                                                                                                                                                                           | decisions D55                                   |
| PUB-24 | Two hashes per manifest entry tell a real edit from a technical update (a new version of the cleaning step). Technical updates show as one line with one check box and do not move the dates of a note                                                                                                                                                                                                                                                    | tool K23, ST16                                  |
| PUB-25 | Eligibility tests of other tools that ask "is this note live" through the property keep working, because the property still means "live"                                                                                                                                                                                                                                                                                                                  | ADR 0008, consequence 18                        |

### 8.3 How the interactive part stays fast

1. The budgets of section 16.1 are the requirement. How the tool reaches them is a question of the headless slice (PROTO-04).
2. The first version uses git and the manifest to find what changed (decisions D39). Issue 11 collects ideas for later: a journal of file events, a stored last plan, work off the main thread.

### 8.4 Steps of a publication

Before the plan. These steps run in the background and never block Obsidian (section 16.1). A plan can be computed when they are done:

| Id      | Step                                                                                                                                                                                                                                                                                                                                                                                                             | Source                          |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| PUB-30  | **Open**. The author opens the publication center, or an agent calls `status`. The tool fetches the content store and stops with a clear message when the local copy cannot follow the remote one. Without a network, PERF-16 applies                                                                                                                                                                            | tool ST27                       |
| PUB-31  | **Check**. The tool finds what changed and fills the four lists. A deny list entry that matches no folder stops the run here (GATE-38)                                                                                                                                                                                                                                                                           | ADR 0008, decisions D39         |
| PUB-35  | **Refresh of frozen lists** (plugin only). With Obsidian open, the plugin refreshes the Dataview queries of the published notes that changed and of the selected candidates with the Dataview Serializer, before the plan is computed. It does not run again the queries that the author froze on purpose. A note that the serializer skips or cannot process is reported. With Obsidian closed, PUB-101 applies | tool K14, GU20, decisions R16   |
| PUB-36  | **Guards**. The deny list and the `publish_ignore` property are applied to every note before the plan. A note under a guard is in no list. No check runs on the content of a note (ADR 0011)                                                                                                                                                                                                                     | ADR 0011, business rules 2 to 4 |
| PUB-101 | **Obsidian closed**. The Rust program publishes a frozen list as it is saved in the note. The plan marks such notes "lists not refreshed"                                                                                                                                                                                                                                                                        | decisions R16                   |

Review:

| Id     | Step                                                                                                                                                                                                                                                                                    | Source                      |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| PUB-32 | **Select**. The author filters, ticks and unticks. The defaults of PUB-19 apply. A candidate that the author ticks passes PUB-35 and PUB-36 before it enters a plan                                                                                                                     | decisions Q9                |
| PUB-33 | **Dry run**. The tool computes a publication plan and writes nothing into the vault or the content store. The plan holds the selected entries, the forced removals, the edits of the configuration since the last publication, and an id. It is stored outside the vault, on the device | decisions R5, R17, tool A27 |
| PUB-92 | The text that the author reviews is the text that is published. A publication never changes a note between the review and the push. The only write into a note after the review is the correction of the property (PUB-13)                                                              | follows from PUB-03         |

Apply. This part runs in the background, and the author can continue to work:

| Id      | Step                                                                                                                                                                                                                                                                          | Source                    |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| PUB-34  | **Publish**. The tool applies exactly one plan. It computes the plan again. If the vault or the content store changed, the plan is stale and the publication stops                                                                                                            | tool A28                  |
| PUB-37  | **Clean**. Each selected note becomes one cleaned note for rendering: Meta Bind code and query markers removed, attachments collected, links and embeds resolved (PUB-87). Comments stay in the cleaned note. This step is rendering, not privacy (ADR 0011)                  | v1 6.4, ADR 0011          |
| PUB-100 | **Check of posts on the main site**. For each selected note that also exists on the main site, the tool checks that the post answers 200 and names itself, and records the result with the manifest entry. The build reads that result and opens no connection (IDX-12)       | seo item 22, ADR 0010     |
| PUB-38  | **Link metadata**. The tool reads the metadata of each new or expired URL of a link card and of a video card, one time, into the cache of STORE-09                                                                                                                            | sites items 105, 119, 282 |
| PUB-39  | **Attachments**. The tool uploads the new ones as they are, by content hash, before the push, so that the build finds them. It records what it uploaded (PUB-93)                                                                                                              | tool K17, ADR 0011        |
| PUB-40  | **Commit**. Cleaned notes and manifest go to the content store in one commit, pushed without force. If another device pushed first, git refuses the push and the run stops with nothing live (PUB-94). A publication that fails halfway can be run again with the same result | tool GU15, v1 6.4         |
| PUB-41  | **Correct the property** (PUB-13), after the push succeeded                                                                                                                                                                                                                   | ADR 0008                  |
| PUB-42  | **Build and deployment** start from the push (BUILD-02). The tool does not wait for them                                                                                                                                                                                      | decisions D43             |
| PUB-43  | **Report**. The tool reads the deployment record (STORE-08) and shows the publication report: what is published, what is live with its URLs, what failed and why, the warnings. The report stays until the author closes it                                                   | tool K12, B26             |

Links at the cleaning step. The build never reads the vault, so the cleaning step resolves each link:

| Id     | Rule                                                                                                                                                                                                                                                                              | Source                                   |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| PUB-87 | The cleaning step resolves every link, every embed and every link in a property to the path of its target note, so that the build can write its URL                                                                                                                               | follows from ADR 0002                    |
| PUB-89 | A target that is not published keeps its link text in the cleaned note. The build shows it as plain text in the "not published" style, and as a link when the target is published. A target under a guard is handled in the same way: the first version hides no title (ADR 0011) | decisions D50, business rule 5, ADR 0011 |

Other rules:

| Id     | Rule                                                                                                                                                                                                                                                                                        | Source                   |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| PUB-26 | A failure of one note before the commit leaves that note out and reports it. A failure of the commit or of the push stops the run                                                                                                                                                           | tool B24                 |
| PUB-27 | One publication at a time on one device, for all four faces. Between devices, the refused push of PUB-40 is the lock                                                                                                                                                                        | tool GU15, GU16          |
| PUB-28 | The publication report also lists: the stubs per note type, the notes that also exist on the main site and have no verified URL there, the link cards without metadata, and after the switch the notes without a description, the images without alternative text and the very large images | seo items 180, 182, v1 7 |
| PUB-29 | Each publication is one commit whose message holds the counts, the device, the face that started it and the number of skipped entries                                                                                                                                                       | tool B27                 |

### 8.5 The first publication

1. The manifest is empty at the start, so the first publication is an import of everything that is published on that day.
2. The dates come from the `created` property of each note, so that the day of the switch does not make every note "new" (decisions D14).
3. ADR 0008 forbids the property as an input. The source of the import list is the list of notes that Obsidian Publish serves on that day, read one time. The author confirms the first publication one time in the view (decisions R15).
4. PUB-98: the first publication has its own selection rule. Its selection is the import list, not the defaults of PUB-19. Every note of the list is a "new" entry and is selected. Nothing else is selected. One confirmation shows the total (tool GU23).
5. The reconciliation of the current publishing template stops before the first publication. If both run, two writers change the property (decisions consequence 17, tool GU24).

### 8.6 Who may start and apply a publication

| Id     | Rule                                                                                                                                                                                                                                                                                                     | Source                   |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| PUB-50 | A publication starts from an explicit act of the author, or of automation that the author started. Never from a vault event, a timer, the start of Obsidian or a scheduled job alone                                                                                                                     | decisions D12, tool GU22 |
| PUB-51 | The first version has no confirmation limits for the size of a publication. Issue 9 keeps them as an idea                                                                                                                                                                                                | decisions K6             |
| PUB-52 | An agent that the author started may publish alone new versions of notes that are already published, through the command line program or the MCP server                                                                                                                                                  | decisions R16            |
| PUB-53 | An agent applies exactly one plan by its id. It cannot publish something that the plan did not show (PUB-34, PUB-92)                                                                                                                                                                                     | tool A28                 |
| PUB-54 | A note that is published for the first time, an unpublish and a takedown need the author. Either the author names the notes in his request, and the agent passes exactly those paths (TOOL-08), or the author confirms in the view. A plan that an agent asks for without paths holds changed notes only | decisions R16, ADR 0008  |
| PUB-55 | The guards, the forced removals and the device opt-in are the same for every face                                                                                                                                                                                                                        | ADR 0009, tool K9        |
| PUB-56 | When size limits exist (issue 9), a plan above a limit is confirmed by the author in the view                                                                                                                                                                                                            | decisions D12            |
| PUB-57 | No rule guards against the upload and remove commands of the Obsidian command line. The author stops using Obsidian Publish, and his agents and skills move to the new tool                                                                                                                              | decisions D12 (round 4)  |

The skill of the tool (TOOL-04) states the rule of PUB-52 and PUB-54 for every agent.

### 8.7 Renames (ADR 0007)

| Id     | Rule                                                                                                                                                                                                    | Source                   |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| PUB-60 | The plugin records each rename that Obsidian reports in the rename journal. The journal survives a restart and travels with the vault to the other devices                                              | ADR 0007, consequence 10 |
| PUB-61 | The next publication turns the old path into a former path of the manifest entry. A chain of renames folds into one                                                                                     | ADR 0007, tool ST23      |
| PUB-62 | A rename that the plugin did not see (made with Obsidian closed, or by a script) shows in the publication queue as a pairing to confirm: a path disappeared and a path with the same content appeared   | ADR 0007                 |
| PUB-63 | The journal and the pairing step are safety-critical. Section 18.6 lists their tests                                                                                                                    | ADR 0007                 |
| PUB-91 | A rename that touches a path of the deny list is reported by the rename journal, which proposes the new path for the deny list. Until the deny list holds the new path, GATE-38 stops every publication | ADR 0007                 |

### 8.8 Dates

| Id     | Rule                                                                                                                                                               | Source              |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| PUB-70 | "Recently added" uses the date of the first publication, seeded from `created`                                                                                     | decisions D14       |
| PUB-71 | "Updated" on the site changes only with a real edit of the public content. A technical update does not move it                                                     | v1 6.7, tool ST16   |
| PUB-72 | Only a significant update moves a note up in "recently updated", in the feeds and in the sitemap dates. The threshold is to set from the first version of the tool | v1 6.7, seo item 37 |
| PUB-73 | A bulk import stays out of the recent pages and out of the feeds                                                                                                   | decisions D14       |

### 8.9 Unpublish and takedown

| Id     | Rule                                                                                                                                                                                                                          | Source                |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| PUB-80 | Unpublish: the author selects a published note for removal in the view, or a plan names its path to remove (TOOL-08). The next publication removes it. Its URL then answers 410. The tool removes the property                | ADR 0008, v1 5.4 U9   |
| PUB-81 | Takedown: an immediate and complete removal that does not wait for a normal publication                                                                                                                                       | `GLOSSARY.md`, v1 6.8 |
| PUB-82 | A takedown removes the page, the Markdown form, the Open Graph image, the attachments that no other note uses, and every cached copy that the site controls. Then it removes the note from the manifest with its former paths | v1 6.8                |
| PUB-83 | After a takedown the URL answers 404, and no redirect keeps an old name alive. A rebuild removes the note from the search index, the graph, the feeds, the sitemaps, the files for agents, the backlinks and the embeds       | v1 6.8                |
| PUB-84 | A forced removal follows the takedown rule                                                                                                                                                                                    | tool K10              |
| PUB-85 | The takedown can also remove the note from the history of the content store when the case needs it                                                                                                                            | v1 6.8                |
| PUB-86 | Copies in browser caches and at crawlers cannot be recalled. The documentation of the tool says so                                                                                                                            | v1 6.8                |
| PUB-99 | A takedown does not wait for anything else. It works when a plan is stale and when another publication failed                                                                                                                 | business rule 16      |

### 8.10 What replaces the current scripts

| Today (state 1.9, 1.10)                                                  | After                                                                                    |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| The publishing template mirrors the Publish state into the property      | The tool corrects the property from the manifest (PUB-13). The template stops            |
| The template runs the Dataview Serializer on each published note         | The freeze step of the plugin (PUB-35)                                                   |
| The template generates the two "recent" notes                            | Generated pages. The two notes keep their URLs (URL-07)                                  |
| The template opens the Publish panel                                     | The publication center                                                                   |
| The stats script reads the published list from Obsidian Publish          | It reads the manifest                                                                    |
| The stats script pushes `stats.json` to the repository of the stats site | `stats.json` becomes a build input. The notes site holds the stats pages (decisions R20) |
| The agents of the author use the Obsidian Publish commands               | They use the command line program or the MCP server of the tool                          |

Correction of spec v1: the Ghost Publish plugin does not call the Obsidian Publish API (tool GP5). Its changes are in section 20.

### 8.11 Failure cases

| Id     | Case                                                            | Rule                                                                                                                                                                                                                                                                                                                                        | Source                |
| ------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| PUB-93 | Attachments were uploaded and the push failed                   | An attachment never stays public without a manifest entry. When the push fails or is refused, the tool deletes the uploads of that run that no manifest entry lists. A cleanup that fails is reported and runs again at the next publication                                                                                                | follows from STORE-06 |
| PUB-94 | The push is refused or fails                                    | The run leaves a local commit in the copy of the content store. State: not pushed, nothing is published, no property is corrected. Recovery: when the remote did not move, the next run pushes the same commit. When the remote moved, the tool drops the local commit, fetches, and reports that the plan is stale. It never forces a push | tool GU15             |
| PUB-95 | The file of a published note is missing on this device          | The entry shows as "missing from this vault" in the list "to remove". It is never selected by default. Its URL never answers 410 without a selection of the author                                                                                                                                                                          | tool B16, ST28        |
| PUB-96 | A note was renamed outside Obsidian and edited at the same time | No pairing exists, because the content differs. The old path shows as "missing from this vault" and the new path as a candidate. The note is reported, not removed. The author pairs the two by hand                                                                                                                                        | tool ST24             |
| PUB-97 | Two devices publish                                             | The second push is refused (PUB-40), and PUB-94 applies. The rename journal of each device travels with the vault (PUB-60)                                                                                                                                                                                                                  | tool ST34             |
| PUB-98 | The first publication                                           | Its own selection rule (section 8.5)                                                                                                                                                                                                                                                                                                        | tool GU23             |

## 9. Guards

The first version has two guards and no content check (ADR 0011, decisions R22). A note that the author selects, and that no guard excludes, is published as it is in the vault, as Obsidian Publish does today.

### 9.1 Rules

| Id      | Rule                                                                                                                                                                                                                                                                                                                                                                             | Source                       |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| GATE-04 | The configuration of the tool (the deny list and the settings) lives in one file of the content store: private, with a history, the same on every device                                                                                                                                                                                                                         | tool K7                      |
| GATE-05 | This repository never holds the configuration of the real vault. Its folder names are private. The fixture vault has its own, invented configuration                                                                                                                                                                                                                             | `AGENTS.md`                  |
| GATE-07 | The configuration is editable through every face of the tool: the view, the command line program and the MCP server of the tool, so that an AI can help the author (GATE-40). The first version has no full editor in the view. The tool shows that the configuration changed after the last publication. A rename of a folder on the deny list is covered by GATE-38 and PUB-91 | tool K7, ST10, decisions R17 |
| GATE-41 | No automatic check runs on the content of a note: no scan for secrets or personal data, no replacement of titles in links, no removal of rows of frozen lists, no removal of comments, no stripping of attachment metadata, no allow marks, no blocked state. The build has no gate either (BUILD-03)                                                                            | ADR 0011, business rule 3    |

### 9.2 The two guards

| Id      | Guard                               | Rule                                                                                                                                                                                                                                                               | Source                              |
| ------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| GATE-10 | Deny list                           | The vault folders whose notes can never be published, whatever else says so                                                                                                                                                                                        | ADR 0008, ADR 0011, business rule 4 |
| GATE-11 | Deny list, first content            | The excluded folders of the Obsidian Publish configuration, plus three groups that are not published today: the folder of the paid course, a private folder, and the AI assistant folders. The folders that hold the note templates are among the excluded folders | decisions Q5, Q5b, state 1.5        |
| GATE-12 | Ignore property                     | The property `publish_ignore` on a note says that the tool must never publish that note. It follows the model of the ignore flag of the Ghost Publish plugin                                                                                                       | ADR 0008, decisions R16             |
| GATE-13 | Ignore property on a published note | The removal is forced, as for a note that enters a deny list folder (PUB-21)                                                                                                                                                                                       | business rule 4                     |

### 9.3 What the guards do

| Id      | Case                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Source                         |
| ------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| GATE-20 | A note in a deny list folder, or with `publish_ignore`                   | It is never a candidate. It is in no list of the publication queue, and no face can select it                                                                                                                                                                                                                                                                                                                                                               | ADR 0008, business rule 4      |
| GATE-21 | A published note that enters a deny list folder or gets `publish_ignore` | Forced removal (PUB-21). Links to it in other notes show as plain text after the next build, with no republication of those notes                                                                                                                                                                                                                                                                                                                           | decisions K11, business rule 4 |
| GATE-38 | A deny list entry that matches no folder of the vault                    | Every publication stops with a clear message. A renamed folder of the deny list can then never turn its notes into candidates                                                                                                                                                                                                                                                                                                                               | ADR 0007                       |
| GATE-40 | Edits of the guards by an agent                                          | An agent can read the whole configuration. It can apply alone an edit that makes the tool stricter: add a folder to the deny list, set `publish_ignore` on a note. An edit that makes the tool looser (remove a deny list entry, remove `publish_ignore`) is stored as a proposal. The author confirms it in the view, or names it in the request. Every edit is written to a log, and the next publication plan shows the edits since the last publication | decisions R17, R22             |
| GATE-42 | An attachment in a deny list folder                                      | It is never uploaded. The deny list covers every file of a folder. This is a reading of this spec, to confirm with the first version                                                                                                                                                                                                                                                                                                                        | follows from GATE-10           |

### 9.4 What is public as it is

1. The title of a note that is not published shows as plain link text when another note links to it (ADR 0011).
2. Comments are not shown on the page, as in Obsidian. They stay in the Markdown form of the note (ADR 0011).
3. Metadata in images and other attachments is not removed (ADR 0011).
4. A frozen list is published as it is saved, with all its rows (ADR 0011).
5. No allow list per property key exists. Every property of a published note is public until one exists (business rule 14). Issue 6 collects where an allow list helps (OPEN-03).
6. Every property of a person note stays public for now, and every person note is indexed. The author reviews this when an allow list exists (decisions D40, Q3, business rule 15).
7. Purchase, sale, storage and lending data in collection notes are public. The author accepts that (decisions Q1).
8. The transcript notes of recordings stay public, on purpose (decisions Q4). Nothing leaves in bulk at the first release (AGENT-10).

### 9.5 Later (issue 15)

The content checks are an idea for later. Their requirements left this spec. The former ids, so that an old reference can be traced:

1. A check for text that looks like a secret or like personal data, with allow marks and a blocked state: GATE-22, GATE-30, GATE-31, GATE-39, PUB-22, TEST-14.
2. The replacement of the title of a note under a guard in links, embeds and properties, with a forced republication of the linking notes: GATE-25, PUB-88, PUB-90.
3. The removal of rows of frozen lists that link to a note under a guard: GATE-23.
4. The removal of comments from every output: a part of GATE-33.
5. The stripping of attachment metadata, and the block of an attachment outside the public attachment folder: GATE-27, GATE-28, GATE-29.
6. A second check in the build, and gate reports: GATE-01 to GATE-03, GATE-06, GATE-08, TEST-23.
7. Rows that moved and are not content checks: GATE-24 (now PUB-89), GATE-26 (now REN-01), GATE-32 (now URL-09), GATE-34 (now REN-14), GATE-35 (now REN-15), GATE-36 (now PUB-28), GATE-37 (now PUB-12).

## 10. URL contract and redirects

### 10.1 Rules

Ids in brackets are the rules of spec v1 (5.4) that a rule replaces.

| Id     | Rel | Rule                                                                                                                                                                                                                                                                                                                                                                        | Source                      |
| ------ | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| URL-01 | G   | The canonical URL of a note is the URL that it has today: each segment of the vault path percent-encoded, then `%20` written as `+`. A literal `+` in a name is `%2B`. This is final (U1)                                                                                                                                                                                   | ADR 0005, decisions D42     |
| URL-02 | G   | One resolver turns every other form into the canonical URL in one redirect: `%20` or `%2B` for spaces, another letter case, a `.md` suffix, a trailing slash, the file name alone, an alias, another Unicode normal form (U2)                                                                                                                                               | v1 5.4, seo item 20         |
| URL-03 | G   | The literal reading of a path wins. Only when it finds no note does the resolver read `%2B` and `%20` as a space                                                                                                                                                                                                                                                            | seo item 20                 |
| URL-04 | G   | Precedence when a name can mean two things: live path, then former path, then file name, then alias. An alias of more than one note gives the "not found" page with those notes as suggestions (U3)                                                                                                                                                                         | v1 5.4                      |
| URL-05 | G   | A redirect target never redirects. Every variant reaches a page with status 200 in one hop                                                                                                                                                                                                                                                                                  | seo item 27                 |
| URL-06 | G   | A note that moved or was renamed keeps its former URLs as redirects (U5)                                                                                                                                                                                                                                                                                                    | ADR 0005, ADR 0007          |
| URL-07 | G   | The notes that are generated today keep their URLs: the home note, "Recently added", "Recently modified", "Stats". Each shows the new generated page or redirects to it (U7)                                                                                                                                                                                                | v1 5.4, seo row 26i         |
| URL-08 | G   | Every generated page lives under the reserved prefix `/-/`. Notes and aliases named "tags", "stats" and "llms" exist, so generated pages at the root would collide (U6)                                                                                                                                                                                                     | decisions D41               |
| URL-09 | G   | Reserved root names: `robots.txt`, `sitemap.xml`, every `sitemap-*.xml`, `llms.txt`, the IndexNow key file, the verification files of the search engines, `.well-known/`. A note or an alias with such a name, or two paths that are equal when letter case is ignored, stops the publication with a clear message. This is a rule of the URL contract, not a content check | seo item 41, v1 7           |
| URL-10 | G   | The raw Markdown of a note lives at `/-/md/<path>.md`. The form `<url>.md` continues to open the page, through the redirect of URL-02 (U11)                                                                                                                                                                                                                                 | decisions D11               |
| URL-11 | M   | Markdown on request: a request for a canonical URL with `Accept: text/markdown` gets the Markdown form. The format follows the `Accept` header or the Markdown URL, never the user agent                                                                                                                                                                                    | decisions D32, seo item 156 |
| URL-12 | G   | A URL with a query answers 200 with the same page and a clean canonical link. It never redirects, so that analytics parameters survive. The cache ignores the query (U12)                                                                                                                                                                                                   | seo item 175                |
| URL-13 | G   | Every URL that the build writes (links, sitemaps, feeds, search results, files for agents) is canonical and answers 200 without a redirect. One URL function serves all outputs. CI checks it (U13)                                                                                                                                                                         | v1 5.4, seo item 18         |
| URL-14 | G   | Old heading anchors still scroll to their heading. Headings get stable ids. The exact old forms are measured first (OPEN-15) (U8)                                                                                                                                                                                                                                           | v1 5.4, seo item 162        |
| URL-15 | M   | Each attachment has a stable URL that follows its vault path, and a content-hashed URL with a long cache time that pages use. The hashed URL keeps the readable name and carries a segment for the content class (U10)                                                                                                                                                      | v1 5.4, seo items 65, 151   |
| URL-16 | G   | A folder path shows the folder note when one is published. Without one it shows a generated list of the children of the folder. A note and a folder with the same name: the note wins, as today                                                                                                                                                                             | v1 9.4, seo item 179        |
| URL-17 | G   | The former stats host answers with one redirect to the stats pages of the notes site (U14)                                                                                                                                                                                                                                                                                  | decisions R20               |
| URL-18 | G   | HTML and Markdown answer 304 to a conditional request                                                                                                                                                                                                                                                                                                                       | seo item 32                 |

### 10.2 Status codes

| Id     | Requested form                                                                                      | Answer                                                                                                    | Source                |
| ------ | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------- |
| URL-20 | Canonical URL, with or without a query. Markdown form                                               | 200                                                                                                       | seo item 29           |
| URL-21 | Former path of a moved or renamed note                                                              | 301                                                                                                       | seo row 26a           |
| URL-22 | Syntax variant: `%20` or `%2B`, trailing slash, other Unicode form, other letter case, `.md` suffix | 301                                                                                                       | seo item 174          |
| URL-23 | File name alone                                                                                     | 301, with a short cache lifetime                                                                          | seo item 174, row 26g |
| URL-24 | Alias                                                                                               | 302                                                                                                       | seo item 174          |
| URL-25 | `http://`                                                                                           | 301 to `https://`                                                                                         | seo row 26e           |
| URL-26 | Unknown path, also under `/-/`                                                                      | 404, with search suggestions. Never a redirect to the home page or to a type hub                          | seo items 28, 30      |
| URL-27 | A note that the author unpublished                                                                  | 410                                                                                                       | v1 5.4 U9             |
| URL-28 | A note after a takedown or a forced removal                                                         | 404. Its former paths are gone                                                                            | v1 5.4 U9, tool K10   |
| URL-29 | A generated list without items, or a page number that does not exist                                | 404                                                                                                       | seo item 31           |
| URL-30 | A cut canonical URL of the current site                                                             | 404. One exception: a cut URL of one note that the baseline shows as indexed gets a 301 from a fixed list | seo items 125, 176    |
| URL-31 | `robots.txt`                                                                                        | Always 200                                                                                                | seo item 34           |
| URL-32 | Any page, for a verified search crawler                                                             | Never 403, 429 or a challenge                                                                             | seo item 33           |
| URL-33 | A failure of the edge code, or a file of the release that is missing                                | 500, with the server error page (NAV-20). Never cached, and never a 200                                   | decisions R24         |

### 10.3 The first redirect list

The first redirect list exists as a private file, with a script that builds it again from the URL lists of the search engines, the 404 data of the current site and the rename history of the vault (decisions R11). It never enters this repository. What the resolver and the tests must handle, from its findings:

| Id     | Rel | Requirement                                                                                                                                                             | Source                |
| ------ | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| RES-01 | G   | An old URL with a note name that is cut at a dot reaches its note in one redirect, when the list names the note. This is the fixed list of URL-30                       | decisions finding 1   |
| RES-02 | G   | An old URL with a tracking query that is encoded into the path reaches its note in one redirect                                                                         | decisions finding 1   |
| RES-03 | G   | The "soft 404" examples of the search engine are canonical URLs of published notes. They need no rule. A test checks that each answers 200 with its content in the HTML | decisions finding 2   |
| RES-04 | G   | One prefix rule covers the former paths of product documentation under two former folders                                                                               | decisions finding 3   |
| RES-05 | G   | Folder notes that are not published and still get visits each have a decision of the author: a target, or "gone" (410)                                                  | decisions finding 4   |
| RES-06 | G   | The parity test compares the decoded form of a path, because the analytics tool shows paths decoded                                                                     | decisions finding 5   |
| RES-07 | G   | The script of the list uses the status codes of section 10.2, not those of rule U4 of spec v1                                                                           | decisions finding 6   |
| RES-08 | G   | Every row of the list has a target or a decision. Rows without a target wait for the author (OPEN-14)                                                                   | decisions R11         |
| RES-09 | M   | After the switch, the 404 report feeds the list: an unknown path with real visitors gets a decision                                                                     | v1 11.3, seo item 132 |

### 10.4 Acceptance tests

1. Every path of the list of published notes answers 200.
2. For a sample of each variant kind (file name, lower case, `.md`, trailing slash, alias, `%20`, names with `+`, `%`, `&`, apostrophes, dots and non-ASCII characters, a name that ends like a file extension), one redirect leads to the right note with the right code.
3. Every row of the first redirect list answers as the list says.
4. Every link from the main site, the store and the sent newsletters to the notes host resolves. This includes the notes URLs that the main site rewrites to store pages (sites item 298). Targets that are dead today are listed, and the author decides on each.
5. The same tests run against the resolver alone, against the preview host, and against a plain local server (HOST-02).

## 11. Site features by release

### 11.1 Release rule

Section 0.2 defines G, M and W2. The first release is G plus M. Stacked pages are the first feature of the second wave (decisions D36).

### 11.2 First release

#### 11.2.1 Rendering of a note

| Id     | Rel | Requirement                                                                                                                                                                                                                                                         | Source                                   |
| ------ | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| REN-01 | G   | Wikilinks with aliases, heading and block links, embeds of notes and blocks (with a depth limit and cycle detection), image embeds with a size, audio, video and PDF embeds, callouts with folding, highlights, footnotes, tables, task lists, math, code highlight | v1 9.2                                   |
| REN-02 | G   | Frozen Dataview output renders as static Markdown, without its markers                                                                                                                                                                                              | v1 9.2                                   |
| REN-03 | G   | Meta Bind code and query markers are removed for rendering. Comments are not shown on the page, as in Obsidian. They stay in the Markdown form (ADR 0011)                                                                                                           | v1 8.2 story 53, ADR 0011                |
| REN-04 | G   | A link to a note that is not published shows as plain text in a visible "not published" style and leads to no page. A target under a guard is handled in the same way                                                                                               | decisions D50, business rule 5, ADR 0011 |
| REN-05 | G   | External links open in the same tab                                                                                                                                                                                                                                 | decisions D21                            |
| REN-06 | G   | The output is class-based: no inline style from code highlight, math, diagrams or music                                                                                                                                                                             | v1 9.2                                   |
| REN-07 | G   | Music notation: the same block languages as today, with playback. The library loads only on pages with music blocks, pinned and self-hosted                                                                                                                         | v1 9.12                                  |
| REN-08 | G   | Mermaid renders to SVG at build time, in both modes                                                                                                                                                                                                                 | decisions D20                            |
| REN-09 | G   | A note in French is marked as French                                                                                                                                                                                                                                | seo item 50                              |
| REN-10 | M   | A copy button on code blocks, a scroll box for wide tables, galleries from neighbor images, image captions, the footnote rules of the main site                                                                                                                     | sites items 299, 300                     |
| REN-11 | M   | Canvas and Excalidraw references show as a link, or as a static image when one exists                                                                                                                                                                               | v1 9.2                                   |
| REN-12 | M   | A French note and its English twin link to each other with `hreflang`. The pair comes from a property of the notes                                                                                                                                                  | seo items 51, 52                         |
| REN-13 | M   | Times render in one fixed time zone                                                                                                                                                                                                                                 | v1 9.2                                   |
| REN-14 | G   | A live Dataview or Bases block without a frozen form is dropped from the page, and the publication report warns. The current site does not render it either                                                                                                         | v1 7, state 1.4                          |
| REN-15 | G   | Raw HTML in a note is rendered through an allow list of elements, as Obsidian does. This is a rule of security, not a privacy check                                                                                                                                 | v1 7, v1 9.15                            |

#### 11.2.2 Link cards and video cards

| Id      | Rel | Requirement                                                                                                                                                                | Source                         |
| ------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| CARD-01 | M   | A paragraph that starts with `LINK` or `LINKS` (same meaning, optional colon) becomes link cards. A target is a bare URL, a Markdown link or a wikilink                    | sites items 96, 97             |
| CARD-02 | M   | Block form: the keyword alone, then list items. One card per URL, as a stack, with no limit of five lines                                                                  | sites items 98, 99             |
| CARD-03 | M   | A wikilink target that is published gives a note card from the data of the note, resolved at build time                                                                    | sites item 106                 |
| CARD-04 | M   | A wikilink target that is not published shows its link text as plain text in the "not published" style, and becomes a card when it goes live                               | sites item 112, ADR 0011       |
| CARD-05 | M   | A block where nothing can show is removed whole. The raw `LINK:` text never shows                                                                                          | sites item 112                 |
| CARD-06 | M   | A card shows the preview image of the other site, small, stored on the notes host, with the source name visible. A card without an image is the compact card               | sites item 105h                |
| CARD-07 | M   | A reader who opens a note makes no request to the site of a card                                                                                                           | sites item 105                 |
| CARD-08 | M   | Lines inside code blocks, inline code, comments and frozen query output are never read as `LINK` lines                                                                     | sites item 101                 |
| CARD-09 | M   | A line with only a YouTube URL in image syntax becomes a video card: a local image and a title. The player loads only after a click. Without JavaScript the card is a link | round 2 req. 1, sites item 323 |
| CARD-10 | M   | Each external link card adds a `citation` entry to the structured data of the note. Each video card adds `VideoObject` data                                                | sites items 332, 333           |
| CARD-11 | M   | The Markdown form writes each card as a list item with title, URL and description                                                                                          | sites item 311                 |
| CARD-12 | M   | The grammar exists in two copies: this site has its own code, and the Ghost Publish plugin keeps its own. No shared package                                                | sites item 104                 |
| CARD-13 | W2  | Link library: one generated page lists every link card of the site, grouped by site and by topic                                                                           | sites items 237, 335           |

#### 11.2.3 Note page

The order is decided (decisions, spec 9.4.2):

1. Breadcrumb.
2. Title with dates and type badge.
3. "In short" box.
4. "Part of".
5. Properties, closed by default.
6. Content.
7. Related notes.
8. Ad.
9. Backlinks with context.
10. Local graph.
11. Newsletter.

The outline is a side column on wide screens.

| Id      | Rel | Requirement                                                                                                                                                                            | Source                                        |
| ------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| PAGE-01 | G   | The full text of a note, its dates and its backlinks are in the HTML that the server sends                                                                                             | v1 8.1 stories 1, 2, seo item 164             |
| PAGE-02 | G   | Properties panel, rendered at build time, closed by default, with the display rules of today. Tags link to tag pages. Link properties link to their note when it is published          | v1 9.3, state 1.7                             |
| PAGE-03 | G   | Backlinks with the sentence around each link. For a note with very many backlinks, the rest is on its own page                                                                         | v1 8.1 story 6, seo item 56                   |
| PAGE-04 | G   | An outline of the note. On small screens: a sticky "current section" bar. The outline shows from a minimum number of headings                                                          | v1 8.1 story 7, sites item 316                |
| PAGE-05 | G   | Created and updated dates near the title                                                                                                                                               | v1 8.1 story 19                               |
| PAGE-06 | G   | Local graph of the note, with a list view of the neighbors for screen readers and small screens                                                                                        | v1 8.1 story 9, v1 9.5                        |
| PAGE-07 | G   | The layout, the navigation and the search work on a small screen                                                                                                                       | v1 8.1 story 18                               |
| PAGE-08 | M   | "In short" box: a note with a `description` shows it under the title, with the matching structured data                                                                                | sites items 321, 331                          |
| PAGE-09 | M   | "Part of": the maps of content that hold the note                                                                                                                                      | v1 9.4, seo item 54                           |
| PAGE-10 | M   | Related notes, from links and shared tags, before the ad. Issue 13 collects later ideas                                                                                                | decisions D26, sites item 320                 |
| PAGE-11 | M   | A strip for a note that belongs to an ordered set, with "you are here"                                                                                                                 | sites item 319                                |
| PAGE-12 | M   | Heading link buttons that copy a clean section URL                                                                                                                                     | sites item 315                                |
| PAGE-13 | M   | Reading progress bar on all pages, as on the main site                                                                                                                                 | round 2 req. 2, sites item 281                |
| PAGE-14 | M   | Download a note as Markdown. Copy a note as Markdown                                                                                                                                   | v1 8.1 stories 15, 16                         |
| PAGE-15 | M   | Media notes have a layout that starts from their data: a visible key facts box from the main properties, then the text of the author when it exists. No empty section and no empty row | v1 9.1, seo items 90, 159                     |
| PAGE-16 | M   | An author line, a "cite this note" block with the license, a share row, a back-to-top button. Their place on the page is set on the mockups                                            | seo items 160, 161, sites items 286, 297, 308 |
| PAGE-17 | M   | One line of context on each page for a reader who arrives from a search                                                                                                                | v1 8.1 story 41                               |
| PAGE-18 | M   | A note that an AI wrote shows a visible disclosure line. The `ai_generated` property of the note drives it, for any note type                                                          | seo item 190, consequence 31                  |
| PAGE-19 | M   | A note that also exists on the main site shows a visible line with a link to the post there                                                                                            | seo item 100, ADR 0010                        |
| PAGE-20 | M   | Every image has a width, a height and an alternative text. A cover gets a generated alternative text from properties                                                                   | seo items 63, 66                              |

#### 11.2.4 Navigation, breadcrumb and lists

| Id     | Rel | Requirement                                                                                                                                                                                                                                                                                                                                                                  | Source                         |
| ------ | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| NAV-01 | G   | Header on every page: the site name (it leads home), search, the switch of the mode                                                                                                                                                                                                                                                                                          | decisions D54, v1 9.4          |
| NAV-02 | G   | Home page with this content, in this order: hero with one sentence and the search, entry points by topic, entry points by note type, recently added and recently updated, a stats line, newsletter. The "start here" block with featured notes and maps comes after the hero, and it is hidden while no note is featured. No note is featured at the first release (issue 2) | decisions (spec 9.4.6), R16    |
| NAV-03 | G   | Type hubs: one generated page per note type, paginated, with the page number in the path. They are the crawl path to every note. The media types form a library section                                                                                                                                                                                                      | seo items 45, 59, decisions D8 |
| NAV-04 | G   | Tag pages: a tag leads to a page with its notes                                                                                                                                                                                                                                                                                                                              | v1 8.1 story 25                |
| NAV-05 | G   | "Recently added" and "recently updated" pages, for all note types, with a filter                                                                                                                                                                                                                                                                                             | decisions D14                  |
| NAV-06 | G   | A useful 404 page with search                                                                                                                                                                                                                                                                                                                                                | v1 8.1 story 21                |
| NAV-07 | G   | Every indexable note is reachable from the home page through plain links in at most four steps. A build check walks the links                                                                                                                                                                                                                                                | seo item 59                    |
| NAV-08 | M   | Breadcrumb on all pages, visible and as `BreadcrumbList` data with the same items. It follows the note type: Home, type hub, note (rule below)                                                                                                                                                                                                                               | seo item 184, decisions R16    |
| NAV-09 | M   | Tag pages and type hubs share one structure: description, best notes, list, one ad, feed link, structured data. One card component in four sizes serves all lists                                                                                                                                                                                                            | sites items 317, 318           |
| NAV-10 | M   | A complete index of all notes: a paginated plain list                                                                                                                                                                                                                                                                                                                        | sites item 334                 |
| NAV-11 | M   | Filters and sort orders on type hubs and in the search run in the browser. Their state lives in the URL fragment. The build writes no link with a query to a generated page                                                                                                                                                                                                  | seo item 47                    |
| NAV-12 | M   | Footer with links to the main site and to the store, and product links from the store catalog                                                                                                                                                                                                                                                                                | sites item 309, seo item 60    |
| NAV-13 | M   | Prefetch of internal links when the reader shows intent                                                                                                                                                                                                                                                                                                                      | sites item 341                 |
| NAV-14 | M   | RSS feeds: all notes, per note type, per tag, with the filtered feeds of the theme of the main site as the model. Each page links the feeds that match it. One page lists every feed. Item ids are stable for all time                                                                                                                                                       | round 2 req. 7, sites item 290 |
| NAV-15 | M   | A folder tree, loaded on demand. It is a secondary way in                                                                                                                                                                                                                                                                                                                    | v1 9.4                         |
| NAV-16 | M   | A local preview of the site for the author, to check a page before a publication                                                                                                                                                                                                                                                                                             | v1 8.2 story 55                |
| NAV-17 | W2  | Curated lists under `/-/lists/`, from one registry, each with an intro that the author wrote or approved. First families: owned games by mechanic, top rated per type, quotes about a topic, books on a topic, completed or abandoned. The family "people behind a topic" waits                                                                                              | seo items 92 to 94, 181        |
| NAV-18 | W2  | Stacked pages, as a progressive enhancement on plain links. The first feature after the switch                                                                                                                                                                                                                                                                               | decisions D36                  |
| NAV-19 | G   | A "gone" page for the answer 410 (URL-27): it says that the note was removed, with the search and a link to the home page. It shows no title and no content of the removed note. It is not indexed                                                                                                                                                                           | decisions R24                  |
| NAV-20 | M   | A server error page for the answer 500 (URL-33): a static file with no script and no detail of the failure, with a link to the home page                                                                                                                                                                                                                                     | decisions R24                  |
| NAV-21 | G   | An agent that asks for the Markdown form of a path that answers 404, 410 or 500 gets a short text with the same status code                                                                                                                                                                                                                                                  | decisions R24                  |

Breadcrumb rule (decisions R16):

1. A note: Home, the type hub of its note type, the note. A media note can add its library section between the type hub and the note (seo item 55).
2. A generated page: Home, then its kind (types, tags, lists, recent), then the page.
3. Folder notes are normal notes. They are not in the breadcrumb, and the names of vault folders never show as breadcrumb text.

Featured notes come later: a property on the note, which needs a new global property in the note system of the author and a list view. Issue 2 tracks it.

#### 11.2.5 Search, command palette, keyboard and graph

| Id       | Rel | Requirement                                                                                                                                                                                                                            | Source                                 |
| -------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| SRCH-01  | G   | Full-text search with results as the reader types, on a page under the reserved prefix. The index is rebuilt at each build and holds published notes only                                                                              | decisions D45, v1 9.6                  |
| SRCH-02  | G   | A fast index of titles and aliases loads first. Full text loads on demand                                                                                                                                                              | decisions D45                          |
| SRCH-03  | M   | Filters by note type and tag                                                                                                                                                                                                           | decisions D45                          |
| SRCH-04  | -   | No typo tolerance at the first release. The search must be able to evolve, so its interface hides the library. Pagefind is the first candidate, and the full-size build prototype confirms it                                          | decisions D45, v1 9.6                  |
| SRCH-05  | M   | Command palette with the command list of the research: go to a note, search the full text, open the graph, recent notes, random note, switch the mode, copy or download as Markdown, go to a tag or a type hub, and the small commands | sites items 129 to 142                 |
| SRCH-06  | M   | Keys: `/` and `Ctrl+K` open the palette. `?` shows the shortcuts sheet. The sequence `g` then `g` opens the graph when the focus is not in a field. No key of the browser is taken                                                     | sites items 143 to 147, consequence 30 |
| SRCH-07  | M   | One command registry feeds the palette, the key handler, the shortcuts sheet and the tools that the page registers for agents                                                                                                          | sites item 340                         |
| SRCH-08  | M   | The palette loads at its first opening, not with the page. Without JavaScript the search button is a link to the search page                                                                                                           | sites items 149 to 154                 |
| SRCH-09  | M   | The palette is a native dialog with the roles, the live region and the focus rules of the research                                                                                                                                     | sites items 163 to 170                 |
| GRAPH-01 | G   | Global graph that the reader can zoom, filter and search. The layout is computed at build time. Only published notes are nodes                                                                                                         | v1 8.1 story 10, v1 9.5                |
| GRAPH-02 | G   | The graph opens from a visible button                                                                                                                                                                                                  | sites item 147                         |
| GRAPH-03 | M   | The graph opens from the command palette and with `g` then `g`. A lighter view serves phones, by the result of the prototype                                                                                                           | sites item 147, v1 15.2                |

#### 11.2.6 Modes, newsletter and stats

| Id      | Rel | Requirement                                                                                                                                                                                                                                                                       | Source                              |
| ------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| MODE-01 | G   | A dark and a light mode. The page follows the system. Without a system preference the mode is dark. The reader can switch, and the choice is stored. No flash before the first paint                                                                                              | decisions D7, v1 9.14               |
| NEWS-01 | G   | A newsletter bar fixed to the bottom of the screen, with the states of today. It shows after 30 percent of the note, leaves before the footer and stays closed after a signup                                                                                                     | decisions D51, sites items 251, 326 |
| NEWS-02 | M   | One newsletter position inside long notes                                                                                                                                                                                                                                         | decisions D51                       |
| NEWS-03 | M   | A newsletter dialog for a reader who leaves, with the conditions of the main site and its own event                                                                                                                                                                               | sites item 259                      |
| NEWS-04 | G   | The form has no inline handler and no inline style. Its script is pinned and self-hosted. It calls the signup service of the main site, as today. The component hides that service                                                                                                | v1 9.11                             |
| STAT-01 | G   | The stats are pages of the notes site under the reserved prefix, built at each publication with the design of the site. They keep working at the switch. `stats.json` stays the data contract. The stats script keeps producing it and reads the published list from the manifest | v1 9.8, decisions R20               |
| STAT-02 | M   | The build adds public metrics to the stats page: most linked notes, hubs, orphans, notes per note type                                                                                                                                                                            | v1 9.8                              |

#### 11.2.7 Agent readiness

Everything is part of the first release (decisions D32).

| Id       | Rel | Requirement                                                                                                                                                                                                                                                        | Source                        |
| -------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| AGENT-01 | G   | `robots.txt` with the sitemap line and the signals of section 12.6. Sitemaps (section 12.4)                                                                                                                                                                        | v1 9.16, seo item 42          |
| AGENT-02 | M   | A Markdown URL per note (URL-10) and Markdown on request (URL-11). The Markdown form starts with a header block: title, canonical URL, author, dates, note type, license, content class                                                                            | seo item 156                  |
| AGENT-03 | M   | `Link` headers that point to the sitemap, the Markdown form and the feeds                                                                                                                                                                                          | v1 8.3 story 82               |
| AGENT-04 | M   | `llms.txt`: a small generated index with canonical links. No full-text file. Issue 10 collects possible evolutions                                                                                                                                                 | seo item 191                  |
| AGENT-05 | M   | API catalog, agent skills index, MCP server card and ARD manifest, generated by the build                                                                                                                                                                          | decisions D32                 |
| AGENT-06 | M   | WebMCP tools in the page, from the command registry (SRCH-07)                                                                                                                                                                                                      | decisions D32, sites item 340 |
| AGENT-07 | M   | The remote MCP server of section 7.7                                                                                                                                                                                                                               | decisions D32                 |
| AGENT-08 | M   | A scanner run for agent readiness is recorded per release                                                                                                                                                                                                          | v1 10                         |
| AGENT-09 | M   | Public data files for other sites and agents carry an open CORS header, a short cache time and an envelope with a schema reference                                                                                                                                 | sites item 305                |
| AGENT-10 | M   | Nothing leaves in bulk at the first release: no topic pack, no full-text file, no JSON API in bulk. The remote MCP server returns a few notes per call (MCP-06). The small `llms.txt` index stays. Which note types may leave in bulk later is tracked in issue 14 | decisions R16                 |

### 11.3 Second wave

In this order where an order is decided:

1. Stacked pages (NAV-18). First feature after the switch (decisions D36).
2. The second theme `classic`, with the values of the theme of the main site (section 15).
3. Link library (CARD-13).
4. Curated lists (NAV-17).
5. The second-wave items of the SEO research: `sameAs` and identifiers per note type, the generated summary on person notes, an image sitemap for the author's own images only (seo SEO-053 to SEO-055).

### 11.4 Not placed in a release

These stay ideas until the author picks them: hover preview of internal links, image zoom, "on this day", history of a note, quote of the day, quote as an image card, graph time-lapse, questions answered from the notes, scheduling, tests of ad variants, the most visited notes, a weekly note of what readers looked for (v1 8, S and C stories). The GitHub issues hold more: featured content (2), reader mode (4), Web Clipper templates (5), related notes (13).

## 12. SEO and AI search

SEO and visibility in AI answers are of critical importance (decisions, round 2, requirement 3). The base is the requirement list of the SEO research (seo section F: SEO-001 to SEO-055, AIS-001 to AIS-026). This section states what the decisions of round 5 fixed or changed. A ticket cites the id of this spec and the id of the research.

### 12.1 Titles and descriptions

| Id     | Rel | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Source                      |
| ------ | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| IDX-01 | G   | One title pattern per note type. The patterns follow the note type definitions. The note type shows as a badge on the page and as a word of the title pattern. The title ends with the site name                                                                                                                                                                                                                                                                                                                                                                                                          | seo item 183, decisions R16 |
| IDX-02 | G   | The site name is new from the first day. It is decided on the mockups (OPEN-06)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | seo item 183, decisions D54 |
| IDX-03 | G   | Display title, a working rule to confirm on the mockups (OPEN-08): the `title` property when it is defined, not empty, and different from the file name (the prefix and suffix of the note type are ignored in that comparison: a tool of the vault can fill the property with the file name, and such a value says nothing, decisions R23). Else the first level-one heading of the note, because the author often writes a nicer name there. Else the file name. In every case the prefix and the suffix of the note type are removed, with the note type definitions. The URL keeps the full file name | seo item 183, decisions R16 |
| IDX-04 | G   | No two indexable pages share a title or a description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | seo item 15                 |
| IDX-05 | G   | The description comes from the `description` property. Without one, the build writes it from the properties of the note, with the data that only this site has first. No empty slot                                                                                                                                                                                                                                                                                                                                                                                                                       | seo items 9 to 11           |
| IDX-06 | M   | A copied synopsis of a media note stays out of the generated description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | seo item 187                |
| IDX-07 | G   | One `<h1>` per page, equal to the main part of the title. Open Graph and Twitter tags on every page, with an image                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | seo items 16, 61            |

### 12.2 Canonical URL and original (ADR 0010)

| Id     | Rel | Requirement                                                                                                                                                                                                                                                 | Source                     |
| ------ | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| IDX-10 | G   | Every indexable page has one absolute canonical link without query and without fragment. A note names itself, unless IDX-11 applies                                                                                                                         | seo item 17                |
| IDX-11 | G   | A note that also exists on the main site (article, newsletter, news post) names the URL of the post there as its original, in its canonical link. The note is still served under its vault path, and every redirect rule stays                              | ADR 0010                   |
| IDX-12 | G   | The site needs the real URL of each post. It comes from a property of the note, never from a slug. The publishing tool checks at publication that the post answers 200 and names itself (PUB-100). The build accepts the URL only with that recorded result | ADR 0010, seo item 22      |
| IDX-13 | G   | A note of IDX-11 without a verified URL is `noindex` until the URL is verified. The publication report lists these notes. The decision names articles and newsletters. This spec applies it to news posts too, because ADR 0010 sets one rule               | seo item 182, ADR 0010     |
| IDX-14 | G   | Notes of IDX-11 stay in the feeds and in the `llms.txt` index of the notes site. Only their canonical link names the main site. They stay out of the sitemaps and out of the IndexNow batches, which hold only URLs that name themselves                    | decisions R16, seo item 36 |
| IDX-15 | G   | Switch gate test: for each note of IDX-11, the notes site and the main site name the same URL. If each site names the other, search engines get a loop                                                                                                      | ADR 0010, consequence 20   |
| IDX-16 | G   | The Markdown form carries `noindex` and a canonical `Link` header to the page. It is never in a sitemap                                                                                                                                                     | seo item 23                |

### 12.3 What is indexed

| Id     | Rel | Requirement                                                                                                                                                                                       | Source            |
| ------ | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| IDX-20 | G   | Search engines may index every note. No `noindex` rule by note type. A per-note override stays possible                                                                                           | ADR 0004          |
| IDX-21 | G   | Every person note is indexed                                                                                                                                                                      | decisions Q3      |
| IDX-22 | M   | Generated pages that are indexed: home, type hubs, curated lists, tag pages with 5 notes or more, page 1 of the recent pages, the stats page, the author page                                     | seo item 179      |
| IDX-23 | M   | Generated pages with `noindex, follow`: smaller tag pages, folder lists, later recent pages, search, graph, backlink lists. A new kind of generated page is `noindex` until a rule says otherwise | seo items 48, 179 |
| IDX-24 | M   | A stub is indexed, shows no ad, stays out of curated lists and is counted per note type in the publication report                                                                                 | seo item 180      |
| IDX-25 | M   | A build guard fails when the number of indexable generated pages grows above a set share or step                                                                                                  | seo item 49       |
| IDX-26 | G   | The preview host answers `noindex` on every response. The production release has none on indexable pages                                                                                          | seo SEO-023       |

### 12.4 Sitemaps

| Id     | Rel | Requirement                                                                                                                                                                                   | Source                           |
| ------ | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| IDX-30 | G   | A sitemap index at `/sitemap.xml` and one file per group of note types, with the sitemap structure of the theme of the main site as the model. Only canonical, indexable URLs that answer 200 | seo items 35, 36, round 2 req. 7 |
| IDX-31 | G   | All sitemap files are live at the switch. "Stages" means the order of submission only                                                                                                         | seo item 178                     |
| IDX-32 | G   | `lastmod` is the date of the last significant update. One exception: at the switch, one time, every note carries the switch date. The visible dates and the feeds do not move                 | seo items 37, 177                |
| IDX-33 | M   | The notes that an AI wrote have their own sitemap file                                                                                                                                        | seo item 190                     |
| IDX-34 | -   | No image sitemap for cover images                                                                                                                                                             | seo item 186                     |
| IDX-35 | G   | IndexNow: the key file at the root, one full submission at the switch, then the changed, new and removed URLs at each publication                                                             | seo items 121, 123, 168          |

### 12.5 Structured data

| Id     | Rel | Requirement                                                                                                                                                        | Source                   |
| ------ | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| IDX-40 | M   | One JSON-LD graph per page, by note type, with the types of the research. Every value in the markup is also visible on the page                                    | seo items 72 to 74       |
| IDX-41 | M   | One author page with `ProfilePage` markup. Its URL is the author URL of every note                                                                                 | seo item 192             |
| IDX-42 | M   | An entity graph with fixed ids for the author and the publisher. The ids are written down so that the main site and the store can adopt them in their own projects | sites items 327, 329     |
| IDX-43 | M   | The rating of the author becomes `Review` markup. A score copied from another database never becomes markup                                                        | seo item 185             |
| IDX-44 | M   | A note that an AI wrote carries the matching markup and no human author                                                                                            | seo items 104, 190       |
| IDX-45 | M   | The structured data of a person note can use the properties that exist, until an allow list says otherwise                                                         | decisions consequence 15 |
| IDX-46 | M   | A product note carries no offer and no price in its markup. The store holds the offer                                                                              | seo item 102             |

### 12.6 AI use policy

Decision D33: search and AI input are allowed for all content. Training is allowed for the author's own text, and not for material of other people.

| Id    | Rel | Requirement                                                                                                                                                                                                                                            | Source                   |
| ----- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| AI-01 | G   | `robots.txt` allows every crawler on every URL. No AI crawler is blocked at the first release                                                                                                                                                          | seo items 188, 189       |
| AI-02 | M   | Content classes. Third-party class: quote notes of other people, tab and arrangement notes of works that are not in the public domain, cover images, and media notes. Own text: everything else                                                        | seo items 151, 187       |
| AI-03 | M   | The training rule for the third-party class is stated in the policy outputs only: the `Content-Signal` response header per content class, the content class in the header block of the Markdown form, and the license line. It has no technical effect | decisions consequence 32 |
| AI-04 | M   | `robots.txt` carries one signal line for search and AI input, without a training value, because the answer differs per content class                                                                                                                   | seo item 146             |
| AI-05 | -   | Not built at the first release: a training group in `robots.txt`, a 403 for training crawlers at the edge, `nocache` for Bing (seo AIS-002, AIS-008 to AIS-010). Issue 8 keeps the question                                                            | seo items 188, 189       |
| AI-06 | G   | The managed `robots.txt` of the hosting stays off, and its AI crawler policies allow search and agent traffic. A check after each deployment compares the live file with the build output                                                              | seo items 44, 152        |
| AI-07 | -   | No paid tracker for AI visibility                                                                                                                                                                                                                      | seo item 194             |

### 12.7 Thin pages

Every note is indexed, so the quality of thin pages matters (ADR 0004). The floor rises through data that the vault holds, never through generated prose (seo item 87):

1. Generated descriptions (IDX-05).
2. The data-first layout with the text of the author (PAGE-15).
3. Type hubs and, in the second wave, curated lists (NAV-03, NAV-17).

### 12.8 Success metric and monitoring

| Id     | Requirement                                                                                                                                                                                               | Source                         |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| IDX-50 | The success metric is: clicks from search to the note types with the author's own text. The thin types are watched apart                                                                                  | seo item 195                   |
| IDX-51 | The notes whose original is on the main site are not expected to rank on the notes host. The metric counts them apart                                                                                     | decisions consequence 20       |
| IDX-52 | The level of January 2026 is the goal. It is not a condition for the end of Obsidian Publish                                                                                                              | decisions R10, seo item 196    |
| IDX-53 | The baseline of search and analytics data exists before the switch, outside this repository                                                                                                               | seo item 117                   |
| IDX-54 | After the switch the author watches, per sitemap file and per note type: indexed share, recrawl coverage, crawler errors, clicks against the baseline. Counters per crawler class come from the edge logs | seo items 96 to 98, 127 to 133 |

## 13. Analytics and events

The author wants to know what works, what does not, and what leads to sales (decisions, round 2, requirement 4). A better configuration of the analytics tool is a task of the author (decisions R12). This section covers what the site sends.

| Id    | Rel | Requirement                                                                                                                                                                                         | Source                         |
| ----- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| AN-01 | G   | Plausible through the existing proxy, with the current site id, so that numbers stay comparable. The preview host uses a test site id. No cookies                                                   | v1 9.9, business rule 9        |
| AN-02 | G   | The `cta_clicked` event keeps its name and its five properties: `product`, `position`, `slot`, `page`, `href`. The goal exists on the current site, so ad clicks have a baseline                    | decisions R9                   |
| AN-03 | G   | An event for the 404 page                                                                                                                                                                           | decisions R9                   |
| AN-04 | M   | One analytics method: one listener driven by data attributes, calls that cannot break the page, and one naming rule for every new event                                                             | sites item 328                 |
| AN-05 | M   | One event dictionary lists every event with its properties and its reason                                                                                                                           | sites item 291                 |
| AN-06 | M   | Events: ad seen, search used, search without result, Markdown downloaded or copied, graph opened, newsletter subscribed, outbound link, mode switched, link to a note that is not published clicked | v1 9.9                         |
| AN-07 | M   | More events: scroll depth, note read to the end, section link copied, palette opened, palette command run, link card clicked, video played, share used, newsletter dialog shown                     | sites items 259, 291           |
| AN-08 | M   | A search event sends the text of the search. A search text can hold personal data                                                                                                                   | sites item 292, consequence 24 |
| AN-09 | M   | A page "what this site records" lists every event from the dictionary and says plainly that the text of every search is recorded                                                                    | sites items 272, 292           |
| AN-10 | M   | Every ad carries position and topic attributes, and each position is tracked apart                                                                                                                  | sites item 325                 |
| AN-11 | M   | Links to the store carry campaign parameters, so that the path from a note to a purchase is visible in the analytics of the store                                                                   | v1 8.4 story 95                |
| AN-12 | M   | Counters per note type and per class of crawler (search index, fetch on request, training), without personal data                                                                                   | seo items 97, 170              |

Known fact for the baseline: every ad click of today comes from the ad strip at the end of a note (decisions, facts of round 4).

## 14. Ads and the store relationship

### 14.1 Ads

| Id    | Rel | Requirement                                                                                                                               | Source                        |
| ----- | --- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| AD-01 | G   | An ad at the end of a note that matches the topic of the note, at least as good as today                                                  | v1 8.4 story 88               |
| AD-02 | G   | Matching fix: single words of a note title no longer match a product                                                                      | decisions R3                  |
| AD-03 | M   | Ad format: one product and one free resource per ad block                                                                                 | sites items 249, 325          |
| AD-04 | M   | Positions: end of note, side column, inside long notes. Positions inside the text are computed at build time                              | decisions D31, sites item 294 |
| AD-05 | M   | Offer map: a map that the author sets by hand (topic to product and free resource) wins over the matching score                           | sites items 250, 337          |
| AD-06 | M   | A fallback ad (the newsletter or a free resource) when no product matches                                                                 | decisions D31                 |
| AD-07 | M   | A count of how often an ad is seen, so that a click rate exists                                                                           | decisions D31                 |
| AD-08 | M   | Buy box: a note that describes a product shows name, price and button from the store catalog at its top                                   | sites items 255, 338          |
| AD-09 | M   | The ad is complete in the HTML. A script only refreshes the price from the store catalog                                                  | sites items 294, 324          |
| AD-10 | M   | Space for an ad is reserved in the layout. An ad never shifts content                                                                     | v1 9.10                       |
| AD-11 | M   | No ad on a stub. No ad on person notes, quote notes and the home page, as today. The exclusions are a configuration per note type         | seo item 180, v1 9.10         |
| AD-12 | M   | A note can override: no ad, or named products                                                                                             | v1 9.10                       |
| AD-13 | M   | A link card to a product counts as an ad, with its own position value                                                                     | sites item 108                |
| AD-14 | M   | Links to the store point to the final store URL, without a redirect. This depends on the canonical host of the store (section 20, DEP-08) | v1 8.4 story 95               |
| AD-15 | M   | A "why this ad" link explains: own products only, matched by topic                                                                        | v1 9.10                       |
| AD-16 | -   | The Gumroad script is dropped                                                                                                             | decisions D27                 |

### 14.2 The store catalog is the contract

Everything about products needs a strong relationship with the store, which stays a separate thing (decisions, round 5, requirement 2).

| Id     | Rel | Requirement                                                                                                                                                                     | Source                         |
| ------ | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| CAT-01 | G   | Ads, the buy box, the offer map and live prices all read the store catalog (`products-light.json`). Nothing in this project holds a copy of a price or a product name as source | decisions consequence 27       |
| CAT-02 | G   | The shape of the catalog is a contract. A schema in this repository lists the fields that the site reads. A test of that shape blocks a release                                 | consequence 27, `AGENTS.md`    |
| CAT-03 | M   | A change on the store side is visible to this project: a check that runs without a release of this project reads the live catalog and reports a break of the schema             | decisions consequence 27       |
| CAT-04 | G   | This project changes nothing in the store. A need on the store side is a dependency (section 20)                                                                                | ADR 0001                       |
| CAT-05 | M   | When the catalog cannot be read at view time, the ad shows the data of the build. A page never breaks because of the catalog                                                    | sites item 324                 |
| CAT-06 | -   | The PKM Library becomes a part of the site later. It waits for the login of issue 1 and is not part of the first release                                                        | round 5 req. 5, consequence 28 |

## 15. Design

### 15.1 Decided

| Id     | Rel | Decision                                                                                                                                                                                                                                                                                                                                                                             | Source                                |
| ------ | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| DES-01 | G   | Brand: the Knowii web palette and components                                                                                                                                                                                                                                                                                                                                         | `AGENTS.md`, state 5                  |
| DES-02 | G   | Every color, font, radius, shadow and motion value is a token, from the first commit. A theme is one set of token values with a light and a dark mode                                                                                                                                                                                                                                | decisions D35, sites items 191 to 207 |
| DES-03 | G   | One theme at the first release: `knowii`. Dark is the default mode when the system states no preference                                                                                                                                                                                                                                                                              | decisions D7, D35                     |
| DES-04 | M   | The first release ships the token contract, the contrast gate and the theme lab page                                                                                                                                                                                                                                                                                                 | decisions D35                         |
| DES-05 | G   | Links and focus rings get a color that passes contrast on the dark background. The brand magentas stay for fills, borders and decoration. The light palette is completed                                                                                                                                                                                                             | state 5, v1 9.14                      |
| DES-06 | G   | Paragraphs: left-aligned text without hyphenation, set by two tokens                                                                                                                                                                                                                                                                                                                 | decisions (spec 9.2.10)               |
| DES-07 | G   | The content and the order of the home page (NAV-02) and the order of the note page (section 11.2.3)                                                                                                                                                                                                                                                                                  | decisions (spec 9.4.6, 9.4.2)         |
| DES-08 | G   | Fonts are self-hosted and subset                                                                                                                                                                                                                                                                                                                                                     | v1 9.14                               |
| DES-09 | M   | Motion values are tokens. One rule removes motion when the reader asked for less                                                                                                                                                                                                                                                                                                     | sites item 303                        |
| DES-10 | W2  | The second theme is `classic`, with the values of the theme of the main site. Fonts load per theme                                                                                                                                                                                                                                                                                   | decisions D35                         |
| DES-11 | G   | Accessibility: semantic HTML, keyboard access, visible focus, WCAG AA, a skip link, native dialogs with focus return, live regions for messages                                                                                                                                                                                                                                      | v1 9.14, sites item 302               |
| DES-12 | G   | The design is built with Tailwind 4. The tokens of DES-02 are Tailwind theme variables, and components use the Tailwind utilities that read them. The mockups use the Tailwind setup of the site, so that the chosen variant carries over to the build. The rules for Tailwind (utilities first, `@apply` for component classes, tokens only, no default palette) are in `AGENTS.md` | decisions R25                         |

### 15.2 Waits for the mockups

The mockups decide (decisions R14): two static variants of the home page and of the note page in the `knowii` theme, on a prototype branch. The author picks.

1. The look of the home page and of the note page.
2. The site name. The mockups propose names. The author also finds a name with his own name or with his handle interesting (decisions D54).
3. The display of titles (OPEN-08).
4. The place of the author line, the key facts box, the "cite this note" block and the share row (PAGE-15, PAGE-16).

## 16. Performance and speed

### 16.1 Publishing tool

The interactive part of a publication must be fast and must never block or slow Obsidian. This is a major reason for the project. The work behind it can take longer, as long as it runs in the background (decisions, round 5, requirement 1). Performance of the tool is a release criterion, like the page budgets (decisions consequence 22).

The risk is the interface thread of Obsidian. So the budgets are of two kinds. **Automated**: a test measures it, on a fixture of full size and on the real vault. **By hand in Obsidian**: the author checks it in Obsidian on the real vault, with numbers that the plugin records, because no automated test can see the interface of Obsidian.

| Id      | Measure                                                                                                                                                                | How it is checked                                                          | Budget                                                                                                        |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| PERF-01 | Time from the command "open the publication center" to the lists with their counts on screen. The lists can show the last known state, with a mark, while a check runs | By hand in Obsidian                                                        | To set from the prototype                                                                                     |
| PERF-02 | Time to see the plan: from the end of an edit of a few notes to a current publication plan                                                                             | Automated for both implementations. By hand in Obsidian for the plugin     | To set from the prototype                                                                                     |
| PERF-03 | Time of a full check of the vault with no stored state (the first run on a device)                                                                                     | Automated for both implementations. It runs in the background              | To set from the prototype                                                                                     |
| PERF-04 | Time to start a publication: from the click on "Publish" (or the `publish` command) to the message that the publication started                                        | Automated for the command line program. By hand in Obsidian for the plugin | To set from the prototype                                                                                     |
| PERF-05 | Longest time during which the interface of Obsidian does not answer, in any step of the plugin                                                                         | By hand in Obsidian. The plugin records the longest pause                  | To set from the prototype                                                                                     |
| PERF-06 | Time that the plugin adds to the start of Obsidian                                                                                                                     | By hand in Obsidian                                                        | To set from the prototype                                                                                     |
| PERF-07 | Time from a change of a filter or of a selection to the updated list, with the full "unchanged" list loaded                                                            | By hand in Obsidian                                                        | To set from the prototype                                                                                     |
| PERF-08 | Time from the click to live                                                                                                                                            | Automated: measured and shown in each publication report                   | Not a gate. The author named "under 1 minute" first, then said that it matters less than the interactive part |

Rules:

| Id      | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                            | Source                   |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| PERF-10 | No step of the tool blocks Obsidian. Long work runs in the background, in small parts that yield, and shows its progress                                                                                                                                                                                                                                                                                                                        | round 5 requirement 1    |
| PERF-11 | The author can close the view and continue to write while a publication runs                                                                                                                                                                                                                                                                                                                                                                    | round 5 requirement 1    |
| PERF-12 | The "unchanged" list holds more than 20,000 rows from the first day. The view stays within PERF-07 with that list                                                                                                                                                                                                                                                                                                                               | tool V19                 |
| PERF-13 | The budgets are measured on the real vault, with more than 20,000 published notes, in both implementations. The prototype measures the Rust program as the headless slice, and the TypeScript logic inside a running Obsidian (PROTO-04)                                                                                                                                                                                                        | consequence 22, tool K1  |
| PERF-14 | A version of the tool that breaks a budget of PERF-01 to PERF-07 does not ship                                                                                                                                                                                                                                                                                                                                                                  | decisions consequence 22 |
| PERF-15 | An automated test on a fixture of full size guards each automated budget between two measurements on the real vault                                                                                                                                                                                                                                                                                                                             | follows from PERF-14     |
| PERF-16 | Every network fetch of the tool (the content store, the deployment record, link metadata, the check of posts on the main site) runs in the background and never blocks the view. Offline rule: without a network the tool shows the last known state with a mark and can compute a plan, and it cannot publish. A link card whose metadata could not be read keeps its last entry. A post that could not be checked stays not verified (IDX-13) | follows from PERF-10     |
| PERF-17 | The budgets that are checked by hand form one checklist. The author runs it in Obsidian on the real vault before each release of the plugin, and the result is recorded                                                                                                                                                                                                                                                                         | follows from PERF-14     |

### 16.2 Pages

| Id      | Rel | Requirement                                                                                                                                                                                                                              | Source               |
| ------- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| PERF-20 | G   | The default note page has a budget that blocks a release: HTML, one small CSS file, one small script. The numbers are to set from the note page prototype                                                                                | decisions D30        |
| PERF-21 | G   | Exempt page types (music, graph, search) are named, each with its own budget. To set from the prototype                                                                                                                                  | v1 9.14              |
| PERF-22 | G   | CI checks the budgets on a sample of each note type and fails when a page type exceeds its budget                                                                                                                                        | v1 8.5 story 110     |
| PERF-23 | G   | The budgets in CI are stricter than the field targets: Largest Contentful Paint at most 2.5 s, Interaction to Next Paint at most 200 ms, Cumulative Layout Shift at most 0.1, at the 75th percentile                                     | seo items 68, 69     |
| PERF-24 | G   | No client-side framework on note pages. No layout shift from late content                                                                                                                                                                | v1 9.14              |
| PERF-25 | G   | Images: responsive sizes, modern formats, lazy loading, dimensions set. The first image of a media note loads with priority                                                                                                              | v1 9.14, seo item 66 |
| PERF-26 | G   | Large data (folder tree, backlinks of hub notes, graph, indexes) never sits in the HTML of a page                                                                                                                                        | v1 9.14              |
| PERF-27 | M   | A note page loads from the hosts of the notes site and from the analytics proxy only. Two calls go to other hosts of the author, and both come after the page shows: the price refresh from the store catalog, and the newsletter signup | sites item 313       |
| PERF-28 | G   | The build has budgets too: time and peak memory for a cold build, for a change of one note and for a change of the layout. To set from the full-size build prototype                                                                     | v1 5.6, v1 15.2      |

## 17. Security, licenses and legal

| Id     | Rel | Requirement                                                                                                                                                   | Source                   |
| ------ | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| SEC-01 | M   | A Content Security Policy that is as strict as the features allow, plus the usual security headers                                                            | v1 9.15, sites item 304  |
| SEC-02 | G   | Scripts of other parties are self-hosted and pinned. No feature of the hosting injects scripts                                                                | v1 9.15                  |
| SEC-03 | G   | Credentials never sit in the vault or in this repository. This repository is public, the content store is private                                             | v1 9.15, `AGENTS.md`     |
| SEC-04 | M   | Frames load from the no-cookie video host only, and only after a click. The click is the consent for the embed                                                | sites item 121           |
| SEC-05 | M   | Rate limits protect the site and the remote MCP server. Verified search crawlers are exempt (URL-32)                                                          | v1 9.15, seo item 33     |
| SEC-06 | G   | The content build is private, and the public CI of this repository never sees the content store. No public log shows note content or the deny list (BUILD-11) | `AGENTS.md`              |
| LIC-01 | G   | License of the code: MIT                                                                                                                                      | decisions D29            |
| LIC-02 | M   | License of the author's own text: CC BY-NC-SA 4.0                                                                                                             | decisions D29            |
| LIC-03 | M   | Product documentation and transcripts: all rights reserved                                                                                                    | decisions D29, D47       |
| LIC-04 | M   | Material of other people (quotes, covers, tabs) has no license from the author                                                                                | decisions D29            |
| LIC-05 | M   | Each note shows its license line. The line follows a rule per note type or folder                                                                             | decisions consequence 33 |
| LEG-01 | M   | Legal pages, the page "what this site records" (AN-09), and a contact path for a person who asks for a removal                                                | v1 9.17                  |

## 18. Testing Decisions

### 18.1 What makes a good test

1. A test checks external behavior through the interface of a module. It does not check internals (`AGENTS.md`). A test that breaks when the code is rewritten with the same behavior is a bad test.
2. All code is built test first, one slice at a time.
3. Test data comes from the fixture vault, which holds invented notes only. Nothing from the real vault enters this repository.
4. The view of the plugin cannot be verified by an automated test or by an agent. The author checks it in a real vault. So every rule sits behind SEAM-01 and SEAM-02, and the view only shows data.

### 18.2 Test seams

As few as possible, each as high as possible. Every automated test of this spec goes through one of these seven seams. SEAM-03 (parity) is gone: parity is a comparison of two outputs, not a seam.

| Id      | Seam                                           | What goes in                                                                                                                 | What is checked                                                                                                                                                                                                                                                                | Modules behind it                          |
| ------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| SEAM-01 | The publication plan as data                   | A state of the fixture vault with its rename journal, a manifest, a configuration of the tool, a selection                   | The four lists, the default selection, the guards, the forced removals, the stops (stale plan, deny list entry that matches no folder). Both implementations are run, and their plans are compared in the canonical form                                                       | MOD-01, MOD-02                             |
| SEAM-02 | The state after a publication                  | A plan that is applied on the fixture vault, with a content store and an attachment storage made for the test                | The content store (cleaned notes, manifest, former paths), the attachment storage, and the vault (the property corrections, and no other change). Also after a failure: refused push, failed upload. Both implementations are run, and their outputs are compared byte by byte | MOD-01 to MOD-03, MOD-16                   |
| SEAM-04 | The resolver, as a pure function and over HTTP | A table of requested paths and a resolver map. Over HTTP: requests against the preview host and against a plain local server | The answer for each path: page, redirect, "gone", "not found". Over HTTP also the status codes, the response headers (canonical, `noindex`, content signals, cache, `Vary`), Markdown on request, and the deployment record                                                    | MOD-04, MOD-05, MOD-09                     |
| SEAM-05 | The built site of a fixture content store      | A content store made from the fixture vault, with a recorded store catalog and stats data                                    | The files of the output: the HTML of pages, the Markdown forms, the indexes, the feeds, the sitemaps, the structured data, the files for agents, the resolver map, the ads that a page holds, the stats pages                                                                  | MOD-06 to MOD-08, MOD-11, MOD-13 to MOD-15 |
| SEAM-06 | The catalog contract                           | The store catalog: a recorded copy in the tests, the live one in the scheduled check                                         | The catalog matches the schema of the fields that the site reads                                                                                                                                                                                                               | MOD-12                                     |
| SEAM-07 | The tools of the remote MCP server             | Calls of `search` and `execute` over the protocol, on fixture data                                                           | The answers, the limits, the errors for hostile scripts and for a used-up budget, no bulk access (MCP-06)                                                                                                                                                                      | MOD-10                                     |
| SEAM-08 | The built fixture site in a browser            | The output of SEAM-05, opened in a real browser                                                                              | Only what exists in a browser: the analytics events that a page sends, the newsletter bar and dialog, the search, the command palette and the shortcuts, the switch of the mode, the video card, the page budgets, one screenshot per page type                                | MOD-13 to MOD-15                           |

Rules:

1. The commands of the command line program and the tools of the MCP server of the publishing tool are the entry points of SEAM-01 and SEAM-02 for the Rust implementation. One test checks that both offer the same operations.
2. The automated budgets of the publishing tool (section 16.1) are measured at SEAM-01 and SEAM-02.
3. Checks that are not automated tests: the view of the plugin and the budgets "by hand in Obsidian" (PERF-17), and the checks on live hosts at the switch (section 19.3). They are checklists, and their result is recorded.

### 18.3 Release gates

Each of these blocks a release when it fails:

| Id      | Gate                           | What it tests                                                                                                                                                                                                                                                                                                    | Source                      |
| ------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| TEST-01 | Guards                         | A note in a deny list folder and a note with `publish_ignore` reach no output: not the content store (SEAM-02), not the HTML, the Markdown form, the search index, the title index, the graph data or the feeds (SEAM-05), not the answers of the remote MCP server (SEAM-07). No face can select them (SEAM-01) | ADR 0011, `AGENTS.md`       |
| TEST-02 | URL contract                   | Table tests of the resolver with the name patterns of the real corpus (generated, not copied), the codes of section 10.2, and the tests of section 10.4 (SEAM-04)                                                                                                                                                | v1 10, `AGENTS.md`          |
| TEST-03 | Parity                         | For the fixture vault, the TypeScript and the Rust implementation give byte-identical output in the canonical form: the publication plan without its id and its time, the cleaned notes, the manifest (TOOL-06, compared at SEAM-01 and SEAM-02)                                                                 | ADR 0009                    |
| TEST-04 | Catalog shape                  | The store catalog matches the schema of CAT-02 (SEAM-06)                                                                                                                                                                                                                                                         | consequence 27, `AGENTS.md` |
| TEST-05 | Page budgets                   | PERF-20 to PERF-23 (SEAM-08)                                                                                                                                                                                                                                                                                     | decisions D30               |
| TEST-06 | Budgets of the publishing tool | The automated budgets of PERF-15 (SEAM-01, SEAM-02). The budgets by hand are a checklist (PERF-17), not a test                                                                                                                                                                                                   | decisions consequence 22    |
| TEST-07 | Contrast                       | The contrast of each text, link and focus pair of each theme and mode passes WCAG AA (SEAM-05)                                                                                                                                                                                                                   | sites item 342              |

### 18.4 Fixture vault

One invented note per feature and per trap: a link to a note on the deny list, a link to a note that is not published, an attachment in a deny list folder, a folder on the deny list, a move into that folder, a note with the ignore property, a new note that carries `public_note: true`, person data, a frozen query with a row from the deny list, a rename with a link cascade, a folder rename, a duplicate name, an alias collision, names with `+`, `%`, `&`, apostrophes, dots and non-ASCII characters, a name that ends like a file extension, a note in French with a twin, music blocks, every form of a `LINK` block, a note that also exists on the main site with and without a verified URL, a stub, a note with `ai_generated: true`.

Set by issue 17:

1. The fixture vault is `fixtures/vault/` at the root of the repository. The configuration of the tool for it is `fixtures/configuration.json`, and the fixture catalog is `fixtures/catalog.json`. Both implementations read the same files.
2. The fixture catalog declares each file of the fixture vault with the feature or the trap that it serves. A check refuses a file of the fixture vault that the catalog does not declare, a vault file outside the fixture vault, and a file of a private folder. It runs as a pre-commit hook and in the tests (GATE-05). It uses structure only: it cannot see the real vault.
3. No file name holds `?`. An earlier text of this section asked for one. Windows refuses that character in a file name, the Rust checks run on Windows, and a vault that is used on Windows cannot hold such a name. A `?` in a requested path is a case of the resolver tests (URL-12).
4. A test never writes into the fixture vault. A test that changes notes works on a copy.
5. The traps that are a change (a move into a deny list folder, a rename, a folder rename) are notes that a test moves or renames in its copy.
6. The test helper gives each test an empty content store (a bare git repository with no commit, which stands for the remote one) and an empty attachment storage (a folder, which stands for the object storage), and removes them after the test. It exists in TypeScript and in Rust.

### 18.5 Tests of the publication model

All through SEAM-01 and SEAM-02.

| Id      | Test                                                                                                                                                                                                                                                                                                                                      | Source                   |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| TEST-10 | A new note carries the property with the value true and was never published: the tool does not publish it, and it corrects the property                                                                                                                                                                                                   | decisions consequence 19 |
| TEST-11 | A published note has the property removed by hand: the note stays published, and the tool writes the property again                                                                                                                                                                                                                       | ADR 0008                 |
| TEST-12 | A new candidate is never selected by default, in the view and in a plan without paths                                                                                                                                                                                                                                                     | ADR 0008                 |
| TEST-13 | A published note that enters the deny list or gets the ignore property is removed by the next publication, whatever is selected, and answers 404                                                                                                                                                                                          | decisions K11, tool K10  |
| TEST-15 | A stale plan is refused. A publication that failed halfway can be run again with the same result. Two publications at one time cannot interleave                                                                                                                                                                                          | tool A28, GU15           |
| TEST-16 | Unpublish gives 410. Takedown gives 404, removes every derived output and the former paths                                                                                                                                                                                                                                                | v1 6.8                   |
| TEST-17 | The command line program and the MCP server of the tool offer the same operations, and each can build a selection with paths to include, to hold and to remove                                                                                                                                                                            | round 5 requirement 3    |
| TEST-18 | A link, an embed and a link in a property to a note that is not published show as plain text and lead to no page. The same holds for a note under a guard. The link appears when the target is published, with no change to the linking note                                                                                              | PUB-87, PUB-89           |
| TEST-19 | A folder of the deny list is renamed: the rename journal reports it and proposes the new path, every publication stops until the deny list holds it, and no note of that folder shows as a candidate                                                                                                                                      | GATE-38, PUB-91          |
| TEST-20 | Property correction: after a push, only the notes that the plan scanned and whose value differs from the manifest are written. A file that changed after the scan is skipped and reported. No file of the templates folder is written, and no note in a deny list folder is scanned or written. No correction happens when the push fails | PUB-13                   |
| TEST-21 | Failure cases: a refused push leaves a state that the next run recovers from, with no forced push. Uploads of a failed run that no manifest entry lists are deleted. A file that is missing on the device is never selected by default. A rename outside Obsidian with an edit is reported, and the note is not removed                   | PUB-93 to PUB-97         |
| TEST-22 | The review holds: the cleaned notes after a publication equal the text that the plan showed. The refresh of frozen lists ran before the plan                                                                                                                                                                                              | PUB-92                   |
| TEST-24 | With Obsidian closed, the command line program publishes a note with a frozen list as it is saved, and the plan marks it "lists not refreshed"                                                                                                                                                                                            | PUB-101                  |
| TEST-25 | A plan that an agent asks for without paths holds changed notes only. A first publication, an unpublish and a takedown happen only for the paths that the request names                                                                                                                                                                   | PUB-52, PUB-54           |

### 18.6 Tests of renames (ADR 0007)

All through SEAM-01 and SEAM-02. The rename journal is part of the vault state that goes in.

1. A restart of Obsidian between a rename and the publication.
2. A folder rename that touches many notes.
3. A rename together with an edit.
4. A second machine: one device renames, another publishes.
5. A rename that the plugin did not see: the pairing shows, and the old path becomes a redirect after the author confirms.
6. A rename outside Obsidian together with an edit (PUB-96, TEST-21).
7. A rename of a folder of the deny list (TEST-19).

### 18.7 Tests on the real vault

Three facts are tested on the real vault before the design of the plugin is final (tool K15): whether the `obsidian` command line program waits for a handler that runs long, whether a folder rename gives one event per file, and whether the REST and MCP server plugin exposes handlers that another plugin registered. The first and the third were asked before ADR 0009. The headless slice says which of them still matter (OPEN-12). It also writes a private report of what the guards exclude, and it gives the first numbers for section 16.1. Results with private counts stay outside this repository.

### 18.8 Other tests

1. One snapshot per Markdown feature, and the adopt check corpus of issue 12 (SEAM-05).
2. Ads: the ad that each fixture page holds, written after the fix of AD-02 (SEAM-05).
3. Build output: every written URL is canonical (URL-13), a link check, an HTML check, an accessibility check, unique titles and descriptions (IDX-04), the link walk of NAV-07 (SEAM-05).
4. Each discovery file for agents (SEAM-05), Markdown on request (SEAM-04), and a recorded scanner run per release.
5. The events that a page sends, the newsletter bar and dialog, the search, the command palette and the shortcuts (SEAM-08).
6. One screenshot per page type, theme and mode (SEAM-08, sites item 307).
7. `astro check` joins the definition of done with the first Astro code.

### 18.9 Prior art

1. The guard tests of the tooling in `scripts/` show the form: a spec file next to the code, run with the test script of the repository.
2. The Ghost Publish plugin of the author has specs for pure helpers and a simulation of several devices that share one settings file (tool GP18, H12). The device tests of this project start from it.
3. The plugin template of the author loads a mock of the Obsidian module before the tests (tool TP3). The TypeScript implementation uses the same setup.
4. The tests of the Ghost Publish plugin for `LINK` blocks give fixtures for the link card grammar (sites item 103).
5. The command line program of the Obsidian Starter Kit plugin is the model for the tests of the Rust program.

## 19. Migration and switch

### 19.1 Order

No dates. Each step needs the ones before it.

1. **Baseline and inventories**. Done in part: the analytics goals exist (decisions R9), the first redirect list exists (decisions R11), and the baseline of search and analytics data is collected outside this repository.
2. **Dependencies in other plugins** that must come before the new plugin (section 20, DEP-01 and DEP-02).
3. **Prototypes that decide** (section 21), and the mockups.
4. **Foundations**: repository tooling, tokens, fixture vault, resolver, the guards and the cleaning step in both implementations with parity tests, the content store.
5. **Headless slice** on the real vault: `status` and `plan`, with a private report of what the guards exclude.
6. **First tracer bullet**: one note of the fixture vault through every layer. The command line program publishes it to a content store, the build renders it, a deployment puts it on the preview host at its canonical URL, through the resolver, with the layout. Every later ticket widens this path.
7. **To the switch gate**: every G requirement.
8. **Switch** (19.3).
9. **First release after the gate**: the M requirements.
10. **Second wave** (11.3).

### 19.2 Switch gate

| Id    | Condition                                                                                                                                                                                                                                                                     | Source                          |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| SW-01 | Every G requirement of this spec passes on the preview host                                                                                                                                                                                                                   | decisions D6                    |
| SW-02 | The first version of the publishing tool works on the real vault: queue, select, publish, unpublish, takedown                                                                                                                                                                 | ADR 0003                        |
| SW-03 | The author read the private report of what the guards exclude and confirmed the deny list (PROTO-04). No note that is published today is excluded by mistake                                                                                                                  | ADR 0011, decisions R19         |
| SW-04 | The URL contract tests pass against the preview host, the first redirect list included (section 10.4, RES-01 to RES-08)                                                                                                                                                       | v1 11.2, decisions R11          |
| SW-05 | The parity tests pass (TEST-03)                                                                                                                                                                                                                                               | ADR 0009                        |
| SW-06 | The catalog shape test passes (TEST-04)                                                                                                                                                                                                                                       | decisions consequence 27        |
| SW-07 | The page budgets and the budgets of the publishing tool pass (TEST-05, TEST-06)                                                                                                                                                                                               | decisions D30, consequence 22   |
| SW-08 | The tests of the publication model and of renames pass (18.5, 18.6)                                                                                                                                                                                                           | ADR 0007, ADR 0008              |
| SW-09 | ADR 0010: the Ghost Publish plugin and the existing news posts are changed, and for each note that also exists on the main site both sites name the same URL (IDX-15)                                                                                                         | ADR 0010                        |
| SW-10 | The baseline is recorded outside this repository (IDX-53)                                                                                                                                                                                                                     | seo item 117                    |
| SW-11 | Nothing in the first release depends on Obsidian Publish after the switch: the stats script reads the manifest, the agents and skills of the author use the new tool, and the old reconciliation of the property is off                                                       | decisions consequence 16        |
| SW-12 | The site name is decided, and the author picked a mockup variant                                                                                                                                                                                                              | seo item 183, decisions R14     |
| SW-13 | The deny list holds its first content (GATE-11)                                                                                                                                                                                                                               | decisions consequence 12        |
| SW-14 | An inventory exists of the images that the main site and the store load from the host of Obsidian Publish. The move of those images is a dependency (DEP-13), not work of this project. Images in newsletters that were already sent cannot be fixed. The author accepts that | v1 11.2, ADR 0001               |
| SW-15 | The verifications of the search engine tools survive the switch. The IndexNow key file is in the build output                                                                                                                                                                 | seo items 115, 116, 121         |
| SW-16 | The settings of the hosting are ready: the managed `robots.txt` is off, search and agent traffic is allowed, no feature injects scripts, verified search crawlers are exempt from rate limits                                                                                 | seo item 120                    |
| SW-17 | The preview host is `noindex` and uses a test analytics id. The production release has no `noindex` on indexable pages                                                                                                                                                        | v1 11.2, seo SEO-023            |
| SW-18 | The stats pages and the stats tooling work (STAT-01), and the former stats host redirects (URL-17)                                                                                                                                                                            | v1 8.4 story 100, decisions R20 |
| SW-19 | A parity run of the two implementations on the real vault of the author passes (TOOL-06). Its results stay private                                                                                                                                                            | ADR 0009                        |

### 19.3 Switch of the notes domain

1. Run the first publication of the new tool for everything that is published (8.5), and deploy the production release.
2. Move the DNS record of the notes host to the new site.
3. Check from outside: `robots.txt` answers 200 and equals the build output, the sitemap index answers 200, a sample of notes answers 200 with the right canonical link, an unknown path answers 404, a variant takes one redirect.
4. Submit the sitemap index and each sitemap file to the search engines. All files are live. The order of submission starts with the note types with own text (seo item 95).
5. Send the IndexNow batches, one full submission, in the same order.
6. From this moment nothing updates Obsidian Publish.

### 19.4 After the switch

| Id     | Rule                                                                                                                                                                                       | Source               |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| MIG-01 | Obsidian Publish stays as a frozen backup. A revert of the DNS record shows the notes of the switch day. The author accepts that                                                           | decisions R6         |
| MIG-02 | The author cancels Obsidian Publish when the new site feels right. No condition and no metric. A private task of the author holds it                                                       | seo item 196         |
| MIG-03 | A revert brings the cut canonical URLs back for every page that a crawler fetches in that time. So a revert is for a broken site, not for a dip in traffic. A dip is expected after a move | seo items 112, 135   |
| MIG-04 | The 404 report of the first days feeds the redirect list (RES-09)                                                                                                                          | v1 11.3              |
| MIG-05 | The author compares search and analytics numbers with the baseline (IDX-50 to IDX-54)                                                                                                      | seo items 127 to 133 |
| MIG-06 | Images that search engines hold under the host of Obsidian Publish disappear when it is cancelled. No redirect is possible from that host                                                  | seo item 136         |
| MIG-07 | The publishing template of today is retired or reduced, and the review of the tool as a plugin for the community can start                                                                 | v1 17, decisions D18 |

## 20. Dependencies outside this project

This project does not do this work. It states the dependency and its order.

| Id     | Dependency                                                                                                                                                                                                                                                       | Where                                   | Order                                                            | Source                          |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------- | ------------------------------- |
| DEP-01 | The URL helper is aligned with the URL rule for names with `+`, `%`, `&` and `?`                                                                                                                                                                                 | Ghost Publish plugin                    | Before the new plugin is built                                   | decisions R7                    |
| DEP-02 | A dry mode and an error report                                                                                                                                                                                                                                   | Dataview Serializer                     | Before the new plugin is built                                   | decisions R7                    |
| DEP-03 | On the main site the visible text of a news post stays ("appeared first in my notes", with a link). Only the hidden canonical field changes: each news post names itself. The Ghost Publish plugin does that for new posts, and the existing posts are corrected | Ghost Publish plugin, main site         | Before or at the switch, never after                             | ADR 0010, decisions R21         |
| DEP-04 | The real URL of each article, newsletter and news post is written into its note                                                                                                                                                                                  | Vault, with the main site as the source | Before the switch. A note without it is `noindex` (IDX-13)       | decisions D24, ADR 0010         |
| DEP-05 | The agents and skills of the author that use Obsidian Publish move to the new tool                                                                                                                                                                               | Vault tooling of the author             | Before the switch                                                | decisions D12 (round 4)         |
| DEP-06 | The stats script reads the published list from the manifest. The publishing template stops its reconciliation                                                                                                                                                    | Vault tooling of the author             | Stats: before the switch. Template: before the first publication | v1 6.9, consequence 17          |
| DEP-07 | The store keeps the URL and the shape of the store catalog, or tells this project before a change                                                                                                                                                                | Store                                   | Always                                                           | consequence 27, business rule 8 |
| DEP-08 | The canonical host of the store, and a dead link in the theme of the main site                                                                                                                                                                                   | Store, main site                        | Not a gate. Private tasks of the author                          | decisions R8                    |
| DEP-09 | The main site and the store adopt the fixed entity ids of IDX-42                                                                                                                                                                                                 | Main site, store                        | Not a gate. In their own projects                                | sites item 329                  |
| DEP-10 | A better configuration of the analytics tool: what works, what does not, what leads to sales                                                                                                                                                                     | Analytics account of the author         | Not a gate. Task of the author                                   | decisions R12                   |
| DEP-11 | Closed. The review of the folder notes is a private task of the author and no longer a dependency                                                                                                                                                                | Vault                                   | None                                                             | decisions R16                   |
| DEP-12 | The notes of the vault that describe the publishing process and the infrastructure are updated when the workflow changes                                                                                                                                         | Vault                                   | With the switch                                                  | v1 17                           |
| DEP-13 | The images that the main site and the store load from the host of Obsidian Publish are moved                                                                                                                                                                     | Main site, store                        | Before the author cancels Obsidian Publish                       | v1 11.2, ADR 0001               |

## 21. Prototypes that decide

A prototype lives on a `prototype/<name>` branch and uses invented notes only, except the headless slice, which runs on the real vault and keeps its results private.

| Id       | Prototype                               | What it must answer                                                                                                                                                                                                                                                                                                                                                                                                   | If the answer is bad                                                                        | Source                                 |
| -------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------- |
| PROTO-01 | Hosting                                 | Does one Worker with static files plus object storage serve a site of full size: file count, path matching for every name pattern, one redirect per variant, HTML and Markdown apart, range requests, a release and a revert with no purge, the cost at crawler load                                                                                                                                                  | Move the release files to object storage with a manifest, or take the self-managed server   | decisions D3, hosting 6                |
| PROTO-02 | Full-size build                         | Time and peak memory for a cold build, a change of one note and a change of the layout. The time from a push of the content to live, in CI. How to make the build incremental                                                                                                                                                                                                                                         | Change the build design before any feature work                                             | decisions D43, R16, v1 15.2            |
| PROTO-03 | URL resolver                            | All variants in one redirect with the real name patterns, the codes of 10.2, the findings of 10.3, the size and the start time of the resolver map                                                                                                                                                                                                                                                                    | Change the place of the map                                                                 | v1 15.2, hosting 4.1                   |
| PROTO-04 | Publication plan of the publishing tool | On the real vault, two runs. The Rust program as the headless slice: the automated numbers of section 16.1, how it resolves links and note types, how it gets the credential for attachments (OPEN-12), and a private report of what the guards exclude (not a gate report). The TypeScript logic inside a running Obsidian: the numbers for PERF-01 and PERF-05 to PERF-07, because the risk is the interface thread | Change the design of the change detection (issue 11), or move work off the interface thread | tool K1, consequence 22, decisions R19 |
| PROTO-05 | Remote MCP server                       | The server behind one small interface for the executor. Both executors (QuickJS in WebAssembly, Dynamic Worker) with the same typical scripts: time, cost, limits, hostile scripts. The rate limit and the daily budget hold. The author decides with the numbers                                                                                                                                                     | The other executor, or a token for `execute`                                                | decisions Q6, R16, hosting 6           |
| PROTO-06 | Mockups                                 | Two static variants of the home page and of the note page in the `knowii` theme. They propose the site name                                                                                                                                                                                                                                                                                                           | A new round of variants                                                                     | decisions R14                          |
| PROTO-07 | Note page                               | The numbers of the page budgets (PERF-20, PERF-21)                                                                                                                                                                                                                                                                                                                                                                    | Change the page design                                                                      | decisions D30                          |
| PROTO-08 | Adopt check for the Markdown conversion | Do `astro-loader-obsidian` or the Quartz transformers fit, measured on the corpus of issue 12                                                                                                                                                                                                                                                                                                                         | Own code against the same corpus                                                            | decisions D49, issue 12                |
| PROTO-09 | Global graph                            | Is it usable on a phone at full size                                                                                                                                                                                                                                                                                                                                                                                  | A lighter view, or desktop only                                                             | v1 15.2                                |
| PROTO-10 | Music at build time                     | Can diagrams become SVG without a browser                                                                                                                                                                                                                                                                                                                                                                             | Keep the rendering in the browser                                                           | v1 15.2                                |

## 22. Risks

| Id      | Risk                                                                                                                                   | Effect                                    | Answer                                                                                                                                                       |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| RISK-01 | A note that should stay private goes live                                                                                              | Serious, and not reversible once crawled  | The author selects every note. The two guards and their tests. A new candidate is never selected by default. Takedown                                        |
| RISK-02 | No allow list exists, so every property of every published note is public                                                              | A property that should be private shows   | The author accepted it for now. Issue 6                                                                                                                      |
| RISK-03 | The publishing tool is on the path to the switch, and no bridge exists                                                                 | The slow site stays longer                | A small first version (TOOL-20 to TOOL-29), the headless slice first                                                                                         |
| RISK-04 | Every rule exists two times                                                                                                            | The two implementations drift apart       | The parity rule and its release gate (TEST-03)                                                                                                               |
| RISK-05 | The Rust program resolves a link in another way than Obsidian                                                                          | A wrong link target on the site           | TOOL-07, fixture notes for every link form, the headless slice on the real vault                                                                             |
| RISK-06 | A vault that is not fully synchronized looks like a mass removal, and no confirmation limit exists                                     | Many notes leave the site                 | An entry "missing from this vault" is never selected by default (PUB-95). The review step, the fetch of PUB-30, the device opt-in, the pairing step. Issue 9 |
| RISK-07 | A rename is missed                                                                                                                     | An old URL breaks                         | The rename journal, the pairing step, the tests of 18.6                                                                                                      |
| RISK-08 | An agent publishes more than the author wanted                                                                                         | Wrong content is live                     | Section 8.6: alone, an agent publishes only new versions of published notes. The rest needs the author                                                       |
| RISK-09 | A URL form that works today is missed                                                                                                  | Broken links from other sites             | The resolver, the tests of 10.4, the first redirect list, the 404 report                                                                                     |
| RISK-10 | The two sites name each other as the original                                                                                          | A loop for search engines                 | DEP-03 before or at the switch, the test of IDX-15                                                                                                           |
| RISK-11 | Notes that bring search traffic today hand their ranking to the main site                                                              | Less search traffic on the notes host     | The author accepted it (ADR 0010). The metric counts these notes apart                                                                                       |
| RISK-12 | Thin pages lower the quality signals of the host                                                                                       | Less search traffic                       | Section 12.7, monitoring per note type. A `noindex` by type stays a decision of the author                                                                   |
| RISK-13 | Search traffic drops after the switch                                                                                                  | Fewer readers                             | The baseline, correct signals, all sitemaps, IndexNow. A dip is expected                                                                                     |
| RISK-14 | A full build is too slow or too heavy, or passes a file limit of the hosting                                                           | Slow publications, or a failed deployment | PROTO-01, PROTO-02, the render cache, BUILD-08                                                                                                               |
| RISK-15 | The remote MCP server is public, and anyone can run scripts                                                                            | Cost or abuse                             | Rate limit, daily budget, row limits, a sandbox, PROTO-05, issue 7                                                                                           |
| RISK-16 | The store changes the catalog                                                                                                          | Wrong or missing prices on ads            | CAT-02, CAT-03, CAT-05                                                                                                                                       |
| RISK-18 | After the switch, a revert shows old content and the cut canonical URLs                                                                | A revert has a cost                       | MIG-01, MIG-03                                                                                                                                               |
| RISK-19 | The text of searches holds personal data                                                                                               | Personal data in the analytics            | AN-09 says it plainly. The author decided it                                                                                                                 |
| RISK-20 | Scope grows without end                                                                                                                | Nothing ships                             | The switch gate. Ideas go to GitHub issues and to the backlog                                                                                                |
| RISK-21 | Standards for agents change                                                                                                            | Checks fail later                         | Generated discovery files, a scanner run per release                                                                                                         |
| RISK-22 | A selected note holds something private: a secret, a private title in a link, a comment, metadata in an image. No content check exists | It goes live, as on the site of today     | The author accepted it (ADR 0011): he selects every note, and a measurement found no secret in the public notes. Issue 15 keeps the checks. Takedown         |

Stop conditions:

2. A publication of one note needs a full render, a full index and an upload of most files, and that is too slow for daily use: the build design changes.
3. The publishing tool blocks the switch: no fallback exists (ADR 0003). The answer is a smaller first version, never a bridge.

## 23. Open decisions

| Id      | Decision                                                                                                                                                                          | What depends on it                                                                          | Tracked in                                      |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| OPEN-01 | Closed for the first release: nothing in bulk (AGENT-10). Which note types may leave in bulk later                                                                                | Full-text files, topic packs, a JSON API in bulk                                            | The bulk outputs issue                          |
| OPEN-02 | Closed for now: `dsebastien-vault-publish` (TOOL-14). The name can change before any public release                                                                               | Nothing before a public release                                                             | Private task of the author                      |
| OPEN-03 | An allow list per property key (Q2)                                                                                                                                               | Section 9.4, person notes (D40), the structured data, the typed interface of the MCP server | Issue 6                                         |
| OPEN-04 | The executor of the remote MCP server. The author decides with the numbers of the prototype. SDKs and frameworks: issue 7                                                         | MCP-05, PROTO-01                                                                            | PROTO-05, issue 7                               |
| OPEN-05 | Closed. The ignore property is `publish_ignore`                                                                                                                                   | Nothing                                                                                     | Closed (decisions R16)                          |
| OPEN-06 | The site name (D54)                                                                                                                                                               | IDX-02, every title, SW-12                                                                  | Mockups (PROTO-06)                              |
| OPEN-07 | The look of the home page and of the note page (R14)                                                                                                                              | Section 15.2, every page ticket                                                             | Mockups (PROTO-06)                              |
| OPEN-08 | Titles: the working rule of IDX-03, to confirm on the mockups                                                                                                                     | IDX-01, IDX-03                                                                              | Mockups (PROTO-06)                              |
| OPEN-09 | Closed. The site is built in CI after a push of the content                                                                                                                       | Nothing                                                                                     | Closed (decisions R16)                          |
| OPEN-10 | Closed. An agent publishes alone only new versions of published notes (PUB-52, PUB-54). Size limits stay an idea                                                                  | Nothing                                                                                     | Closed (decisions R16). Issue 9 for size limits |
| OPEN-11 | Closed. The breadcrumb follows the note type (NAV-08)                                                                                                                             | Nothing                                                                                     | Closed (decisions R16)                          |
| OPEN-12 | How the Rust command line program gets the credential for attachments. The place of its code is settled: this repository (decisions R19)                                          | TOOL-13                                                                                     | PROTO-04. Not tracked yet                       |
| OPEN-13 | Closed. The first publication copies the list of notes that Obsidian Publish serves on the switch day (decisions R15)                                                             | Section 8.5, the switch                                                                     | Settled                                         |
| OPEN-14 | The rows of the first redirect list without a target, and the folder notes that are not published and still get visits                                                            | RES-05, RES-08, SW-04                                                                       | Private task of the author                      |
| OPEN-15 | The exact form of the old heading anchors on the current site                                                                                                                     | URL-14                                                                                      | Issue 12                                        |
| OPEN-16 | Closed. No featured note at the first release. Later: a property on the note                                                                                                      | Nothing                                                                                     | Issue 2                                         |
| OPEN-17 | Closed. Business rules 2, 14 and 15 were rewritten with the approval of the author                                                                                                | Nothing                                                                                     | Closed                                          |
| OPEN-18 | Hosting: confirmed by the prototype, or the fallback (D3)                                                                                                                         | Section 7.6                                                                                 | PROTO-01                                        |
| OPEN-19 | The default selection, to confirm with the first version (Q9)                                                                                                                     | PUB-19                                                                                      | Not tracked yet                                 |
| OPEN-20 | Which features of the first release are conditions of the switch gate (0.2.3), and the release of the curated lists                                                               | Every G and M label                                                                         | Decided when the tickets are cut                |
| OPEN-21 | Closed. The scope of the property correction is PUB-13. "Published" for the property means: recorded in the manifest and pushed. The deployment record says what is live (PUB-10) | Nothing                                                                                     | Closed (decisions R16)                          |
| OPEN-22 | Closed. Notes whose original is on the main site stay in the feeds and in `llms.txt` (IDX-14)                                                                                     | Nothing                                                                                     | Closed (decisions R16)                          |
| OPEN-23 | Closed. No allow marks exist in the first version: the content checks left it (ADR 0011, issue 15)                                                                                | Nothing                                                                                     | Closed (decisions R22)                          |

Settled for now, with a later review: the properties of person notes (D40, three private task notes of the author), no block of AI crawlers (issue 8), a tool for the author first (D18).

## 24. Out of Scope

1. The main site and the store: nothing is built or changed there (ADR 0001). The blog and store sections of spec v1 are gone.
2. One host name for the three sites (decisions D1).
3. Accounts, a login, limited access and paid content. The PKM Library and more MCP access for customers wait for it (issue 1).
4. A new newsletter delivery system.
5. A bridge through Obsidian Publish (ADR 0003).
6. A plugin for the community (decisions D18), one plugin for the notes site and the main site (decisions K21), publication from a phone (decisions D22).
7. An id written into each note (ADR 0007).
8. A `noindex` rule by note type (ADR 0004), a shorter URL form (ADR 0005).
9. Confirmation limits (issue 9) and a stored hold (tool K5) in the first version of the tool.
10. An allow list per property key at the first release (issue 6).
11. Bulk outputs at the first release: topic packs, full-text files, a JSON API in bulk (decisions R16, issue 14).
12. A block of AI crawlers, and a paid tracker for AI visibility (issue 8, seo item 194).
13. Typo tolerance and search by meaning at the first release (decisions D45).
14. Rendering of Canvas and Excalidraw files. Translations of the site interface.
15. A change of the vault structure or of the note types.
16. A hosted publishing service.
17. Automatic checks on the content of a note: a scan for secrets and personal data, the hiding of private titles, the removal of private rows, of comments and of attachment metadata, allow marks, a blocked state (ADR 0011, issue 15).

## 25. Further Notes

### 25.1 Working method

The project follows the flow of `AGENTS.md`: interview with documents (done), prototypes (section 21), this spec, tickets as tracer bullets with blocking links on GitHub, one ticket per fresh context with tests first and a code review, a retro after each build session.

### 25.2 When the author approves this spec

1. `AGENTS.md` names it as the current plan.
2. The architecture, domain model and configuration documents are written from sections 6 to 10.
3. The business rules document already matches this spec: rules 2, 14 and 15 were rewritten with the approval of the author.

### 25.3 Story numbers of spec v1

Spec v1 had 114 stories (v1 8). The stories of this spec have new numbers, because the scope and the publication model changed. "Not placed" means: an idea that no decision put in a release (section 11.4).

| Story of spec v1 | Story of spec v2                                               |
| ---------------- | -------------------------------------------------------------- |
| 1                | 1                                                              |
| 2                | 2                                                              |
| 3                | 3                                                              |
| 4                | 4                                                              |
| 5                | 5                                                              |
| 6                | 6                                                              |
| 7                | 7                                                              |
| 8                | 46, 47                                                         |
| 9                | 38                                                             |
| 10               | 37                                                             |
| 11               | 31                                                             |
| 12               | 32                                                             |
| 13               | 44                                                             |
| 14               | 45                                                             |
| 15               | 20                                                             |
| 16               | 21                                                             |
| 17               | 12                                                             |
| 18               | 13                                                             |
| 19               | 9                                                              |
| 20               | 11                                                             |
| 21               | 54                                                             |
| 22               | Not placed (hover preview)                                     |
| 23               | 41                                                             |
| 24               | 42                                                             |
| 25               | 43                                                             |
| 26               | 33                                                             |
| 27               | 48                                                             |
| 28               | 51                                                             |
| 29               | Not placed (image zoom)                                        |
| 30               | 19                                                             |
| 31               | 23, 130                                                        |
| 32               | 35                                                             |
| 33               | Not placed                                                     |
| 34               | 57                                                             |
| 35               | Not placed                                                     |
| 36               | Not placed                                                     |
| 37               | No bulk output at the first release (decisions R16)            |
| 38               | Not placed                                                     |
| 39               | Not placed                                                     |
| 40               | Not placed                                                     |
| 41               | 28                                                             |
| 42               | 10                                                             |
| 43               | 36                                                             |
| 44               | 60                                                             |
| 45               | 67                                                             |
| 46               | 68                                                             |
| 47               | 69                                                             |
| 48               | 73                                                             |
| 49               | 75                                                             |
| 50               | 82                                                             |
| 51               | 83                                                             |
| 52               | 84                                                             |
| 53               | 85                                                             |
| 54               | 87                                                             |
| 55               | 108                                                            |
| 56               | 92                                                             |
| 57               | 74                                                             |
| 58               | 86                                                             |
| 59               | Dropped: no allow list at the first release (issue 6)          |
| 60               | Dropped: no confirmation limits in the first version (issue 9) |
| 61               | 93                                                             |
| 62               | 100                                                            |
| 63               | 103                                                            |
| 64               | 104                                                            |
| 65               | 101, 102                                                       |
| 66               | 94                                                             |
| 67               | 105                                                            |
| 68               | 107                                                            |
| 69               | Left the scope (main site)                                     |
| 70               | Left the scope (main site)                                     |
| 71               | Not placed                                                     |
| 72               | Dropped: decision D22                                          |
| 73               | 110                                                            |
| 74               | 157                                                            |
| 75               | 119                                                            |
| 76               | 120                                                            |
| 77               | 126                                                            |
| 78               | 127                                                            |
| 79               | 131                                                            |
| 80               | 132                                                            |
| 81               | 133, 134                                                       |
| 82               | 135                                                            |
| 83               | 136                                                            |
| 84               | 137                                                            |
| 85               | 138                                                            |
| 86               | No bulk output at the first release (decisions R16)            |
| 87               | Left the scope (store)                                         |
| 88               | 141                                                            |
| 89               | 143                                                            |
| 90               | 61                                                             |
| 91               | 145                                                            |
| 92               | 146                                                            |
| 93               | 144                                                            |
| 94               | 149                                                            |
| 95               | 154                                                            |
| 96               | 150                                                            |
| 97               | 142                                                            |
| 98               | 148                                                            |
| 99               | 156                                                            |
| 100              | 55, 147                                                        |
| 101              | Left the scope (one navigation across three sites)             |
| 102              | 122 (rewritten: the original is on the main site, ADR 0010)    |
| 103              | Not placed                                                     |
| 104              | Not placed                                                     |
| 105              | 160                                                            |
| 106              | 161                                                            |
| 107              | 162                                                            |
| 108              | 163                                                            |
| 109              | 164                                                            |
| 110              | 165                                                            |
| 111              | 169                                                            |
| 112              | 170                                                            |
| 113              | 171                                                            |
| 114              | 174                                                            |
