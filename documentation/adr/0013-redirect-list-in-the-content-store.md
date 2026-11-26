# The redirect list lives in the content store, and only the build reads it

The current site has old addresses that no rule of the resolver finds: former paths from before the first publication, names cut at a dot, old documentation folders, and old generated notes. Their rows name paths and titles of notes, some of them not published, so they cannot be in this public repository.

Considered: a private file that the deployment passes to the build. Rejected, because a second device would need a copy of its own, and the release record would not say which list a release used. Considered: rows that the publishing tool writes. Rejected for the first version: both implementations would need the rule, and the author decides the rows outside of a publication.

Chosen (decision of the author on 2026-11-26, R79, issue 44): the content store holds `redirects.json`. The author writes it (a private script builds it from the reports, the 404 data and the rename history of the vault), and commits it in the content store. The build reads it from the copy that the deployment checks, so the content revision of the release record names the list too. The publishing tool never reads or writes it. A row that a live address has, or whose target is not live, is dropped with a count in the warning of the build, never with its path.

Consequence: a change of the list goes live at the next deployment. The public CI has no list. The resolver map holds the old paths of the redirects as texts (they were public URLs, and the map is no address of the site) and the gone rows as keys.
