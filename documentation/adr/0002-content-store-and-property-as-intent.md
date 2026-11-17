# A content store sits between the vault and the build, and the `public_note` property becomes the intent

Today the Obsidian Publish panel decides what is public, and the `public_note` property only mirrors that state. In the new flow the property is the intent of the author, a manifest records what is live, and a publication moves the selected differences into a content store (a private snapshot of cleaned notes). The site builds from the content store only.

Considered: building straight from the vault repository at each commit. Rejected, because every vault commit would go live, "skip" would not exist, and the build would need access to the private vault.

Consequence: anything that writes or removes the property creates a publication or removal candidate, so the publishing tool asks for confirmation on unusual mass changes.
