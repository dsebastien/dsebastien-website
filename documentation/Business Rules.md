# Business Rules

These rules MUST be respected in all implementations, unless the author approves a change.

---

## Rules

1. **Existing URLs keep working.** Every URL that works on notes.dsebastien.net, www.dsebastien.net and store.dsebastien.net before a switch works after it: same URL, or one redirect to the new URL. One written exception (decision of the author R87): a path with a bare percent sign (a `%` that two hex digits do not follow) gets 400 from the edge of the host before the site runs. A few old URLs of the redirect list have this form; the new links of those notes encode the sign as `%25` and work.
2. **Only selected notes are published.** A note is published only when the author selected it in the publishing tool and no guard excludes it. The guards are the deny list of folders and the `publish_ignore` property. The `public_note` property records the result: the tool never reads it as an input, and it corrects it after each publication (ADR 0008).
3. **A note that is not selected stays in the vault.** A note that the author did not select, or that a guard excludes, never reaches the content store, the site or this repository. The first version runs no automatic check on the content of a selected note: it is published as it is in the vault (ADR 0011, issue 15). Customer data and secrets never enter this repository.
4. **The guards win.** A note in a deny list folder, or with the `publish_ignore` property, is never published, whatever else says so. A published or unpublished note that comes under a guard leaves the content store with its manifest entry at the next publication, whatever is selected (forced removal; unpublished notes by decision of the author R64). When that removal fails, nothing is published.
5. **Links to notes that are not published never lead to a page.** The target shows as plain text.
6. **Nothing goes live by itself.** A change in the vault reaches the site only through a publication that the author started.
7. **The author publishes from Obsidian** and can choose per note: publish, skip, unpublish.
8. **`products-light.json` is a contract.** Its URL and the fields that consumers use do not change without a check of every consumer. Adding fields is safe.
9. **Analytics continue.** Plausible stays, with the same site ids and the `cta_clicked` event shape, so that numbers stay comparable.
10. **Performance is a release criterion.** A release that breaks a performance budget does not ship.
11. **Brand.** Web-facing pages use the Knowii web palette and components. The slide palette is never used on the web.
12. **No timing in plans.**
13. **This repository is public.** See the privacy section of `AGENTS.md`.
14. **Properties.** Until an allow list per property key exists, every property of a published note is public. When an allow list exists, a property that is not on it never reaches any output.
15. **Personal data of other people.** The properties of person notes are public for now, by decision of the author. The rule is reviewed when the allow list of rule 14 exists.
16. **A takedown removes everything.** The page, the Markdown, the images, and every derived file, and it does not wait for a normal publication. Its images leave the object storage of the host at once, also when the deployment fails, and so do the images of a forced removal (R78). A removal never blocks a build: a check of the built site that a takedown or an unpublish can fail by itself gives a warning, not a stop (R65).
17. **Two implementations, one result.** For the same input, the TypeScript and the Rust implementation of the publishing logic write the same bytes in the canonical form (`Canonical Form.md`): the publication plan, the cleaned notes and the manifest, and the files that an edit of the guards writes (`edits.json`, `configuration.json`, the ignore property of a note). A change lands in both in the same commit. A parity test that fails blocks a release (ADR 0009).
18. **The raw Markdown shows what the page shows.** The raw Markdown of a note (`/-/md/<path>.md`) is its cleaned note. Every filter of the page of a note (an allow list of properties, a content check, a hidden title) filters its raw Markdown in the same way, in the same step (decision of the author, R47).
19. **A removal of a page is a choice of the author.** A published page whose note is missing from the vault, or that the author unpublishes, is listed apart with its path and is never selected by default: a publication removes it only when the author (or the request that names it) selects it, and its report says so. Takedowns (rule 16) and the guards (rule 4, R45, R69, R78) keep their rules. An attachment that no published note uses any more leaves the site by itself at the next publication (R88, issue 132).
20. **The main site is the original.** A note of a type that the main site also publishes (articles, newsletters, news posts) names its post there in its canonical link only when the tool verified the post at its last publication: the post answers 200 and names itself. Without a verified post the note is `noindex`, and the publication report lists it. Either way it stays served under its own path, in the feeds and in `llms.txt`, and leaves the sitemaps and IndexNow. A failed check never blocks a publication (ADR 0010, R90).

## Documentation Guidelines

When a new business rule is mentioned:

1. Add it to this document immediately
2. Use a concise format (single line or brief paragraph)
3. Maintain precision - do not lose important details for brevity
4. Include rationale where it adds clarity
