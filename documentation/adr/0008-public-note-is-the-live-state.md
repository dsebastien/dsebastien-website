# The `public_note` property is the live state, and only the publishing tool writes it

ADR 0002 made the `public_note` property the intent of the author: a note with the property was a publication candidate. The author reversed that part. The property states that a note is live on the site, and only the publishing tool writes it, after a publication or a removal. The author selects what to publish in the view of the tool. Two guards say "never": a deny list of folders in the configuration of the tool, and an ignore property on a note. The Ghost Publish plugin of the author works the same way (excluded folders, an ignore flag, state properties).

Considered: the property as intent (ADR 0002), and two properties (one for the intent, one for the state). Rejected, because with an intent property anything that writes it (a template, a bulk edit, an agent) creates a publication candidate, and a second property adds a concept for no gain: the selection in the view is the intent.

Consequence: the rest of ADR 0002 holds (content store, manifest, review step). A note that is not live is a candidate unless a guard excludes it, so the publication queue needs filters, and new notes are never selected by default. Tools that test the property to know if a note is live, such as the Ghost Publish plugin, keep working.
