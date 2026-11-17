# Business Rules

These rules MUST be respected in all implementations, unless the author approves a change.

---

## Rules

1. **Existing URLs keep working.** Every URL that works on notes.dsebastien.net, www.dsebastien.net and store.dsebastien.net before a switch works after it: same URL, or one redirect to the new URL.
2. **Only selected notes are published.** A note is published only when the author selected it in the publishing tool and no guard excludes it. The guards are the deny list of folders and the `publish_ignore` property. The `public_note` property records the result: the tool never reads it as an input, and it corrects it after each publication (ADR 0008).
3. **A note that is not selected stays in the vault.** A note that the author did not select, or that a guard excludes, never reaches the content store, the site or this repository. The first version runs no automatic check on the content of a selected note: it is published as it is in the vault (ADR 0011, issue 15). Customer data and secrets never enter this repository.
4. **The guards win.** A note in a deny list folder, or with the `publish_ignore` property, is never published, whatever else says so.
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
16. **A takedown removes everything.** The page, the Markdown, the images, and every derived file, and it does not wait for a normal publication.

## Documentation Guidelines

When a new business rule is mentioned:

1. Add it to this document immediately
2. Use a concise format (single line or brief paragraph)
3. Maintain precision - do not lose important details for brevity
4. Include rationale where it adds clarity
