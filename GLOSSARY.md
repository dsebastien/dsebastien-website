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

### Publishing

**Public note**:
A note that the author marked for publication. It states an intent.
_Avoid_: published note (that is the state)

**Published note**:
A note that is live on the site.
_Avoid_: public note (that is the intent)

**Publication**:
The act, started by the author in Obsidian, that makes selected changes live.
_Avoid_: deploy, sync, upload

**Publication queue**:
The list of new, changed and removed notes that wait for a publication.

**Skip**:
To leave a change in the publication queue without publishing it. The live version stays.

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

**Deny list**:
The vault folders and note types that can never be published.

**Privacy gate**:
The set of checks that every note, property and attachment passes before it can be published.

### Site

**Canonical URL**:
The one URL under which a note is served. Every other form redirects to it.

**Resolver**:
The function that turns a requested path into a canonical URL, a redirect, or "not found".

**Ad**:
A promotion of one of the author's own products or resources on a page.
_Avoid_: CTA, banner

**Theme**:
A named set of visual values (colors, fonts, shapes). Each theme has a light and a dark mode.
_Avoid_: mode (light and dark are modes of a theme)

**Agent**:
A program that reads or uses the site for a person: crawler, AI assistant, coding agent.
_Avoid_: bot

**Switch gate**:
The conditions that must be true before the notes domain moves to the new site.
