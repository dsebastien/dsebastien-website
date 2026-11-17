# Notes website

The public website of the author's notes, built from a private Obsidian vault, and the tool that publishes notes to it.

## Language

### Content

**Vault**:
The private Obsidian vault that holds all notes. The only source of content.

**Note type**:
The kind of a note in the vault (movie, quote, person, permanent note). It selects the layout and the properties that may be shown.
_Avoid_: category, template

**Attachment**:
A file that a note embeds: image, video, audio, PDF.
_Avoid_: asset, media file

**Folder note**:
A note that has the name of its folder. It can be the home of that part of the site.

**Stub**:
A media note with the default status, no rating and no text of the author.

**Cleaned note**:
The form of a note that can be published: the note without its private parts. Every output of the site derives from it.
_Avoid_: artifact, export

**Fixture vault**:
A small vault with invented notes only, made for tests.

### Publishing

**Published note**:
A note that is live on the site. Its `public_note` property states it, and only the publishing tool writes that property.
_Avoid_: public note as a wish of the author (the property is the state, not an intent)

**Candidate**:
A note that is not published and that no guard excludes. The author can select it for a publication.

**Publication**:
The act, started by the author in Obsidian, that makes selected changes live.
_Avoid_: deploy, sync, upload

**Publication queue**:
The list of new, changed and removed notes that wait for a publication.

**Skip**:
To leave a change in the publication queue without publishing it. The live version stays.

**Publication plan**:
The exact list of what one publication will do: the notes to publish, to update and to remove. The author reviews it before the publication.
_Avoid_: dry run (the act that gives a publication plan)

**Publication report**:
The result of a publication, shown to the author: what is live, what failed, and the warnings.

**Unpublish**:
To remove a published note from the site through a normal publication.

**Takedown**:
The immediate and complete removal of a published note and of everything derived from it.
_Avoid_: unpublish (which waits for a publication)

**Content store**:
The private snapshot of everything that is published: cleaned notes, attachments and the manifest. The site is built from it.
_Avoid_: export, public repository

**Manifest**:
The record of each published note: identity, path, former paths, dates and state.

**Rename journal**:
The record of the renames and moves of notes that wait for the next publication.

**Deny list**:
The vault folders and note types that can never be published. It lives in the configuration of the publishing tool.
_Avoid_: block list, ignore list, excluded folders

**Ignore property**:
A property on a note that says that the publishing tool must never publish that note.

**Privacy gate**:
The set of checks that every note, property and attachment passes before it can be published.

**Parity rule**:
The rule that the two implementations of the publishing logic give the same result for the same vault.

### Site

**Canonical URL**:
The one URL under which a note is served. Every other form redirects to it.

**Original**:
The URL that a page names to search engines as the one to rank. For a note that also exists on the main site, the original is the post there.
_Avoid_: canonical URL (that is the address of a note on this site)

**Main site**:
The website of the author on his main domain. It is not part of this project.
_Avoid_: blog, Ghost site

**Resolver**:
The function that turns a requested path into a canonical URL, a redirect, or "not found".

**URL contract**:
The rules that say which URL each note has and which other URLs lead to it.

**Generated page**:
A page that the site makes from many notes and that is not a note: home, type hub, tag page, search, graph.

**Reserved prefix**:
The path prefix under which every generated page lives, so that a generated page can never collide with a note.

**Type hub**:
The generated page that lists all published notes of one note type.

**Link card**:
A link that shows as a card with the title, the source and a small image of its target.
_Avoid_: bookmark, embed

**Store catalog**:
The list of products that the store publishes for other sites. Ads and the buy box read it.

**Ad**:
A promotion of one of the author's own products or resources on a page.
_Avoid_: CTA, banner

**Offer map**:
The list, set by hand by the author, that says which product and which free resource an ad shows for a topic.

**Buy box**:
The block at the top of a note about a product, with its name, its price and a button.

**Curated list**:
A list page with an intro of the author, made to be found by search engines.
_Avoid_: tag page, type hub (those are generated without an intro)

**Theme**:
A named set of visual values (colors, fonts, shapes). Each theme has a light and a dark mode.
_Avoid_: mode (light and dark are modes of a theme)

**Agent**:
A program that reads or uses the site for a person: crawler, AI assistant, coding agent.
_Avoid_: bot

**Switch gate**:
The conditions that must be true before the notes domain moves to the new site.
