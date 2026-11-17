# Renames are tracked in the manifest and a journal, not by an id in each note

The URL of a note is its vault path, so a rename or a move must leave a redirect from the old path. That needs a stable identity for each note.

Considered: a permanent id property written into each note. Rejected, because it writes into more than 20,000 files one time (which changes their modification dates and starts a synchronization storm), and a copied note carries a duplicate id.

Chosen: the manifest holds the identity. The plugin records each rename that Obsidian reports in a journal, and the next publication turns the old path into a redirect. A rename that the plugin did not see (made while Obsidian was closed, or by a script) shows in the publication queue as "a path disappeared and a path with the same content appeared: confirm the pairing".

Consequence: the journal and the pairing step are safety-critical. They need safeguards and tests: a restart between rename and publication, a folder rename that touches many notes, a rename together with an edit, a second machine.
