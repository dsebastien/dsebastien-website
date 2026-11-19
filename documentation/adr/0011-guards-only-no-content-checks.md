# The first version has two guards and no content check

The earlier plans had a privacy gate: automatic checks on each note before a publication (text that looks like a secret or like personal data, titles of private notes in links, private rows in frozen lists, comments, attachment metadata), with a blocked state and allow marks. The author decided that these checks are not important now. The first version of the publishing tool has two guards only: the deny list of folders and the `publish_ignore` property. A note that the author selects, and that no guard excludes, is published as it is in the vault, as Obsidian Publish does today.

Considered: the full gate of spec v2, and a silent cleaning step that removes comments and hides the titles of notes in deny list folders. Rejected for now: the author selects every note himself, a measurement found no secret in the public notes, and the checks add work, noise and time to the part of a publication that must be fast.

Consequence: what is public today in the same way stays public (titles of notes that are not published as plain link text, comments in the raw Markdown, metadata in images). The checks are kept as an idea in issue 15. The business rules 2 to 5 and 15 are rewritten.

Added on 2026-11-19 (issue 43, R47): the raw Markdown of a note (`/-/md/<path>.md`) is its cleaned note, so it shows every property and every link path as the author wrote it, also the path of a note under a guard behind a link label. The author keeps it so. When a later step filters the page of a note (an allow list of properties, a check of issue 15), it filters the raw Markdown in the same way (business rule 18).
