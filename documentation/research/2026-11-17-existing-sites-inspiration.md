# Existing sites as inspiration for the notes website (2026-11-17)

Research for the design of the notes website. It covers four existing code bases of the author and the live main site. It feeds spec v2.

- **Scope**: what the Ghost theme, the store, the Ghost publishing plugin and the PKM wiki do today, and what the notes site should take from them.
- **Rule of this document**: every item has one number. The numbers run through the whole document, so "item 57" means one thing only. Sub-points use letters (57a).
- **Not in this document**: private data, secrets, member counts, revenue numbers, vault folder names.
- **Relation to other files**: `documentation/plans/spec-v1.md` is "the spec". `documentation/plans/ideas-backlog.md` is "the backlog". Section E holds only ideas that are in neither.

## Sources and method

1. `ghost-theme-dsebastien`: all 91 templates and partials (20 of them are icons), the 12 scripts, the style sheet (5,455 lines), the routes file, the two data files, the release document.
2. The live main site, read as plain HTML (no login, no form): home, articles listing, one tag page, the start page, the newsletter page, the news feed, 30 news posts, four articles, the news RSS feed, the Ghost card style sheet.
3. `store-website`: the command palette, the layout, the theme tokens, the fuzzy search, the generators for the sitemap, `llms.txt`, `products-light.json` and the static pages, the headers file, the analytics module.
4. `obsidian-ghost-publish`: the LINK block and YouTube functions with their tests, the wikilink resolver, the embed services, the footnote renderer, the usage and business rule documents.
5. `ai-wiki-pkm`: the five theme files, the main style sheet, the three client scripts, the templates, the build script.
6. Limits: the browser was not used, so no screenshot exists. Statements about the look come from the CSS. The plans that the theme comments name (`articles-page-overhaul`, `homepage-start-overhaul`) are not in the repository.

## A. Feature inventory of the Ghost theme

Each feature has four parts: what it does, where it lives, how it is built, and a verdict for the notes site (**adopt**, **adapt** or **skip**).

### A.1 The reading progress bar (exact behavior)

7. Markup: `<div id="reading-progress" class="reading-progress" aria-hidden="true"><div class="reading-progress-fill"></div></div>`. It is the first element of `<body>` in `default.hbs`, so every page type has it: home, listings, tag pages, posts, pages, error pages.
8. Position: fixed to the top edge of the window, full width, 3 pixels high, above everything else (`z-index: 3000000`). It does not catch clicks (`pointer-events: none`). The track is transparent.
9. Color: a gradient from left to right. It starts with the accent color of the site (`--ghost-accent-color`, `#fd3585` on the live site) and ends with the same color mixed with 30 percent white. The fill has a soft glow (8 pixel shadow in the accent color at 40 percent) and a 2 pixel radius on its right end.
10. When it shows: the bar is invisible at the top of the page. It fades in (0.3 seconds) when the page is scrolled more than 50 pixels. It fades out again above that point. A page that cannot scroll never shows it.
11. How it measures: `scrollY / (document height - window height)`, capped at 100 percent. It measures the whole document, not the article. The footer, the comments and the "Read more" grid count. The bar reaches 100 percent only at the very bottom of the page, not at the end of the text.
12. How it updates: one passive `scroll` listener. Each event asks for one animation frame, and the frame sets `width` in percent on the fill. The width has a 60 millisecond linear transition. One call runs at load. No `resize` listener exists, so the value is corrected at the next scroll.
13. Cost: about 35 lines of plain JavaScript, under 1 KB before minification. It ships inside the one deferred bundle of the theme (`source.js`: 73 KB raw, about 24 KB compressed, most of it the lightbox library). It sets `width`, a layout property, on each frame.
14. What it does not do: no reduced-motion rule, no print rule, no section marks, no ARIA value (it is hidden from assistive tools, which is correct for a decoration).
15. Verdict: **adapt**.
    - (a) Keep the look: fixed top, 3 pixels, accent gradient, glow, fade in after 50 pixels.
    - (b) Draw it with CSS where the browser can: `animation-timeline: scroll(root)` on a `transform: scaleX()` fill. This needs no script and runs off the main thread. The backlog names this technique (backlog 55). The plain note page then keeps its script budget.
    - (c) For browsers without scroll timelines: a fallback of about 15 lines in the base script, with `transform` and not `width`.
    - (d) Decide what 100 percent means. Proposal: on a note page the bar follows the note body (`<article>`), so it is full when the text ends, before backlinks, ads and footer. On other pages it follows the document. A named view timeline on the article gives this in CSS.
    - (e) Tokens: `--progress-height`, `--c-progress-from`, `--c-progress-to`, `--progress-glow`. Theme 2 then gets the main-site look without new code.
    - (f) Hide it in print and in stacked-pages mode (one bar per column has no clear meaning).

### A.2 Page shell

16. **Header and navigation.**
    - What: logo and site name, the main menu, a search button, "Sign in" and "Subscribe" (or "Account" for members). On phones: a burger button, a full-screen menu, items that slide in one after the other, and a locked page scroll.
    - Where: `partials/components/navigation.hbs`, `assets/js/dropdown.js`, the burger block in `main.js`.
    - Built: Ghost `{{navigation}}` helper. A script measures the menu and moves the items that do not fit into a "more" menu (two columns when ten or more items overflow). It runs again on each resize.
    - Verdict: **adapt**. Take the content (logo, sections, search button with its shortcut hint, one primary action). Do not take the measuring script: the notes header has few fixed entries, so CSS is enough. Add the graph button and the theme switch (spec 9.4.1).
17. **Footer.**
    - What: a lead magnet form above the footer, then a brand column (logo, tagline, five social icons) and three link columns (content, products, free resources), then a bottom line (copyright, about, now, community, affiliates, RSS).
    - Where: `partials/components/footer.hbs`.
    - Built: static HTML. The product links are hard-coded.
    - Verdict: **adapt**. Same three-column idea with "explore" (types, tags, recent, graph, feeds), "products" (from the catalog file, not hard-coded) and "free resources". The spec does not describe a footer (item 309).
18. **Sidebar and side rail.**
    - What: a slim column with an about block, one product card, five featured posts and three browse buttons. On posts it shows as a side rail only on screens of 1,300 pixels and more.
    - Where: `partials/components/sidebar.hbs`, the `post-side-rail` block of `post.hbs`.
    - Built: Ghost `{{#get}}` for the featured posts. Sticky position.
    - Verdict: **adapt**. The lesson is in the comments: a sticky column must fit in one window height, or its end can never be reached. The notes side column (outline, local graph, one ad) needs the same limit.
19. **Announcement bar.**
    - What: a site-wide message bar that Ghost injects. The theme only darkens its background for contrast.
    - Verdict: **skip** as a Ghost feature. Item 253 proposes a bar that reads the promotion data of the store.
20. **Link rewrite map.**
    - What: a script at the end of each page replaces 14 link targets at view time. Eleven of them are notes URLs (product notes, one project note, one section of a newsletter issue), which become store or landing page URLs. Three are old Gumroad and newsletter URLs.
    - Where: the inline script at the end of `default.hbs`.
    - Built: a loop over all links of the page, after `DOMContentLoaded`.
    - Verdict: **adapt, as data**. It shows that some notes have a commercial home. The notes site needs this map as a data file (the plugin calls it the "known URL map"). Uses: the product note page shows a buy box (item 255), and link cards to these notes become product cards (item 108). These notes URLs must stay alive (spec 5.4, acceptance test 3).

### A.3 Finding content

21. **Search.**
    - What: a search overlay over titles, excerpts, tags and authors.
    - Where: `partials/search-toggle.hbs` (the button), `assets/js/search-shortcut.js` (the keys). The overlay is Ghost's own search application, loaded from a CDN, which reads the Ghost Content API.
    - Built: third-party script plus API. The theme adds two shortcuts: `Ctrl+K` or `Cmd+K` (works everywhere, also inside inputs, not with Alt or Shift) and `/` (only when the focus is not in an input, a text area, a select or an editable element). The script calls `preventDefault` only when the search button exists. The button carries `aria-keyshortcuts="Meta+K Control+K Slash"` and a title with the shortcut.
    - Verdict: **skip the engine, adopt the key rules** (section C). Pagefind is planned (spec 9.6).
22. **Table of contents.**
    - What: a "Contents" box at the top of long articles, closed by default. On phones and tablets a bar sticks to the top while the reader is inside the article. It shows the title of the current section and opens the full list.
    - Where: the last large block of `main.js`, the "Article Table of Contents" part of `screen.css`.
    - Built: client script. Rules: second-level headings only, direct children of the content, minimum four headings. The current section is the last heading whose top is above 80 pixels. The sticky bar shows from the moment the inline box leaves the window until the article ends. Escape and a click outside close it. Both toggles carry `aria-expanded`.
    - Verdict: **adapt**. Build the outline as HTML at build time (story 7, spec 9.4.3). Take two things that the spec does not have: the minimum of four headings, and the sticky "current section" bar for small screens, where a side column does not exist (item 293).
23. **Heading links.**
    - What: a small link button after each second-level and third-level heading. A click copies the section URL, scrolls to the section and shows a "Link copied" message.
    - Where: the "Section anchors" block of `main.js`.
    - Built: client script. Details worth keeping: the button is glued to the last word of the heading so that it never wraps alone. The copied URL has no query string, so campaign parameters do not spread. The message is a `role="status"` live region. The button shows on hover and on keyboard focus, and at half strength on touch screens. Each copy sends the event `Section Link Copy`.
    - Verdict: **adopt** the behavior, with ids and buttons made at build time (story 30).
24. **Article cards.**
    - What: one card component in four sizes: hero (full row), large (two columns), regular, compact (no image, one line). It shows image, topic label, title, excerpt, author, date and reading time.
    - Where: `partials/post-card.hbs`, part 7 of `screen.css`.
    - Built: Handlebars and CSS. Only the title is a link. Its `::after` covers the whole card, so the card is one click target but screen readers hear one link. Images come in six widths (160 to 2,000 pixels) as WebP with a `sizes` hint. Cards below the first row are lazy.
    - Verdict: **adopt** the pattern for hub pages, recent pages and related notes: one card, size variants, the stretched title link, the `sizes` hint.
25. **Listing pages.**
    - What: `/blog/` shows the newest featured article as hero, two "editor's picks", the five latest as compact cards, then one section per topic. A sticky row of topic pills follows the scroll. On phones a native "Jump to a topic" select replaces the pills. `/all-articles/` is a complete index with real pagination. `/updated/` lists refreshed articles.
    - Where: `blog.hbs`, `all-articles.hbs`, `updated.hbs`, `partials/components/topic-section.hbs`, `assets/js/blog-nav.js`, `assets/js/pagination.js`, `configuration/routes.yaml`.
    - Built: Ghost Content API queries in the templates. Each topic filter excludes the tags of the sections before it, so an article shows in one section only. The pill row uses an `IntersectionObserver`. Archive pages load the next page with `fetch` when the footer comes into view and append the cards (infinite scroll, driven by `link[rel=next]`).
    - Verdict: **adapt**. Take: the rule "one item, one section", the pill row with a select on phones (item 243), and a complete paginated index for crawlers (item 248). Skip infinite scroll: static pages with real links are simpler and work without a script.
26. **Series.**
    - What: a box at the top of a post that belongs to a series: "Part of a series", the series title, the number of parts, the ordered list of parts, and "You're here" on the current one. A series with more than eight parts shows the first, the last and two parts on each side of the current one, with a "Show all N parts" button. `/series/` lists all series.
    - Where: `partials/components/series-nav.hbs`, `series-strip.hbs`, `series.hbs`, `assets/js/series-collapse.js`, `data/series.json`.
    - Built: an internal Ghost tag per series, one Content API query per series on each post, a data file as the source of truth, a client script for the collapse.
    - Verdict: **adapt**. The notes site has ordered sets too: newsletter issues, multi-part articles, maps of content with an order. Render the strip at build time, and use `<details>` for the collapse. The backlog has trails (S4) and previous and next links (backlog 11). The strip with "you are here" and the window rule is the missing part (item 301).
27. **Tag pages and the tag hub.**
    - What: a tag page has a breadcrumb line ("All topics", then the tag), the name, a description, an optional image, a "Start with the best" row (up to three featured posts of the tag), the paginated list, one offer, and a link back to the hub. The hub `/tags/` shows seven pillars, nine main topics, then every tag with its count, most used first.
    - Where: `tag.hbs`, `tags-hub.hbs`.
    - Built: Ghost taxonomy pages plus Content API queries. `CollectionPage`, `BreadcrumbList` and `ItemList` structured data. A feed link per tag in the head.
    - Verdict: **adopt** this structure for tag pages and type hubs (stories 23 and 25): description, best notes first, list, one ad, feed link, structured data.
28. **Related posts.**
    - What: "Keep reading": three compact cards from the first topic tag (featured first, then newest), then links to the older and the newer article. It sits after the text and before any product offer. Below the article a "Read more" grid shows four more posts.
    - Where: `partials/components/keep-reading.hbs`, the end of `post.hbs`.
    - Built: Content API queries.
    - Verdict: **adapt**. Related notes come from the link index (story 27). Keep the order: the next thing to read comes before the ad.
29. **Pillars.**
    - What: seven hub pages that group articles by theme, each with an intro, best articles, all articles, an offer and its own feed.
    - Where: `pillars.hbs`, `pillar-*.hbs`, `partials/components/pillar-body.hbs`, `data/pillars.json`.
    - Built: an internal tag per pillar, set by a script from a tag list in the data file (first match wins).
    - Verdict: **skip** as pages: maps of content play this role in the garden. Keep the data file idea: one file maps topics to a pillar and to an offer (item 250).

### A.4 Reading an article

30. **Dates, reading time, author line.**
    - What: under the title: author photo, name, publication date, reading time. An "updated" date and a badge "Updated", with month and year, show only for a real refresh.
    - Where: `post.hbs`, `assets/js/freshness.js`.
    - Built: Ghost helpers. A script shows the badge when the update is at least 30 days after the publication and after a fixed cutoff date. The cutoff exists because one bulk operation once changed the update date of every post.
    - Verdict: **adopt the rule, at build time**. The spec has it as "significant update" (6.7). The cutoff story confirms that a bulk change must not move dates.
31. **"In short" box.**
    - What: the custom excerpt of a post shows under the title in a tinted box with an accent border and the label "In short". The `speakable` structured data points to it.
    - Where: `post.hbs` (`.article-tldr`).
    - Built: template and CSS.
    - Verdict: **adopt** for notes that have a `description` (item 227).
32. **Social sharing.**
    - What: a "Share" row under the header and again at the end of the article: X, LinkedIn, Bluesky, Facebook. On devices with a native share sheet, one share button replaces the row.
    - Where: `partials/components/social-share.hbs`, the last block of `main.js`.
    - Built: plain links to the share URLs of each network (no network script) and the Web Share API.
    - Verdict: **adopt**, at the end of a note only: native share where it exists, else the links, plus "copy link". The spec has no sharing (item 286).
33. **Comments.**
    - What: Ghost native comments under a post, when the post has them switched on.
    - Where: `{{comments}}` in `post.hbs`. Ghost loads its comment application and a counter script from a CDN.
    - Verdict: **skip**. No accounts on the notes site (spec 3.2). "Report a problem" (story 43) and a community link (backlog S56) cover the need.
34. **Code blocks.**
    - What: a gray box with a monospace font and horizontal scroll. Inline code gets a light tint.
    - Where: part 15 of `screen.css`.
    - Built: CSS only. The theme has no syntax highlight and no copy button.
    - Verdict: **skip** as a model. The notes site highlights at build time (spec 9.2). A copy button is missing in the spec (item 299).
35. **Tables.**
    - What: a wide table scrolls sideways inside its own box and does not break the page.
    - Where: the "Responsive HTML table" block of `main.js`, `.gh-table` in `screen.css`.
    - Built: a script wraps each table in a `div` with `overflow-x`.
    - Verdict: **adopt**, with the wrapper written at build time.
36. **Images.**
    - What: the feature image loads first (`fetchpriority="high"`) in five widths. Images in the text open in a lightbox. Images that follow each other form one gallery with arrows. Captions are small and centered.
    - Where: `partials/feature-image.hbs`, `partials/lightbox.hbs`, `assets/js/lightbox.js`, the PhotoSwipe library in `assets/js/lib/`.
    - Built: Ghost image sizes, PhotoSwipe 4 with its user interface (most of the script bundle), and a wrapper that collects neighbor images.
    - Verdict: **adapt**. Take the gallery grouping and `fetchpriority` on the cover. Do not take the library: a native `<dialog>` and a few lines, loaded at the first click, are enough for zoom (story 29).
37. **Footnotes.**
    - What: superscript numbers in the text, a numbered list at the end, a back link on each entry.
    - Where: not in the theme. The publishing plugin renders them (`services/footnotes.ts`). The theme has no footnote style.
    - Built: an extension of the Markdown parser. Rules with tests: numbers follow the order of the first reference, a definition that nothing refers to is dropped, a reference without a definition stays as plain text, inline footnotes (`^[text]`) work, nested brackets inside an inline footnote survive. Output: `<section class="footnotes" data-footnotes>` with `id="fn-N"` entries and `#fnref-N` back links that carry an `aria-label`.
    - Verdict: **adopt the rules and the tests** in the Markdown package. Add the style and the popover (backlog S29).
38. **Callouts and toggles.**
    - What: the Ghost callout card (emoji plus text on a colored background) and the toggle card.
    - Where: Ghost card styles. The theme sets only the radius and the font size.
    - Verdict: **skip**. Obsidian callouts have their own grammar (spec 9.2).
39. **Bookmark cards.**
    - What: a link shown as a card: title, description (two lines), site icon, author, publisher, and an image on the right.
    - Where: Ghost renders the card. Its base style comes from the Ghost card style sheet. The theme overrides radius, padding and font sizes.
    - Built: at publication, the plugin asks the Ghost oEmbed endpoint for the metadata of the URL. Ghost downloads the icon and the image to its own storage and stores the card in the post.
    - HTML on the live site:

        ```html
        <figure class="kg-card kg-bookmark-card">
            <a class="kg-bookmark-container" href="URL">
                <div class="kg-bookmark-content">
                    <div class="kg-bookmark-title">Title</div>
                    <div class="kg-bookmark-description">Description</div>
                    <div class="kg-bookmark-metadata">
                        <img class="kg-bookmark-icon" src="ICON" alt="" />
                        <span class="kg-bookmark-author">Author</span>
                        <span class="kg-bookmark-publisher">Publisher</span>
                    </div>
                </div>
                <div class="kg-bookmark-thumbnail">
                    <img src="IMAGE" alt="" onerror="this.style.display = 'none'" />
                </div>
            </a>
        </figure>
        ```

    - CSS in short: the container is a flex row with a 1 pixel border and a 6 pixel radius (8 in the theme). The content takes the free width with 20 pixels of padding. The title is 15 pixels, weight 600. The description is 14 pixels, 70 percent opacity, cut after two lines. The metadata row has a 20 pixel icon, then author and publisher with a bullet between them. The thumbnail is at least one third of the width and its image covers it.
    - Verdict: **adapt**: section B. Same anatomy, no inline `onerror` handler, images served from the notes site.
40. **Embed cards and the YouTube facade.**
    - What: a YouTube link becomes a player. The theme replaces the player with a still image and a play button. The real player loads at the click, from the no-cookie host, with autoplay.
    - Where: Ghost renders `<figure class="kg-card kg-embed-card"><iframe src="https://www.youtube.com/embed/ID?feature=oembed" …></iframe></figure>`. The facade is the "YouTube facade" block of `main.js`. `assets/js/lib/reframe.min.js` keeps other players responsive.
    - Built: client script. Limits: the `iframe` is in the HTML that Ghost serves, so the browser can start to load it before the script swaps it. The still image comes from the YouTube image host at view time. The styles are inline.
    - Verdict: **adapt**: item 118. The facade is written at build time, the still image is local, and nothing from YouTube loads before the click.
41. **Author box.**
    - What: a card at the end of each article: photo, "Written by", name, a two-line bio with topic links, one button (community) and one text link (subscribe).
    - Where: `partials/components/author-card.hbs`.
    - Built: static HTML. The comments say why it exists: phones never saw the about block of the side rail.
    - Verdict: **adapt**. A short author line with a link to the about note at the end of notes with own text, and a `Person` entity in the structured data. Not on media notes. The spec has no author element (item 297).

### A.5 Newsletter and members

42. **The form.**
    - What: one email field and one button with three states: idle, loading (spinner), sent ("Email sent"). An error text shows under the field.
    - Where: `partials/email-subscription.hbs`.
    - Built: the Ghost members form (`data-members-form`). Ghost handles the request and the states.
    - Verdict: **adapt**. The notes site has its own form against the same back end (spec 9.11), with the states "error", "sent", "already subscribed" and "do not show again".
43. **Positions of the newsletter ask.** Ten positions exist:
    - (a) "Subscribe" button in the header. It opens the overlay.
    - (b) A floating "Subscribe" bubble at the bottom of pages that are not posts. It fades out when the footer comes into view.
    - (c) A sticky bar at the bottom of posts. It shows after 30 percent of scroll, hides in the last 5 percent, and can be closed for the browser session.
    - (d) A band inside the article ("Enjoying this? Subscribe for free"). A script moves it before the fourth heading (the third in short articles). Articles with 8 or more headings get a second one about five headings later. Articles with 13 or more get a third.
    - (e) A band with a free resource that matches the topic. A script moves it after the paragraph at 55 percent of the text, in articles with six paragraphs or more. It fades in when it enters the window and sends `Capture Shown`.
    - (f) The overlay on exit: on desktop when the pointer leaves through the top of the window, on phones when the tab is hidden. Only for a reader who scrolled half of the page or stayed 25 seconds. One time per page, one time per seven days, never after a signup.
    - (g) A text link in the author box.
    - (h) A lead magnet form above the footer of every page.
    - (i) The hero form of the newsletter page.
    - (j) A lead magnet form on the home page.
    - Where: `subscribe-bubble.hbs`, `sticky-cta.hbs`, `scroll-capture.hbs`, `lead-magnet-cta.hbs`, `subscribe-overlay.hbs`, `assets/js/engagement.js`, `assets/js/subscribe-overlay.js`, two blocks of `main.js`.
    - Verdict: **adapt, with restraint**. The spec keeps the fixed bar and adds one position inside long notes (9.11, D51). Take from the theme: the bar that waits for 30 percent of scroll and leaves before the footer (item 251), and the rule that computes the slot inside the text, run at build time. The exit overlay is a decision for the author (item 259). The bubble is not needed next to a bar.
44. **The subscribe overlay.**
    - What: a dialog with a title, one paragraph, the form, and the three paid tiers below it.
    - Where: `partials/components/subscribe-overlay.hbs`, `assets/js/subscribe-overlay.js`.
    - Built: `role="dialog"`, `aria-modal`, focus moves to the email field, Escape and a click on the backdrop close it, the focus returns to the opener, the page scroll is locked. Other scripts open it with a custom event. Each trigger keeps a plain link as fallback. It has no focus trap.
    - Verdict: **adapt**: the same contract with a native `<dialog>`, which traps the focus by itself.
45. **Members and portal hooks.**
    - What: the templates show different content to three groups: visitors, free members, paid members. Examples: the hero of the home page, the sticky bar ("Subscribe" or "Upgrade"), the footer block. Ghost Portal handles sign in, account and plans. Members get a community chat widget, loaded when the browser is idle.
    - Where: `{{#if @member}}` blocks in most templates, `data-portal` links.
    - Verdict: **skip**. No accounts (spec 3.2). One light form of it works without accounts (item 252).

### A.6 Products and calls to action

46. **Live prices.**
    - What: prices in the templates are plain text. A script replaces them with the current price from the catalog of the store.
    - Where: `assets/js/prices.js`. Elements opt in with `data-price="<product id>"`, and optionally `data-price-variant="<variant name>"` and `data-price-format="amount"` or `"included-value"`.
    - Built: one `fetch` of `products-light.json`, only on pages that have such an element. The text from the server stays when the fetch fails, when the product is unknown or when the script does not run. The site security policy allows the store host.
    - Verdict: **adopt as is**. It is the pattern of spec 9.10.1 with one more rule that the spec should state: the card is complete in the HTML, and the script only refreshes it (item 294).
47. **The contextual offer.**
    - What: one block at the end of each article with one product (name, one line, price), one free resource ("Not ready to buy? Start free"), and one line for the community.
    - Where: `partials/components/contextual-offer.hbs` (the rules), `offer-card.hbs` (the block).
    - Built: a cascade over the tags of the post, from specific to general: 14 branches and a default. The first match wins. The comments call it "a decision, not a menu".
    - Verdict: **adapt**. The notes site scores products (spec 9.10.2). Take the format (item 249) and the idea of hand-set rules that come before the score (item 250).
48. **All positions of a call to action on a post.** In reading order:
    - (a) Series box (when the post is in a series).
    - (b) Curriculum card: "This article sits in the (layer name) layer of my free five-layer journey", with a link to the matching start page.
    - (c) Side rail with one product card (wide screens).
    - (d) Bands inside the text (item 43d and 43e).
    - (e) "Keep reading".
    - (f) Author box with one button.
    - (g) The contextual offer.
    - (h) Share row.
    - (i) Sticky bar.
    - (j) A third-party ad network script, on posts only.
    - (k) Lead magnet above the footer.
    - Verdict: **adapt**. The order (a), (e), (g) fits the notes site. Position (j) is **skip**: own products only. Every position carries `data-cta` (what) and `data-cta-topic` (which rule), so one click listener records all of them.
49. **Membership tiers.**
    - What: a grid with the free newsletter and three paid tiers. Prices and "value included" lines come from the catalog.
    - Where: `partials/components/membership-tiers.hbs`.
    - Verdict: **skip** on note pages. It can be one variant of the fallback ad (spec 9.10.6).
50. **Numbers as settings.**
    - What: the counts in the copy (readers, members, years, products sold, notes) are theme settings. The author changes them in the Ghost admin, with no deployment.
    - Where: the `custom` block of the theme `package.json`, `{{@custom.stat_*}}` in the templates.
    - Verdict: **adapt**: on the notes site such numbers come from `stats.json` at build time (item 269). No number is typed into a template.

### A.7 Landing pages

51. **Home page.**
    - What: a headline, one identity line, one main button, a "Where are you right now?" block with three choices, an answer block ("What is Personal Knowledge Management?"), proof numbers, problem and result sections, an about block, a lead magnet, a YouTube block, "Best of the blog" and "Latest articles", the five layers as an ordered list, a FAQ in `<details>` elements.
    - Where: `home.hbs`, `partials/components/path-router.hbs`, `topic-section.hbs`, `json-ld-extras.hbs`.
    - Built: static HTML plus Content API queries. The page differs for visitors, free members and paid members.
    - Verdict: **adapt** for the notes home (spec 9.4.6): identity line, three-way router, answer block, "best" and "latest" strips. The sales sections stay on the main site.
52. **Start page.**
    - What: a guided path in five layers. Each layer has a goal, a few articles and a link to its own page. The text of the layer pages lives in Ghost pages, so the author edits it without a deployment.
    - Where: `start.hbs`, `custom-start-pillar.hbs`, routes with `data: page.start-<layer>`.
    - Built: static HTML, Content API queries, `HowTo` and `LearningResource` structured data.
    - Verdict: **adapt, as a link target**. The notes site does not copy the curriculum. Notes can point into it (item 257). The backlog has "start here" paths (S5).
53. **News feed.**
    - What: `/news/` lists the 50 newest news posts as text cards: date first, then title, excerpt and tags as hash marks. The intro links to the public notes and to the news RSS feed.
    - Where: `news.hbs`, `partials/news-card.hbs`, the `/news/` collection in `routes.yaml`.
    - Built: one Content API query. The posts come from the vault through the publishing plugin.
    - Two facts from the live pages matter for the notes site:
        - (a) Each news post starts with the line "Canonical version:", followed by a link to the note.
        - (b) The `rel="canonical"` tag and the `og:url` of each news post point to the notes URL, not to the main site. Sample: 30 of 30 news posts.
        - (c) Articles differ. Sample: 4 of 4 articles name their own main-site URL as canonical.
    - Verdict: **adapt** the date-first text card for "recent" pages. Facts (a) to (c) change the plan: item 285.
54. **Feeds page.**
    - What: a page that lists every feed with one line each: everything, articles, newsletter, news, five topic feeds, a "best of" feed, and the rule "every tag has a feed". It ends with a short text for people who do not know RSS.
    - Where: `feeds.hbs`, the `/feeds/*` channels in `routes.yaml`.
    - Verdict: **adopt** (items 267 and 266).
55. **Error pages.**
    - What: the 404 page has a button to the home page and four next steps (start, articles, newsletter, store). The general error page has the button only. Neither has a search field.
    - Where: `error-404.hbs`, `error.hbs`.
    - Verdict: **adapt**. The spec already asks for more (story 21, U9). Take the "next steps" list.

### A.8 Head, data and cross-cutting parts

56. **Structured data in the templates.**
    - (a) Every page: `WebSite` and `Person`, with fixed `@id` values, 12 `sameAs` profiles, a job title and a `worksFor` organization (`default.hbs`).
    - (b) Posts: `BreadcrumbList` (home, section, first topic tag, title) and a `BlogPosting` whose `author`, `publisher` and `isPartOf` point to the fixed ids. It has `speakable` (the "In short" box and the title), dates, description, image, section and keywords (`post.hbs`). Ghost adds its own `Article` block too, so a post has two article entities.
    - (c) Listings, tag pages and pillars: `CollectionPage` with a breadcrumb and an `ItemList` of up to 20 posts (`partials/schema/collection.hbs`, `tag.hbs`, `pillar-body.hbs`).
    - (d) Home: `Organization`, `ProfilePage`, and `FAQPage` for visitors. Start page: `HowTo`, `LearningResource`, `BreadcrumbList` (`json-ld-extras.hbs`).
    - (e) Weak point: the templates print titles into JSON by hand. Ghost has no JSON escape helper. A title with a double quote gives invalid JSON.
    - Verdict: **adopt the entity graph, change the method**. Fixed `@id` values for person, organization and site, shared with the other hosts (item 260). Breadcrumbs and collection data on hubs (item 287). Every block comes from a serializer, never from string templates.
57. **Open Graph, Twitter, canonical, robots.**
    - What: Ghost writes these tags (`{{ghost_head}}`). The theme adds a default share image for pages without a feature image, a description for custom routes, and a `robots` tag with `max-image-preview:large`.
    - Findings on the live pages:
        - (a) A post without a feature image has two `og:image` tags and two `twitter:image` tags (the theme default and the Ghost default) and two `robots` tags.
        - (b) Custom routes (`/news/`, `/blog/`) have the site name as `<title>`. They have their own description.
        - (c) Paginated archives carry `link rel="next"`.
    - Verdict: **adopt the content, with one owner**. One head component writes each tag one time. A test fails on a duplicate tag and on a title that two pages share (item 288).
58. **RSS.**
    - What: feeds at `/rss/`, `/blog/rss/`, `/newsletter/rss/`, `/news/rss/`, `/updated/rss/`, `/feeds/<topic>/rss/`, `/pillars/<slug>/rss/` and `/tag/<slug>/rss/`. The head links the main feed on every page and the tag feed on tag pages.
    - Where: `routes.yaml`, `partials/feeds-meta.hbs`.
    - Built: Ghost. Items carry the full HTML and a stable id that is not the URL.
    - Verdict: **adopt**: feed links in the head that match the page (item 290), stable ids (spec 9.7.2).
59. **Dark and light.**
    - What: the theme is light only. A script in the head computes the brightness of one configured background color and sets a class (`has-light-text` or `has-dark-text`) that switches five variables. No switch, no `prefers-color-scheme`.
    - Where: the inline script of `default.hbs`, the first lines of `screen.css`.
    - Verdict: **skip**. The store and the wiki have the model to follow (section D).
60. **Fonts.**
    - What: Inter as a variable font (roman and italic), self-hosted, Latin subset through `unicode-range`, `font-display: swap`, the roman file preloaded. A serif and a monospace font load only when a theme setting asks for them.
    - Where: `partials/typography/*.hbs`.
    - Verdict: **adopt** the method (spec 9.14.4). The store and the wiki load Noto Sans from Google Fonts at view time. The notes site must not copy that.
61. **Animations and reduced motion.**
    - What: short transitions only: the progress bar, the overlay (0.25 seconds), the sticky bar that slides up (0.35 seconds), the outline box, the "copied" message, the phone menu. Scripts scroll smoothly to sections.
    - Finding: the style sheet has no `prefers-reduced-motion` rule.
    - Verdict: **adapt**: the same small set, with durations as tokens and one global rule that removes them for readers who ask for less motion.
62. **Accessibility.**
    - Present: the stretched title link on cards, `aria-expanded` on toggles, `aria-current` in the series list, a dialog with focus handling, a polite live region for messages, `aria-keyshortcuts` on the search button, hidden text for icon links, `<time datetime>`, a `@media (scripting: none)` fallback for the background.
    - Present, and a lesson: the accent `#fd3585` fails contrast with white text. The theme therefore uses `#d42d70` for button backgrounds and `#be2460` for link text. The notes site has the same problem with its magentas (spec 9.14.7).
    - Missing: a skip link, a focus trap in the overlay, reduced motion, a full set of visible focus styles.
    - Verdict: **adopt** the present parts and add the missing ones (item 302).
63. **Performance techniques.**
    - Present: `preconnect` to four hosts, `preload` of the style sheet, the script and the font, one style sheet (27 KB compressed), one deferred script bundle, passive scroll listeners that work once per frame, lazy images, a priority hint on the feature image, the chat widget at idle time, the ad script on posts only, asset URLs with a version parameter.
    - Not present: inlined critical CSS. A post runs four separate scroll listeners (progress, outline, sticky bar, engagement). Ghost adds scripts for the portal, payment, search, comments, comment counts, attribution and its own statistics.
    - Verdict: the notes site goes further by design (spec 9.14). Take the priority hint and the font preload (item 310). Replace scroll listeners with CSS or one shared observer.
64. **Analytics events.**
    - What: Plausible through the proxy of the author. Events: `CTA Click` (`cta`, `topic`, `path`), `Subscribe Intent` (`path`), `Signup` (`form`, `path`), `Store Click` (`product`, `path`), `Section Link Copy` (`section`, `path`), `Scroll Depth` (`depth` 25, 50, 75, 100, `path`), `Capture Shown` (`slot`, `topic`, `path`), `Exit Intent` (`device`, `path`).
    - Where: `assets/js/plausible-events.js`, `engagement.js`, one call in `main.js`.
    - Built: one click listener and one submit listener on the document, driven by data attributes. A small queue keeps events that fire before the analytics script loads. Every call sits in `try` and `catch`, so analytics can never break a page.
    - Verdict: **adopt** the method. The names differ between the sites: the theme uses "CTA Click", the wiki and the current notes site use `cta_clicked`, the store has about 40 typed functions. One event dictionary is needed (item 291).

### A.9 The store: features worth reuse

65. **Product card.** Image in a 16:9 box with a zoom on hover, badges on the image (featured, bestseller, best value), a wishlist heart, category chips, a title cut at two lines, a description cut at two lines, rating stars, price or "FREE", one buy button. The box has a 1 pixel border, a tinted background, a 12 pixel radius, and a colored shadow on hover (`src/components/products/product-card-ecommerce.tsx`). **Adapt** as the visual base of the ad card and of the link card, without the wishlist and the rating.
66. **Tag chips and filter chips.** A chip is a pill with a tinted accent background. An active filter chip has a close icon and the label "Remove filter:" plus the name. A "clear all" text link follows the chips (`filters/active-filter-chips.tsx`). **Adopt** for properties, tags and hub filters.
67. **Filters.** A side panel on wide screens, a drawer on phones, check box groups, a price slider, a sort menu. The state lives in the URL, so a filtered view can be shared (`hooks/use-product-url-state.ts`). A live region announces the number of results (`components/ui/live-region.tsx`). **Adapt** for type hubs and the media library (stories 23 and 24): URL state and the live region are the parts to keep.
68. **Hero.** A gradient block with one headline whose last line rotates through texts from a data file, a character animation that stops under reduced motion, and a validation script for the texts. **Adapt**: a calm hero for the notes home (item 277).
69. **Back-to-top button.** A round accent button at the bottom right. It shows after 300 pixels of scroll, slides in, and hides while a dialog is open (`components/ui/scroll-to-top-button.tsx`). **Adopt**. The spec does not name it (item 308).
70. **Skip links.** Three links that show on keyboard focus: main content, navigation, footer. A fourth opens the command palette (`components/layout/skip-links.tsx`). **Adopt**.
71. **Meta tags.** The store is a single-page application. A build script writes one HTML file per route and replaces title, description, canonical, Open Graph and Twitter tags with regular expressions. It adds structured data (`Product`, `Course`, `FAQPage`, `ItemList`, ratings) and a `<noscript>` copy of the content (`scripts/utils/generate-static-pages.ts`). At view time a function updates the same tags (`src/lib/update-meta-tags.ts`). **Skip** the method: Astro writes the head directly. Keep the list of structured data types for the day the store moves.
72. **Sitemap.** One file with all routes. Every URL gets the build day as `lastmod`, and a hand-set priority (`scripts/utils/generate-sitemap.ts`). **Skip**: a `lastmod` that changes at each build tells crawlers nothing. The spec uses the content hash (9.13.4).
73. **`llms.txt`.** Sections: about, content structure (each URL pattern with one line), product categories with counts, key tags, products by category (name, tagline, price, URL), data access, contact (`scripts/utils/generate-llms-txt.ts`). **Adapt**: the "content structure" and "data access" sections are a good model (item 265).
74. **`products-light.json`.** A top level with `$schema`, `generatedAt`, `count` and `products`. Each product: `id`, `name`, `shortDescription`, `tags`, `mainCategory`, `priceTier`, `targetExperienceLevel`, `href`, `badge`, `featured`, `bestseller`, `bestValue`, `priority`, `image`, `imageAlt`, and a `pricing` block (currency, price, display text, subscription flag, variants with their prices, description, included products and a ready URL). The headers file gives it `Access-Control-Allow-Origin: *` and a five minute cache (`scripts/utils/generate-products-light.ts`, `public/_headers`). **Adopt** as the one source for ads, product link cards and the palette. Public data files of the notes site should copy the envelope (`$schema`, `generatedAt`, `count`).
75. **Headers.** HSTS, `nosniff`, frame rules, a referrer policy, a permissions policy, a content security policy, long cache for hashed assets, no cache for HTML (`public/_headers`). **Adopt** the list. The spec names only the content security policy (item 304).
76. **Compact newsletter.** States: idle, loading, success, error. "Already subscribed" is kept for the session, "never show again" for good (`components/ui/compact-newsletter.tsx`). **Adopt**: same states as spec 9.11.
77. **Wishlist, compare, quiz.** A list of saved products in local storage with a shareable URL, a side-by-side compare page, and a quiz that scores products from answers. **Adapt** as ideas (items 246 and 247).
78. **Promotion banner.** A bar driven by one data file (text, discount code with a copy button, dates), closed per session, with a validation script. **Adapt** (item 253).
79. **Placeholders.** Product texts hold tokens such as `${stats.userCount|number}`. A build step replaces them and fails on an unknown token (`scripts/utils/placeholder/`). **Adapt** for site copy (item 269).

### A.10 The PKM wiki: features worth reuse

80. **Theme system.** One CSS file per theme (`knowii`, `paper`, `moss`, `stark`, `terminal`). Each file sets the same 17 variables for a dark and a light mode. The build copies the chosen file to `active-theme.css`. `main.css` maps the variables to Tailwind colors with `@theme inline`. One theme per build: the reader can switch the mode, not the theme. **Adopt** the contract and extend it (section D).
81. **Mode handling.** `data-mode` on `<html>`, a default mode per site, an inline script in the head that reads the stored choice before the first paint, a toggle that stores the choice and sends `theme_toggled`. **Adopt**, and add "follow the system" (spec 9.14.5).
82. **Search.** A dialog opened with `/` or the header button. The Lunr library loads on every page from a CDN. The index (`search-index.json`) loads at the first opening. Each word of the query is searched three ways: exact with more weight, as a prefix, and with one typo. The top 20 results show with title and kind. Arrow keys, Enter and Escape work. The events carry the length of the query and the number of results, not the text. **Adapt**: the dialog and the key handling are the model for the palette (section C). Lunr does not scale to 20,700 notes, and Pagefind is planned.
83. **Graph page.** A canvas graph (the `force-graph` library from a CDN) over `graph.json` (nodes with id, title, kind, degree, and edges). Features: zoom and drag, node size by degree, a ring around hubs, labels that depend on the zoom level, a click that highlights the neighbors, a text filter, a "minimum links" slider, a switch for source nodes, a switch for all labels, a reset button, a lasso. The colors come from the theme variables and are read again when the mode changes. The layout runs in the browser. **Adapt**: the controls and the token-driven colors are the parts to keep. At 20,700 nodes the layout must come from the build (spec 9.5.2).
84. **Ad cards.** The build reads `products-light.json`, scores the products for each page (tokens from slug, title and tags, an alias map, a phrase list), and always shows cards: two at the end, up to three inside the text. A script moves the cards inside the text with the same heading rule as the Ghost theme. The card is one link with image, badge, kicker, title, one line and "Learn more". It carries `data-cta-position` and `data-cta-slot`. The build also reads the Open Graph tags of each product page and keeps them in a cache file for seven days. **Adapt**: this is the current behavior that spec 9.10 starts from. The cache of Open Graph data is the direct model for link cards (item 105).
85. **Analytics script.** A wrapper with one function per event (`search_performed`, `search_selected`, `theme_toggled`, `graph_node_focused`, `graph_node_opened`, `external_link_clicked`, `cta_clicked`) and one click listener in the capture phase that tells ad clicks from other outbound clicks (`src/client/analytics.js`). **Adopt** the names: they match the event that the notes site must keep (story 89).

## B. The LINK card feature for the notes site

### B.1 What the plugin does today (exact grammar)

Source: `src/app/utils/process-link-blocks.fn.ts`, `process-youtube.fn.ts`, `services/wikilink-resolver.ts`, and their tests.

86. **One line with a URL.** Pattern: `^LINK:?\s+(https?://\S+)\s*$`. The line starts at the first column with `LINK` in upper case. The colon is optional. At least one space follows. Then one URL without spaces, then nothing but spaces. Result: one card.
87. **One line with a wikilink.** Pattern: `^LINK:?\s+\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]\s*$`. The target is the text before `|`, without outer spaces. The alias is ignored. Result: one card when the target resolves to a URL. When it does not, the whole line is removed and nothing shows.
88. **A block.** A line that holds only `LINK` or `LINK:` opens a block. The plugin reads at most the five lines after it. Each must start with `-` (after spaces). A blank line or any other line ends the block.
    - (a) The first item whose text starts with `http://` or `https://` is the URL of the block. The scan stops there.
    - (b) An item that is exactly one wikilink is kept as a candidate.
    - (c) Any other item ends the scan.
89. **Result of a block: one card at most.**
    - (a) With a URL: one card for that URL. The `LINK` line and the items up to the URL are removed. Items after the URL stay in the text as a normal list.
    - (b) Without a URL: one card for the first wikilink that resolves.
    - (c) When nothing resolves, the `LINK` line and the wikilink items are removed. The test says why: "so raw LINK: never leaks".
    - (d) When the line after `LINK:` is not a list item, the `LINK:` line stays as plain text.
90. **Pairing.** A block that holds one wikilink and one URL also tells the plugin: "this note lives at this URL". Every wikilink to that note in the same document then points to that URL.
91. **How a wikilink resolves.** In this order: the paired URL of a block, then the known URL map of the settings (note name to URL), then the public notes URL when the target note carries the public flag. Else no URL. In running text an unresolved wikilink becomes bold text.
92. **YouTube.** Pattern, per line: `^!\[[^\]]*\]\((https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)[^)]+)\)\s*$`. The whole line must be the image syntax. The alt text is ignored. The URL keeps its parameters (start time, playlist). Result: a paragraph "Watch on YouTube", which Ghost turns into a player card after the post exists.
93. **Order of the steps.** Remove query blocks and vault-only sections, remove the first heading, YouTube lines, LINK blocks, image uploads, wikilinks in the text, Markdown to HTML, create the post, then ask Ghost for the metadata of each URL and replace the marker paragraphs with cards.
94. **Forms that the plugin does not handle.** The author uses some of them in public notes:
    - (a) `LINK: [text](url)`.
    - (b) `LINKS:`.
    - (c) A block with more than one URL: only the first URL becomes a card.
    - (d) Bullets other than `-`, numbered lists, `<url>` in angle brackets.
    - (e) A `LINK` line with spaces before it, inside a list, or inside a callout.
    - (f) A wikilink with a heading (`[[Note#Heading]]`): the lookup uses the full text and finds nothing.
    - (g) YouTube forms other than `watch?v=` and `youtu.be/`: shorts, live, embed, the mobile host, the music host, the no-cookie host.
95. **Traps in the current code.**
    - (a) The functions do not know code blocks. A `LINK: https://…` line inside a fenced code block becomes a card.
    - (b) A URL item with text after the URL (`- https://example.org (the docs)`) is taken whole as the URL.
    - (c) The limit of five lines cuts long lists without a message.
    - (d) The pairing pattern is not tied to the start of a line.

### B.2 Grammar to support on the notes site

96. Keyword: `LINK` or `LINKS`, upper case, at the first column, with an optional colon. Same meaning for both.
97. One-line form: the keyword, then one target. A target is: a bare URL, a URL in angle brackets, a Markdown link `[text](url)`, or a wikilink with or without alias and heading.
98. Block form: the keyword alone on its line, then list items (`-`, `*` or `+`) until the first blank line or the first line that is not a list item. Each item holds one target. No limit of five lines. A build warning above 20 items.
99. Cards per block:
    - (a) Several URLs: one card per URL, as a stack.
    - (b) Wikilinks only: one note card per wikilink whose target is live.
    - (c) One wikilink and one URL (the pairing of item 90): one card for the URL, with a line under it: "My note:" plus the note title, linked when the note is live. This keeps the meaning that the plugin gives to the pair, and it shows both.
    - (d) Mixed lists with several of each: one card per URL, one note card per live wikilink that is not paired.
100.    The link text of `[text](url)` is the fallback title of the card. Fetched metadata wins when it exists. A property can turn this around later.
101.    Lines inside code blocks, inline code, comments and frozen query output are never read as LINK lines.
102.    YouTube: the image syntax of item 92, plus the forms of item 94g. A bare YouTube URL in a LINK line gives a video card too.
103.    Compatibility test: every fixture of the plugin tests gives the same card or the same silence on the notes site, except the two intended changes (several URLs give several cards, and the pair shows the note line). Before the grammar is final, the publish core counts each form in the public corpus (about 800 notes) and lists the lines that match no form.
104.    The plugin and the notes site should share this grammar as one small package with one test file. Else the same note gives different cards on the two sites.

### B.3 Where the card data comes from

105. **External URL: a metadata cache, filled at publication.**
     - (a) A command of the publish tool reads each new or expired URL one time. The build never opens a network connection: it reads the cache. A build is then repeatable and works offline.
     - (b) Key: the normalized URL (lower-case host, no fragment, tracking parameters removed).
     - (c) Fields: `url`, `finalUrl` (after redirects), `status`, `title` (`og:title`, else `twitter:title`, else `<title>`), `description` (`og:description`, else the description tag), `siteName` (`og:site_name`, else the host without `www`), `author`, `publishedTime`, `lang`, `type`, `image`, `icon`, `canonical`, `fetchedAt`.
     - (d) Image and icon are downloaded, checked (type and size limits), resized, stripped of metadata, and stored with the attachments under a content hash. The page then loads them from the notes host. No request goes to a third party when a reader opens a note.
     - (e) Fetch rules: `http` and `https` only, a time limit, a size limit, at most five redirects, HTML only for metadata, a neutral user agent, no cookies. A failed fetch keeps the last good entry.
     - (f) The cache lives next to the content store, not in the vault. It holds public data only.
     - (g) Refresh: entries older than a set age are read again at the next publication, a few per run. The PKM wiki does the same for product pages with a cache file and a seven day age (item 84).
     - (h) Decision for the author: show third-party images (the `og:image` of other sites) or only the site icon and text. It belongs to the policy for third-party material (spec 9.17.2). First recommendation: show them, small, with the source name always visible.
106. **Wikilink to a published note: the note's own data.** Title, description (the property, else the first sentences), cover image (the property) or the icon of the note type, the type badge, and the updated date. The link is internal. The card is resolved at build time against the set of live notes, like every other link (spec 9.2.2). A target that goes live later gets its card without a change to the linking note.
107. **A URL of the notes site itself.** The resolver turns it into the note, and the card is the note card of item 106.
108. **Store product.** A URL of the form `<store host>/product/<id>`, or a wikilink to a note of the known URL map (item 20). Data: `products-light.json` at build time (name, short description, image, badge). The price refreshes at view time with the pattern of item 46. The card counts as an ad: it carries the campaign parameters and the position value `inline` (spec 9.10.7 and 9.10.8).
109. **Article or news post of the main site.** The metadata cache of item 105 is enough: Ghost pages have complete Open Graph tags. One more rule: when the `canonical` of the fetched page is a notes URL (item 53b), the card becomes the note card. The reader stays in the garden, and the card agrees with what search engines see.
110. **Other sites of the author** (the PKM wiki, product landing pages): the metadata cache. A list of own hosts in the site configuration gives these cards the brand style and no "external" mark.
111. **Fallback when metadata is missing.**
     - (a) No image: the compact card (text and icon only).
     - (b) No description: title and site line only.
     - (c) No title: the link text of the note when one exists, else the host and the path, shortened.
     - (d) No icon: a neutral globe glyph from the icon set.
     - (e) Never fetched, or the fetch failed: the bare card, one line with a link glyph and the URL. The build report lists it.
     - (f) The URL answered 404 or 410 at the last check: the card stays with a "this link no longer works" mark. The backlog has an archive copy for this case (backlog 96).
112. **A wikilink whose target is not published.**
     - (a) In a block that also has a URL: the URL card shows, without the "My note" line.
     - (b) Target public but not live yet: Business Rule 5 applies. The line shows the title as plain text in the "not published" style (D50), without a card frame. It becomes a card when the target goes live, with no change to the linking note.
     - (c) Target in a deny-listed folder or type: no card, and the title never reaches the HTML, the Markdown, the search index or any other public output (spec section 7).
     - (d) A block where nothing can show is removed whole, as the plugin does. No empty box, no raw `LINK:` text.
     - (e) The plugin shows nothing in case (b). The same silence on the notes site would be an exception to Business Rule 5 for card lines, so it needs the approval of the author.
113. **The Markdown form for agents.** The cleaned Markdown shows each card as a list item: `- [Title](url): description`. A note card uses the site URL. A video is `- [Video title](url) (video, channel name)`. Agents then get the cited source with its title, not a bare `LINK:` line.

### B.4 HTML structure and states of the link card

114. Structure. Classes only, no inline style, no inline handler:

```html
<figure class="link-card" data-kind="external" data-state="rich">
    <a class="link-card__link" href="https://example.org/article" rel="noopener">
        <div class="link-card__body">
            <div class="link-card__title">Title of the page</div>
            <div class="link-card__desc">Description, cut after two lines.</div>
            <div class="link-card__meta">
                <img
                    class="link-card__icon"
                    src="/<prefix>/link/ab12cd.png"
                    alt=""
                    width="20"
                    height="20"
                    loading="lazy"
                    decoding="async"
                />
                <span class="link-card__site">example.org</span>
                <span class="link-card__author">Author name</span>
            </div>
        </div>
        <div class="link-card__thumb">
            <img
                src="/<prefix>/link/ef34ab-480.avif"
                alt=""
                width="480"
                height="270"
                loading="lazy"
                decoding="async"
            />
        </div>
    </a>
    <figcaption class="link-card__note">My note: <a href="/…">Note title</a></figcaption>
</figure>
```

115. `data-kind` values: `external`, `own` (a site of the author), `note`, `product`, `video`.
116. `data-state` values:
     - (a) `rich`: title, description, icon, image.
     - (b) `compact`: no image.
     - (c) `bare`: no metadata, one line.
     - (d) `dead`: the last check failed with "not found" or "gone".
     - (e) No state for a target that is not live: no card is in the HTML (item 112).
117. Rules.
     - (a) Width and height are set on both images, and the thumbnail box has a fixed ratio, so a card never shifts the text.
     - (b) The whole card is one link. The "My note" line sits outside it, because a link inside a link is not valid.
     - (c) External cards open in the same tab, like other external links (D21). Product cards follow the rule for ads.
     - (d) The site line always shows the real host, so the reader knows where a click leads.
     - (e) A stack of cards is a list: `<ul class="link-cards">` with one card per `<li>`.
     - (f) A note card adds the type badge in the meta row and has no "external" glyph.
     - (g) Each click on a card sends the outbound link event with `kind` and the host (spec 9.9.3).
     - (h) On phones the thumbnail moves above the text or hides, by a theme token.

### B.5 The YouTube card (lite embed)

118. Structure:

```html
<figure class="video-card" data-provider="youtube" data-video-id="VIDEO_ID" data-state="idle">
    <a class="video-card__link" href="https://www.youtube.com/watch?v=VIDEO_ID">
        <img
            class="video-card__poster"
            src="/<prefix>/video/VIDEO_ID-640.avif"
            alt=""
            width="640"
            height="360"
            loading="lazy"
            decoding="async"
        />
        <span class="video-card__play" aria-hidden="true"></span>
        <span class="video-card__title">Video title</span>
        <span class="video-card__meta">Channel name, on YouTube</span>
    </a>
    <figcaption class="video-card__notice">
        The player loads from YouTube when you press play.
    </figcaption>
</figure>
```

119. Data, read at publication and kept in the metadata cache: title and channel from the public oEmbed endpoint of YouTube (no key), the still image from the YouTube image host, stored locally in two sizes.
120. States:
     - (a) `idle`: local image, title, play mark. No request to YouTube or Google. This is the state in the HTML.
     - (b) Without JavaScript: the card is a normal link to YouTube.
     - (c) `loading`: after a click or Enter, a small script replaces the link with `<iframe src="https://www.youtube-nocookie.com/embed/VIDEO_ID?autoplay=1" title="Video title" allow="…" allowfullscreen>`. The start time of the note URL is kept.
     - (d) `playing`: the player has the focus.
     - (e) `unavailable`: the video was private or removed at the last check. The card is a bare link with a mark.
     - (f) A click with Ctrl, Cmd or the middle button opens YouTube in a tab, as a link does.
121. Rules.
     - (a) The script is one click listener on the document (a few lines in the base script). It loads nothing from YouTube by itself.
     - (b) The security policy allows frames from the no-cookie host only (spec 9.15).
     - (c) The click is the consent for the embed (spec 9.17.4). The notice line says what happens.
     - (d) The fixed 16:9 box prevents a layout shift when the player replaces the image.
     - (e) The same structure serves other players later (`data-provider`).
     - (f) The cached data gives `VideoObject` structured data (item 262).

## C. The command palette for the notes site

### C.1 What the store does today

122. Opening: `/`, `Ctrl+K` or `Cmd+K`, and a search button in the header that shows the `/` key. The component loads at the first opening (`React.lazy`), not with the page.
123. How the store handles key conflicts: it does one thing. When the focus is in an input, a text area or an editable element, it ignores the key. Else it calls `preventDefault` and opens the palette. It therefore takes `/` away from the quick find of Firefox and `Ctrl+K` away from the browser search field. It has no check for other modifier keys, so `Ctrl+/` and `Ctrl+Alt+K` open the palette too.
124. Commands: every product (name, tagline, price), 15 fixed actions (home, cart, wishlist, all products, featured, best value, best sellers, success stories, compare, quiz, categories, tags, testimonials, FAQ, help), every category, every tag. With an empty query it shows products, actions and featured categories.
125. Search: a fuzzy search over four weighted fields (title 5, subtitle 3, tags 2, categories 1) with the uFuzzy library and a letter-order fallback, so "obsk" finds "Obsidian Starter Kit" (`src/lib/fuzzy-search.ts`). All data is in memory: the store has 24 products.
126. Interface: a dark backdrop with blur, a panel of at most 672 pixels at 15 percent from the top, a 16 pixel radius, an input row, groups with small upper-case titles and counts, rows with an icon box, title, one line and badges, and a footer with the keys (arrows, Enter, Escape, `/`). Arrow keys move, Enter runs, Escape closes, the pointer selects on hover, the selected row scrolls into view.
127. Accessibility: `role="dialog"` and `aria-modal` on the backdrop, `role="combobox"` with `aria-controls` and `aria-activedescendant` on the input, `role="listbox"` and `role="option"` with `aria-selected` on the rows. Missing: a focus trap, the return of the focus to the opener, an announcement of the number of results.
128. Events: opened (keyboard or click), searched (length of the query and number of results, after a pause of half a second), selected (type, id, name).

### C.2 Commands at the first release

129. **Go to a note** by title or alias. The default mode: typing filters the title index. Rows show the title, the type badge and the folder. An alias match shows "alias of" plus the title.
130. **Search the full text.** The last row of every result list: "Search all text for" plus the query. It also starts by itself when the title index gives fewer than three results and the reader stops typing. It loads Pagefind at that moment (spec 9.6).
131. **Open the graph** (`Ctrl+G`).
132. **Open the local graph of this note.** Only on a note page. It scrolls to the local graph or opens it as a dialog.
133. **Go to recent notes**: recently added, recently updated.
134. **Open a random note.** The pick uses the title index that is already loaded. A second command picks inside the type of the current note.
135. **Switch the mode** (light, dark, follow the system) and **switch the theme** (when more than one exists).
136. **Copy this note as Markdown.** It fetches the Markdown URL of the note and writes it to the clipboard (story 16).
137. **Download this note as Markdown** (story 15).
138. **Go to a tag.** Typing `#` filters the tag list.
139. **Go to a note type hub.** Typing `:` filters the type list.
140. **Switch stacked pages on or off.** The command exists from the first release and is hidden until the feature ships (D36). The registry then needs no change.
141. Small additions with no extra data: go to the home page, copy the link of this note, go to the top, show the keyboard shortcuts, report a problem with this note (story 43).
142. The empty state (no query) shows: the commands for the current note, then the navigation commands, then the last five notes that the reader opened (kept in local storage).

### C.3 Keyboard map

143. `/`: open the palette. Not when the focus is in a field. Not with Ctrl, Alt or Cmd. The handler tests the produced character, not the physical key: on an AZERTY keyboard `/` needs Shift.
144. `Ctrl+K` or `Cmd+K`: open the palette, also from inside a field. Not with Shift or Alt.
145. Inside the palette: arrows move, Enter opens, `Ctrl+Enter` or `Cmd+Enter` opens in a new tab, Escape clears the query and then closes, Backspace on an empty query leaves a prefix mode.
146. `?`: show the shortcuts. Not when the focus is in a field.
147. `Ctrl+G` or `Cmd+G`: open the global graph. This needs care:
     - (a) In Chrome, Edge and Firefox `Ctrl+G` is "find next" after a search in the page with `Ctrl+F`. On macOS `Cmd+G` does the same in every browser.
     - (b) The current notes site already uses it for the graph, so readers of today expect it (research 1.7, feature 7).
     - (c) The spec recommends no override (D54). The author now asks for the shortcut. D54 must record that answer.
     - (d) The store gives no model for this conflict: it overrides and guards only against typing in a field (item 123). The Ghost theme adds two guards: no Shift or Alt, and `preventDefault` only when the target exists (item 21).
     - (e) Proposal: take the key with three guards. One: not when the focus is in a field. Two: not with Shift or Alt. Three: when the reader pressed `Ctrl+F` or `Cmd+F` on this page view, the site leaves `Ctrl+G` to the browser until the next page. A reader who searches in the page keeps "find next". All others get the graph.
     - (f) A second way with no conflict: the palette command, the visible graph button (with `aria-keyshortcuts`), and the key sequence `g` then `g` (the backlog has sequences, S30).
     - (g) One switch in the shortcuts sheet turns the override off, stored in local storage.
148. All shortcuts come from one registry with id, title, keys, scope and action. The palette, the key handler and the shortcuts sheet read it (item 241).

### C.4 How it stays light

149. On every page: the search button, and about 30 lines in the base script that listen for the keys and for a click on the button. No framework. Note pages keep their budget (spec 9.14.2).
150. At the first opening: one dynamic `import()` loads the palette module (plain TypeScript, a custom element or a small class) and its style sheet. Estimate: under 10 KB compressed with the fuzzy matcher. To measure in the prototype.
151. Warm-up: a pointer over the search button, or a focus on it, starts the load of the module and of the title index. A key press then finds them ready.
152. Then: the title index (item 156). Commands, tags and types are small and travel with the module or with the index.
153. Only on demand: Pagefind and its index parts.
154. Without JavaScript the search button is a link to the search page. The palette is an enhancement of that link.
155. The base script must know the hashed URL of the module and of the index. The build writes both as data attributes on the search button.

### C.5 The index for 20,700 titles and about 6,900 aliases

156. Format: one JSON file with columns, not one object per note.

```json
{
    "v": 1,
    "folders": ["<folder path 0>", "<folder path 1>"],
    "types": ["article", "book", "person"],
    "notes": [
        ["Note title", 12, 3],
        ["Other title", 40, 7, "file name when it differs"]
    ],
    "aliases": [
        ["PKM", 1532],
        ["Second brain", 77]
    ],
    "tags": [["obsidian", 412]]
}
```

157. A note row holds: title, index of its folder, index of its type, and the file name only when it is not the title. The URL is computed from folder and file name with the one URL function of the site (U13), so the file holds no URL text. An alias row holds the alias and the row number of its note.
158. Size estimate. Assumptions, to replace with measured values: a title has 30 characters on average, an alias 20.
     - (a) Notes: 20,700 rows of about 42 bytes: about 870 KB.
     - (b) Aliases: 6,900 rows of about 30 bytes: about 205 KB.
     - (c) Folders, types and tags: about 60 KB.
     - (d) Total: about 1.1 MB raw. Text like this compresses about four times with Brotli: about 280 KB on the wire.
159. Two parts make the first load smaller. The media types are about half of the notes (10,459, spec 9.1.6).
     - (a) Part 1: all notes that are not media notes, and all aliases. About 550 KB raw, about 140 KB compressed. It loads at the first opening.
     - (b) Part 2: the media titles. It loads when the reader types a third character, or at once when the current page is a media note.
160. Matching: all rows are normalized one time after the load (lower case, accents removed). Rank: exact title, then start of the title, then start of a word, then inside a word, then letters in order (the fallback of the store). Aliases rank just under titles. The list shows 50 rows at most. A linear scan over 27,600 short strings is fast enough for each key press. A worker is not needed at this size. To confirm on a phone.
161. Cache: the index URL has a content hash and a long cache time (spec 9.14.8). A reader loads it one time per publication that changes a title.
162. Privacy: the index is a build output like the search index. It holds live notes only, and the privacy gate tests cover it (spec section 10, item 3). An alias is public data today: it resolves as a URL.

### C.6 Accessibility

163. The panel is a native `<dialog>` opened with `showModal()`. The browser then traps the focus, makes the page behind inert, closes on Escape, and returns the focus to the opener.
164. The input is a combobox: `role="combobox"`, `aria-expanded`, `aria-controls`, `aria-activedescendant`, `aria-autocomplete="list"`. The list is a `listbox`. Groups are `role="group"` with a label. Rows are `role="option"` with `aria-selected`.
165. A polite live region says the number of results after the reader stops typing ("12 notes, 3 commands"). The store has such a component for its filters.
166. The search button has a text label, `aria-haspopup="dialog"` and `aria-keyshortcuts="/ Control+K Meta+K"`.
167. Key handling ignores events during text composition (input methods), and never takes a key while the focus is in a field, except `Ctrl+K`.
168. On phones the panel fills the screen, rows are at least 44 pixels high, and a close button is visible.
169. The opening animation is a short fade. It is off under reduced motion.
170. The selected row differs by background and by a marker, not by color only.

## D. Design token comparison

### D.1 The three token sets

| No. | Role                           | Store (`src/styles/index.css`)                                                                | PKM wiki (`themes/*.css`)                                                                       | Ghost theme (`screen.css`)                                                                                |
| --- | ------------------------------ | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 171 | Page background                | `--color-background` (`#37404c` dark, `#f5f7fa` light)                                        | `--theme-bg` (same values in `knowii`)                                                          | `--background-color`, a theme setting (`#ffffff`)                                                         |
| 172 | Surface and raised surface     | `--color-surface`, `--color-surface-elevated`                                                 | `--theme-bg-elev`, `--theme-bg-elev-2`                                                          | None. Boxes use `--color-lighter-gray` (5 percent black)                                                  |
| 173 | Text                           | `--color-primary`                                                                             | `--theme-ink`                                                                                   | `--color-primary-text` (`#15171a`)                                                                        |
| 174 | Soft and muted text            | `--color-text-muted` (60 percent)                                                             | `--theme-ink-soft` (70), `--theme-ink-muted` (50 to 55)                                         | `--color-secondary-text` (55 percent)                                                                     |
| 175 | Lines                          | `--color-border`                                                                              | `--theme-line`, `--theme-line-strong`                                                           | `--color-border`, `--color-dark-border`                                                                   |
| 176 | Subtle card fill and its hover | `--color-card-subtle`, `--color-card-subtle-hover`                                            | `--theme-card-subtle`, `--theme-card-subtle-hover`                                              | None                                                                                                      |
| 177 | Accent as fill                 | `--color-secondary` (`#e5007d`, `#d10070` light)                                              | `--theme-accent`                                                                                | `--ghost-accent-color` (`#fd3585`), and `#d42d70` typed in for buttons                                    |
| 178 | Accent as text                 | `--color-secondary-text` (`#ff1493`, `#c20066` light)                                         | `--theme-accent-text`, `--theme-accent-muted`                                                   | `#be2460`, typed in at four places                                                                        |
| 179 | Status colors                  | `--color-success` and four variants, `--color-problem`, `--color-agitate`, `--color-solution` | `--theme-success`                                                                               | None                                                                                                      |
| 180 | Fonts                          | `--font-sans` (Noto Sans, from Google Fonts)                                                  | `--theme-font-sans`, `--theme-font-display`, `--theme-font-mono` (per theme, from Google Fonts) | `--font-sans` (Inter, self-hosted), `--font-serif`, `--font-mono`, `--gh-font-heading`, `--gh-font-body`  |
| 181 | Radius                         | No token. Utilities: 12 pixels (cards), 16 (palette), full (chips)                            | `--radius-card` (16 pixels), `--radius-pill`                                                    | No token. 8 pixels (buttons, boxes), 6 (bookmark), 999 (pills)                                            |
| 182 | Shadows                        | No token. Utilities, and a colored shadow on hover                                            | No token. Colored shadow from the accent with `color-mix`                                       | No token. Two soft shadows (sticky bar, message)                                                          |
| 183 | Layout                         | Breakpoints 600, 960, 1280, 1600, 1920, 2440                                                  | Breakpoints 640, 768, 1024, 1280, 1536                                                          | `--container-width` (1320, article 1120), `--container-gap`, `--grid-gap`, text column 720                |
| 184 | Type scale                     | Tailwind scale, line height 1.7, letter spacing 0.01em                                        | Same body values. Headings with negative letter spacing                                         | Root at 62.5 percent, `--content-font-size` (1.7rem), `--factor` for headings, `--content-spacing-factor` |
| 185 | Mode                           | `data-theme="dark"` or `"light"` on the root. Default dark. Stored choice                     | `data-mode`. Default per site. Stored choice, read before the first paint                       | Light only. A class from the brightness of the background                                                 |
| 186 | Theme choice                   | One theme                                                                                     | One file per theme, chosen at build time                                                        | Theme settings in the Ghost admin (fonts, background, accent)                                             |

187. Shared by all three: the same seven roles (background, text, muted text, line, accent fill, accent text, fonts). The store and the wiki share values and structure. The wiki file says that it mirrors the store.
188. Different: the names (three prefixes), surface levels (the Ghost theme has none), status colors (the Ghost theme has none), the font (Noto Sans against Inter), the radius scale, the use of shadows, the default mode, the heading style, the link style, the breakpoints.
189. Not a token anywhere: radius (except two in the wiki), shadows, motion, focus ring, link colors, code colors, callout colors, graph colors, the progress bar.
190. The word "theme" means two things. In the store, `data-theme` is the mode (dark or light). In the wiki, the theme is the look and `data-mode` is the mode. The notes site should use the wiki meaning.

### D.2 Proposed token set for the notes site

A theme is one file that sets these tokens two times: for the dark mode and for the light mode. Components never use a raw color, font, radius or shadow.

191. Surfaces: `--c-bg`, `--c-surface`, `--c-surface-raised`, `--c-well` (code blocks, chart areas), `--c-overlay` (backdrop of dialogs).
192. Text: `--c-text`, `--c-text-soft`, `--c-text-muted`.
193. Lines: `--c-line`, `--c-line-strong`.
194. Accent: `--c-accent` (fills, borders, decoration), `--c-on-accent` (text on an accent fill), `--c-accent-text` (accent as text, must pass contrast on `--c-bg` and `--c-surface`).
195. Links: `--c-link`, `--c-link-hover`, `--c-link-visited`, `--c-link-unpublished`, `--link-decoration`.
196. Focus and selection: `--c-focus`, `--focus-width`, `--c-selection`, `--c-mark` (highlights).
197. Status: `--c-success`, `--c-warning`, `--c-danger`, `--c-info`, each with a `-bg` variant.
198. Content colors: callout families (`--c-callout-<kind>` and `-bg`), code (`--c-code-bg`, `--c-code-text`, and the syntax colors), tables (`--c-table-stripe`).
199. Data colors: graph (`--c-graph-node`, `--c-graph-hub`, `--c-graph-link`, `--c-graph-dim`), a color per note type (`--c-type-1` to `--c-type-n`), chart colors. The graph reads them from the page, as the wiki graph does.
200. Fonts: `--font-body`, `--font-heading`, `--font-ui`, `--font-mono`.
201. Type: `--text-base`, a size scale, `--leading-body`, `--leading-heading`, `--tracking-body`, `--tracking-heading`, `--weight-heading`, `--heading-transform`, `--measure` (line length), `--text-align-body`, `--hyphens`.
202. Shape: `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-pill`, `--border-width`.
203. Elevation: `--shadow-sm`, `--shadow-md`, `--shadow-lg`, `--shadow-accent` (the colored hover shadow).
204. Space: `--space-block` (between blocks of text), `--space-heading` (before a heading), `--page-width`, `--content-width`, `--gap`.
205. Motion: `--dur-fast`, `--dur-base`, `--ease`. One global rule sets the durations to zero under reduced motion.
206. Component tokens, for the places where two themes differ in structure and not only in color: `--card-bg`, `--card-border`, `--card-radius`, `--card-shadow`, `--card-lift` (movement on hover), `--card-image-radius`, `--heading-marker` (the short accent bar before section titles: on or off), `--button-radius`, `--chip-radius`, `--quote-border-width`, `--progress-height`, `--c-progress-from`, `--c-progress-to`, `--progress-glow`.
207. Contract: `<html data-theme="knowii" data-mode="dark">`. The inline script in the head sets both before the first paint from the stored choice, else from the system, else from the default mode of the theme (D7). Tailwind maps its colors to the tokens with `@theme inline`, as the wiki does.
208. Theme 1 (`knowii`) takes its values from the store and the wiki: the slate backgrounds, white text, the magenta as fill, Noto Sans, 12 to 16 pixel radius, tinted cards with a border, the colored hover shadow, the accent bar before section titles. One value is new: a link color that passes contrast on the dark background (spec 9.14.7). The two magentas do not.
209. Theme 2 (working name `classic`) takes its values from the Ghost theme: white background, `#15171a` text, `#fd3585` as fill, `#d42d70` under white button text, `#be2460` for links, Inter, 8 pixel radius, almost no shadow, cards without border or fill.

### D.3 What theme 2 needs beyond colors

210. Fonts: Inter (variable, roman and italic) and a monospace font. Font files load per theme, so a reader of theme 1 never downloads Inter.
211. Type scale: a 17 pixel body, tight headings (letter spacing about -0.02em), a larger title with a fluid size.
212. Heading treatment: bold sans headings, the title in capitalized form (`--heading-transform`), no accent bar.
213. Radius: one small value (8 pixels) for buttons, boxes and cards, and pills for chips.
214. Shadows: none on cards. One soft shadow for floating parts (bars, messages, dialogs).
215. Card style: image on top, text below, no border, no fill, no lift on hover. This is why the card needs component tokens: color tokens alone cannot remove a border.
216. Link style: underlined dark pink in the text. Theme 1 uses color without underline.
217. Quote and "In short" style: a 4 pixel accent border on the left and a light tint.
218. Rhythm: 28 pixels between blocks, 56 before a heading, a 720 pixel text column inside a 1,120 pixel article.
219. A dark mode. The main site has none, so it must be designed: a near-black background, the same pinks checked for contrast again.
220. A default mode per theme: light for theme 2, dark for theme 1. D7 then reads "the default mode of the active theme".
221. Code and callout colors for a light page.
222. Graph and chart colors that work on white.
223. The progress bar values of the main site (gradient to a lighter pink, glow).
224. `theme-color` and the favicon background per theme and mode.
225. Not per theme: Open Graph images, feeds, Markdown output. They have one brand look.
226. A test per theme and mode: contrast of each text and link pair (item 271) and one screenshot per page type (item 307).

## E. New ideas

Checked against `spec-v1.md` and `ideas-backlog.md`. Where an idea is close to an existing one, the text says how it differs. Tags: `[quick]` cheap and static, `[build]` real work, `[server]` needs a running service, `[wild]` speculative.

### E.1 Reading

227. [quick] **"In short" box.** A note with a `description` shows it under the title in a labeled box, and the `speakable` structured data points to it. The reader and an answer engine both get the one-paragraph answer first. (Backlog 41 shows the description in search results only.)
228. [quick] **Section marks on the progress bar.** Small marks on the bar show where each second-level heading starts. The reader sees the shape of a long note and how far the next section is.
229. [quick] **Resume reading.** The page stores the scroll position of long notes in local storage and offers "continue where you stopped" on the next visit. Long articles and newsletters are seldom read in one sitting.
230. [quick] **Progress ring on the back-to-top button.** The round button draws the reading progress as a ring around its arrow. Two controls become one, which helps on phones where the top bar is thin.
231. [quick] **Wide tables with a fixed first column.** A wide table scrolls inside its box, keeps its first column in view, and shows a soft edge where content is cut. The media notes and the frozen query tables are wide.
232. [quick] **Gallery from neighbor images.** Images that follow each other open as one gallery with arrows in the zoom view. The reader does not close and open for each image.
233. [build] **Time links for videos.** A time written near a video card (`12:30`) becomes a button that starts the player at that time. Notes about talks and tutorials become an index of the video. (Backlog 49 is about transcripts in the search.)
234. [build] **Preview of external links.** A hover or a long press on an external link in the text shows title, site and description from the metadata cache. The reader decides before leaving, and no third-party request is made. (Backlog S26 covers internal links.)
235. [build] **Cards that know their source.** Link cards for a few hosts show more: a repository shows its language and license, an encyclopedia page its first sentence, a paper its authors and year. The data is read one time at publication.
236. [build] **Static cards for social posts.** A LINK to a post on a social network becomes a quote card with author, text and date, written at publication. No embed script of the network ever loads.

### E.2 Navigation

237. [build] **Link library.** One generated page lists every LINK card of the garden, grouped by site and by topic, with the notes that cite each one. About 800 notes carry such links, so the author's reading list becomes a browsable directory, and "most cited sites" comes for free.
238. [quick] **Thumb bar on phones.** A small bar at the bottom of the screen holds four buttons: search, outline, graph, mode. The header controls are out of reach on a tall phone.
239. [quick] **Prefix modes in the palette.** `>` shows commands only, `#` tags, `@` people, `:` note types. A frequent reader reaches the right list with one character. (Backlog 38 is about operators in the full-text search.)
240. [quick] **Paste a link into the palette.** The palette accepts any old form of a notes URL, a file name or an alias, and jumps to the note through the resolver. It makes the URL contract visible and useful.
241. [build] **One command registry.** One list of commands feeds the palette, the keyboard shortcuts, the shortcuts sheet and the tools that the page registers for browser agents (story 84). A new command then shows in four places with one change.
242. [quick] **Prefetch on intent.** Speculation rules let the browser fetch an internal link when the pointer rests on it. A static page that is already small then opens at once. (Backlog 50 is about the transition effect, not the fetch.)
243. [quick] **Jump row on long hub pages.** A sticky row of pills follows the scroll through the sections of a hub. On phones it is a native select. The articles page of the main site proves the pattern.
244. [quick] **"Start with the best" row.** A `featured` property puts up to three notes at the top of their tag page and type hub. The author curates with one property, and a newcomer gets a first choice. (Backlog S6 ranks by traffic, not by the author's choice.)
245. [build] **Lasso to list in the graph.** The reader draws around a group of nodes and gets the notes as a list, with "copy as Markdown links". A picture becomes something that the reader can take away.
246. [quick] **Reading list with a share link.** A "save for later" button keeps notes in local storage, and the list has a URL that carries its content. (Backlog 3 records the visited trail by itself. This list is a choice of the reader.)
247. [build] **Garden quiz.** Four questions lead to one map of content or one trail. The store quiz shows the mechanics. It helps the reader who does not know the words to search for.
248. [quick] **Complete index.** A paginated plain list of all notes, by letter, with `rel="next"` links. Every note is then a few links away from the home page, for readers and for crawlers. (Backlog 8 indexes the aliases.)

### E.3 Conversion

249. [quick] **One decision per ad block.** The block shows one product, one free alternative ("not ready to buy? start free") and nothing else. Two equal product cards ask the reader to compare. One offer with a free way out asks for one small choice.
250. [build] **One offer map for all sites.** A data file maps a topic to its product and its free resource. The notes site, the Ghost theme and the wiki read it. The same topic then shows the same offer on every site, and a change is made one time.
251. [quick] **Newsletter bar that waits.** The fixed bar shows after 30 percent of the note and leaves before the footer. A reader who just arrived is not asked for an email, and the bar never covers the last lines.
252. [quick] **Ads that know a subscriber.** After a signup, a flag in local storage turns newsletter ads into the next step (a free resource, then the community). The main site does this for members. A flag gives a light form of it without accounts.
253. [quick] **Promotion bar from the store.** A thin bar reads the promotion data of the store at view time: text, code, end date. A sale shows on 20,700 pages with no build of the notes site.
254. [quick] **Products in the palette.** A query that matches a product name or tag shows one product row under the notes, with the price. A reader who types "starter kit" wants the product page. (Backlog 43 puts course chapters into search results.)
255. [quick] **Buy box on product notes.** A note that describes a product of the author shows name, price and button from the catalog at its top. The main site rewrites links to these notes today, which proves that readers land on them with intent.
256. [build] **"From the blog" strip.** The build reads the tag feeds of the main site and shows the newest article of the matching topic under a note. The garden sends readers to the long form, where the newsletter forms are.
257. [quick] **Curriculum signpost.** A note whose topic belongs to one of the five layers of the free curriculum shows one line: "Part of the (layer name) layer", with a link to the start page of the main site. Readers from a search find the guided path.
258. [quick] **Own video card.** When the channel of a video card is the author's, the card adds a "subscribe to the channel" link. The check is one line of configuration.
259. [quick] **Prompt for a reader who leaves.** One newsletter dialog for a reader who read half of a note or stayed 25 seconds and then moves to leave, at most one time per week. The main site runs it. It is a decision of taste for a garden, so it should ship behind a switch with its own event.

### E.4 SEO and AI visibility

260. [quick] **One entity graph for three hosts.** The person and the organization get one `@id` each, used by the notes site, the main site and the store. Today the main site and the store declare two different ids for the same person, so search engines see two people.
261. [quick] **Canonical handshake test.** A check reads the posts of the main site that name a notes URL as canonical and tests each URL: status 200, canonical to itself, indexable. It runs before the switch and at each publication.
262. [quick] **`VideoObject` for video cards.** The cached title, channel, image and date of each video card go into the structured data of the note. Notes with a video can then show in video results.
263. [quick] **LINK cards as citations.** Each external LINK card adds a `citation` entry (name, URL, publisher) to the structured data of the note. Machines see which sources a note builds on.
264. [quick] **Learning path data.** A map of content that the author marks as a path gets `LearningResource` data with its steps, as the start page of the main site has. It tells answer engines that the page is a course outline, not a link list.
265. [quick] **URL grammar in `llms.txt`.** A "content structure" section explains the URL patterns: a note, its Markdown, a tag, a type, the feeds, the search. An agent can then build the right URL without a crawl.
266. [quick] **"Best of" and "updated" feeds.** One low-volume feed holds the featured notes. One feed holds significant updates only. Followers who do not want every new note get a feed that fits. (Backlog S50 lists feeds by type, tag and topic.)
267. [quick] **Feeds page.** One page lists every feed with one line each, states the rule "every tag and type has a feed", and explains RSS in three sentences. It is the human side of the feed links in the head.
268. [quick] **Cards as text for agents.** The Markdown form writes each card as `[title](url): description`. An agent that reads the note gets the title of the source without a second request.

### E.5 Trust

269. [quick] **Numbers from the data, never typed.** Counts in the site copy (notes, links, types) come from `stats.json` at build time through named tokens, and the build fails on an unknown token. No page states a number that is out of date.
270. [quick] **"Last published" line.** The footer shows the date of the last publication with a link to the change log. A garden that shows when it was tended looks alive.
271. [quick] **Contrast gate for tokens.** A test computes the contrast of each text, link and focus pair of each theme and mode, and fails under the WCAG AA limits. A new theme cannot ship unreadable text.
272. [quick] **"What this site records" page.** One page lists every analytics event with its properties and the reason for it, generated from the event dictionary. It says: no cookies, no query text, no personal data. (The backlog has "why this ad", item 80, and the weight receipt, item 131.)
273. [quick] **Stable anchors on generated pages.** The sections of generated pages (home, recent, stats, hubs) have documented ids that do not change. The store keeps such a list. Links from articles and newsletters to a section then keep working.
274. [quick] **Honest link cards.** Each external card shows the real host, and the card of a page that was last read long ago shows that date. The reader knows where a click goes and how fresh the preview is.

### E.6 Delight

275. [quick] **Theme lab page.** One generated page shows every component in every theme and mode: cards, callouts, code, tables, ads, forms. It is the review surface for a new theme and the target of the screenshot test.
276. [build] **Offline shelf.** A service worker keeps the notes that the reader opened and lets the reader save a map of content for offline use. The garden then works on a train. (Backlog S46 is an archive to download.)
277. [quick] **Hero line from the newest notes.** The hero of the home page ends with the titles of the newest notes, one after the other. It is static text under reduced motion. The page then looks different after each publication.
278. [quick] **Finish line.** When the progress bar is full, it pulses one time and the "next" links come into view. The end of a note gets a small reward and a clear next step.
279. [build] **Graph peek.** A hover on the graph button shows a small picture of the neighborhood of the current note, made at build time. The reader sees whether the graph is worth opening.
280. [quick] **One message component.** Copy, download, mode switch and save all confirm through the same small message with a live region. Feedback then looks and sounds the same everywhere.

## F. Gaps: proposed additions to the spec

Things that the Ghost theme, the store, the plugin or the wiki do and that `spec-v1.md` does not mention. Each line names the section where it belongs.

281. **Reading progress bar on all pages** (items 7 to 15). New reader story in 8.1, a line in 9.4, and the rule "CSS first" in 9.14.
282. **LINK cards and the lite video card** (section B). A new point in 9.2.1. A step "read link metadata" in 6.4. A row in section 7: images and icons of other sites are stored locally and stripped. A line in 9.15: frames from the no-cookie video host only. A line in 9.17.2: preview images of other sites. Fixtures in 10.5.
283. **Command palette at the first release, opened with `/`.** Story 26 is "should" and 9.6.6 says "later". The author's statement moves it up. Section 9.6 needs the two-step load and the index format of section C.
284. **`Ctrl+G` for the graph.** D54 and 9.5.4 recommend no override. The author asks for the shortcut. Record the answer in the decision log, with the guards of item 147.
285. **Canonical direction for news and articles.** Spec 9.13.7 says: these notes are `noindex` on the notes host, or canonical to the main site. The live main site says something else today (item 53): its news posts name the notes URL as canonical, and its articles name themselves. The rule must therefore differ by type. A news note is canonical to itself and indexable, because the main site already points to it. An article note points to the main-site article, or the author decides to turn that around. Rewrite 9.13.7 with one line per type, and add the test of item 261 to the switch gate (11.2).
286. **Share row and native share** (item 32). New story in 8.1, a line in 9.4.2.
287. **Structured data details.** 9.13.3 says "JSON-LD by note type". Add: fixed entity ids shared with the other hosts, `BreadcrumbList` from the "part of" chain, `CollectionPage` with `ItemList` on tag pages and hubs, `speakable` on the summary, and the rule that a serializer writes every block.
288. **Head hygiene.** 9.13.1: one component writes each tag one time, `robots` carries `max-image-preview:large`, every generated page has its own title. 10.8: a test for duplicate tags and duplicate titles.
289. **Open Graph tags are the input of bookmark cards on the main site.** Ghost builds its cards for notes URLs from the tags that the notes site serves: title, description, image, icon, site name. Add to 10.8: a notes URL gives a complete card.
290. **Feed links in the head and a feeds page.** 9.7.2: each page links the feeds that match it (all notes, its type, its tag). Add the page of item 267.
291. **One event dictionary.** 9.9.3 lists new events. Missing: scroll depth, note read to the end, section link copied, palette opened, palette command run, link card clicked, video played, share used. Missing too: one naming rule. The three sites use three styles today.
292. **What a search event may carry.** Story 74 needs the text of failed searches. The store and the wiki send only the length. 9.9 must decide and say it.
293. **Outline on small screens.** 9.4.3 has a side column for wide screens only. Add the sticky "current section" bar and the minimum number of headings (item 22).
294. **Ad details.** 9.10: the card is complete in the HTML and a script only refreshes the price. Slots inside the text are computed at build time with the heading rule of item 43d. Related notes come before the ad. Each ad carries position and topic attributes.
295. **Offer format and hand-set rules.** 9.10.2 knows scoring only. Add the hand-set map that wins over the score (item 250) and the "one product, one free resource" format (item 249).
296. **Behavior of the newsletter bar.** 9.11.1: when it appears, when it leaves, what "closed" means (session or for good), and that a signup is remembered.
297. **Author line.** 9.4.2 has no author element. Add a short author line on notes with own text, and the `Person` entity in 9.13.3.
298. **Notes with a commercial home.** 5.4 acceptance test 3 must include the eleven notes URLs that the main site rewrites to store pages (item 20). 9.10 gets the known URL map and the buy box.
299. **Small Markdown features.** 9.2.1: a copy button on code blocks, a scroll box for wide tables, galleries from neighbor images, image captions.
300. **Footnote rules.** 9.2.1 names footnotes. Add the rules of item 37 and reuse the plugin tests in 10.5.
301. **Ordered sets.** 9.4: a strip for notes that belong to an ordered set, with "you are here" and the window rule (item 26).
302. **Accessibility details.** 9.14.10: a skip link, native dialogs with focus return, live regions for messages and result counts, `aria-keyshortcuts`, shortcuts that work on keyboards where `/` needs Shift.
303. **Motion as tokens.** 9.14: durations are tokens, one rule removes them under reduced motion, and no script scrolls smoothly when the reader asked for less motion.
304. **Security headers.** 9.15 names the content security policy. Add HSTS, `nosniff`, a referrer policy, a permissions policy and frame rules, as the store has.
305. **Public data files.** 9.16 and story 86: files for other sites and agents carry an open CORS header, a short cache time, and the envelope of `products-light.json` (`$schema`, `generatedAt`, `count`).
306. **Theme contract.** 9.14.6: the two attributes (`data-theme`, `data-mode`), a default mode per theme, fonts loaded per theme, component tokens, graph colors read from tokens, `theme-color` per theme and mode.
307. **Tests for the look.** Section 10: one screenshot per page type, theme and mode, and the contrast gate of item 271.
308. **Back-to-top button.** 9.4. The research lists it as a brand component. The spec does not.
309. **Footer.** 9.4 describes the header only. Add the footer columns (item 17) with product links from the catalog.
310. **Loading hints.** 9.14.3 and 9.14.4: a priority hint on the first image of the page and a preload of the body font.
311. **Cards in the Markdown output.** 9.16, design note 2: the cleaned Markdown writes cards as plain links with a title (item 113).
312. **Shortcut registry and help.** 9.4 or 9.6: one registry, a shortcuts sheet, a switch for the `Ctrl+G` override.
313. **No third-party request on a note page.** The store and the wiki load fonts, the search library and the graph library from other hosts. 9.14 and 9.15 should state the rule as a test: a note page loads from the notes host and the analytics proxy only.

## G. Short list

### G.1 Fifteen features of the Ghost theme to take

314. The reading progress bar, drawn with CSS and themed by tokens (item 15).
315. Heading link buttons that copy a clean section URL and confirm with a message (item 23).
316. The outline rules: four headings minimum, and a sticky "current section" bar on small screens (item 22).
317. One card component in four sizes with the stretched title link (item 24).
318. The tag page structure for tag pages and type hubs: description, best notes, list, one ad, feed link, structured data (item 27).
319. The series strip with "you are here" and the window rule (item 26).
320. Related notes before the ad (item 28).
321. The "In short" box with `speakable` data (item 31).
322. The bookmark card anatomy, as the base of LINK cards (item 39, section B).
323. The video facade, moved to build time with a local image (item 40, item 118).
324. Live prices: complete text in the HTML, refreshed from `products-light.json` (item 46).
325. The offer format "one product, one free resource", with position and topic attributes on every ad (items 47 and 48).
326. The newsletter bar that waits for 30 percent of scroll, and the slot rule for a band inside the text (item 43).
327. The entity graph in the structured data, with fixed ids, breadcrumbs and collection data (item 56).
328. The analytics method: one listener driven by data attributes, an event queue, calls that cannot break the page, scroll depth events (item 64).

### G.2 Fifteen ideas to look at first

329. One entity graph for three hosts (item 260): a small change that repairs how search engines see the author.
330. Canonical handshake test (item 261): it protects the pages that the main site already declares as canonical.
331. "In short" box (item 227): one element serves readers, search engines and answer engines.
332. LINK cards as citations (item 263): the card data is there, the structured data costs one function.
333. `VideoObject` for video cards (item 262): same reason.
334. Complete index (item 248): every note within a few links of the home page.
335. Link library (item 237): a new entry page from data that the cards already need.
336. One decision per ad block (item 249): the format that the main site chose when it rebuilt its end-of-article offers.
337. One offer map for all sites (item 250): the three sites stop drifting apart.
338. Buy box on product notes (item 255): the notes with the clearest buying intent get a button.
339. Newsletter bar that waits (item 251): the same ask, shown to readers who read.
340. One command registry (item 241): palette, shortcuts, help and agent tools from one list.
341. Prefetch on intent (item 242): the speed gain that static pages allow.
342. Contrast gate for tokens (item 271): it makes a second theme safe to add.
343. Theme lab page (item 275): the review and test surface for every theme.
