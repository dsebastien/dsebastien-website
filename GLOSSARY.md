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

**Fixture catalog**:
The list that says which feature or trap each file of the fixture vault serves.

### Publishing

**Published note**:
A note that is live on the site. Its `public_note` property states it, and only the publishing tool writes that property.
_Avoid_: public note as a wish of the author (the property is the state, not an intent)

**Candidate**:
A note that is not published and that no guard excludes. The author can select it for a publication.

**Publication**:
The act, started by the author in Obsidian, that brings selected changes to the content store. It is done at its push; the deploy that follows it makes the changes live.
_Avoid_: deploy, sync, upload. A publication is not a deploy: it is done at its push to the content store, and the deploy follows it.

**Deploy**:
One run of the deploy command of the site: the build of a release from the copy of the content store, then its deployment. The publishing tool starts it on the machine that publishes after each push of a publication, an unpublish or a takedown, and the author can start it again. A failed deploy never undoes a publication.

**Deploy report**:
What the tool says about the deploy of the site that follows the push of a publication, an unpublish or a takedown: the push, the build and the deploy apart, whether the new release is live and its URL, the warnings and the error. It is apart from the publication report: the publication is done at the push, and a failed deploy never undoes it. In the code, in the output of the command line program and in the MCP server, it is the object `deployment`.

**Publication queue**:
The list of new, changed and removed notes that wait for a publication.

**Skip**:
To leave a change in the publication queue without publishing it. The live version stays. A plan names such a note in its paths to hold.

**Technical update**:
An update of a published note that the author did not edit: the cleaning step has a new version, or a link of the note leads to another note. It does not move the dates of the note.

**Publication plan**:
The exact list of what one publication will do: the notes to publish, to update and to remove. The author reviews it before the publication.
_Avoid_: dry run (the act that gives a publication plan)

**Publication report**:
The result of a publication, shown to the author: what is live, what failed, and the warnings.

**Publication center**:
The view of the plugin where the author reviews the publication queue, ticks what goes live, and starts a publication, an unpublish or a takedown.

**Unpublish**:
To remove a published note from the site through a normal publication.

**Takedown**:
The immediate and complete removal of a published or unpublished note and of everything derived from it, with no plan. Its addresses answer 404.
_Avoid_: unpublish (which waits for a publication)

**Forced removal**:
The removal of a published note that came under a guard. Every publication does it, whatever the author selects, and it removes everything as a takedown does.

**Content store**:
The private snapshot of everything that is published: cleaned notes, attachments and the manifest. The site is built from it.
_Avoid_: export, public repository

**Attachment storage**:
The storage that holds the attachments of the published notes, addressed by content hash. It is not part of the content store. On a host it is an object storage (a store of files by name, with no folder); on a device and in the tests, a folder.
_Avoid_: bucket, media store

**Manifest**:
The record of each published note: identity, path, former paths, dates and state.

**Rename journal**:
The record of the renames and moves of notes that Obsidian reported on one device. Each device has its own, and it travels with the vault.

**Move**:
The change of the path of a published note that a rename journal or a pairing gives. The note keeps its identity, and its old path becomes a former path.

**Former path**:
A path that a note had before a move. While the note is published, its address leads to the note; when the note is unpublished, its address is gone too.

**Pairing**:
A missing published note and a candidate that the author confirms as one note that moved without a line in a rename journal.

**Read marker**:
The record in the content store of how many lines of each rename journal the publications read, so that each line is applied one time.

**Run journal**:
The record that a publication writes on its device before its first write into the copy of the content store. When the run stops halfway, the next run reads it to put the copy back.
_Avoid_: rename journal (another record)

**Lock of the device**:
The mark that a publication runs on a device. One publication at a time per device; between devices, the refused push is the lock.

**Missing from this vault**:
A published note whose file this device does not have, and that no guard excludes. It is never selected by default.

**Deny list**:
The vault folders whose notes can never be published. It lives in the configuration of the publishing tool.
_Avoid_: block list, ignore list, excluded folders

**Guard**:
A rule that says that a note can never be published, whatever the author selects. The first version has two: the deny list and the ignore property.

**Ignore property**:
A property on a note that says that the publishing tool must never publish that note.

**Privacy gate**:
A set of automatic checks on the content of a note before it can be published. An idea for later: the first version has guards only.

**Parity rule**:
The rule that the two implementations of the publishing logic give the same result for the same vault.

**Canonical form**:
The exact written form of the output of the publishing logic, byte for byte. The parity rule compares outputs in that form.

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
The function that turns a requested path into a canonical URL, a redirect, "gone", or "not found".

**Gone page**:
The page of the answer 410. Every address of a note that the author unpublished leads to it, unless a published note has the address. It shows nothing of the note.
_Avoid_: 404 for an unpublished note (a takedown gives a 404)

**Server error page**:
The page of the answer 500. One file with no script, which shows also when another file of the release is missing.

**Release**:
The output of one build as the host serves it: the pages, the Markdown forms, the resolver map and the code, which go live together in one switch.

**Deployment**:
The act that puts a release on the host, after a publication, on the machine that publishes. It also brings the attachments of the release to the attachment storage and removes the ones that no published note uses, which covers the files of a takedown.
_Avoid_: publication (that is the act of the author, which a deployment follows)

**Deployment record**:
The small public file of a release that says which revision of the content store and of the code is live, and when it was built.

**Revert**:
The act that makes the release before the live one live again.
_Avoid_: unpublish, takedown (those remove notes)

**Resolver map**:
What the build writes for the resolver: which canonical path leads to which page, and which addresses are gone.

**Alias**:
Another name of a note, from its `aliases` property. A URL with the alias leads to the note.

**Folded form**:
A text in the composed Unicode form, then in small letters. Two texts with one folded form are one URL.

**Reserved root name**:
A name that the site answers at its root itself (`robots.txt`, a sitemap, `-`). No note may take one.

**Obsidian path**:
The path that Obsidian gives a file of the disk: a no-break space becomes a space, a run of slashes and backslashes one slash, the slashes at the ends go, and the name takes the composed Unicode form. A note whose vault path is not its Obsidian path is never published.

**Obsidian twin**:
A note whose Obsidian path is the Obsidian path of another note of the vault. A plan never publishes a new Obsidian twin. Not the same as the twin of a translated note.

**URL contract**:
The rules that say which URL each note has and which other URLs lead to it.

**Generated page**:
A page that the site makes from many notes and that is not a note: home, type hub, tag page, search, graph.

**Reserved prefix**:
The path prefix under which every generated page lives, so that a generated page can never collide with a note.

**Backlink**:
A published note that links to a note. The page of the note names it, with the sentence around its link.

**Link index**:
What the build knows about the links between the published notes: for a note, where its links lead, and its backlinks.

**Properties panel**:
The folding block of a note page that shows the properties of the note.

**Outline**:
The list of the headings of a note on its page, each one a link to its heading.

**Type hub**:
The generated page that lists all published notes of one note type.

**Type label**:
The name of a note type on the site: a singular one for the badge and the title of a note page, a plural one for its type hub.

**Library**:
The generated page that lists the type hubs of the media types (movies, games, shows).

**Title index**:
The index of the search that holds the display titles and the aliases of the published notes. It answers before the full text loads.

**Full-text index**:
The index of the search that holds the text of the published notes.

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
