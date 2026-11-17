# Business Rules

These rules MUST be respected in all implementations, unless the author approves a change.

---

## Rules

1. **Existing URLs keep working.** Every URL that works on notes.dsebastien.net, www.dsebastien.net and store.dsebastien.net before a switch works after it: same URL, or one redirect to the new URL.
2. **Only public notes are published.** A note is published only if the author marked it public (`public_note: true`) and it passes the privacy gate.
3. **Private content never leaves the vault.** No private note, private attachment, customer data or secret reaches the content store, the site or this repository. When in doubt, the pipeline does not publish.
4. **Deny list wins.** A note in a deny-listed folder or of a deny-listed type is never published, whatever its properties say.
5. **Links to private notes never lead to a page.** A target that is not published shows as plain text. A target in a deny-listed folder or of a deny-listed type never shows its title.
6. **Nothing goes live by itself.** A change in the vault reaches the site only through a publication that the author started.
7. **The author publishes from Obsidian** and can choose per note: publish, skip, unpublish.
8. **`products-light.json` is a contract.** Its URL and the fields that consumers use do not change without a check of every consumer. Adding fields is safe.
9. **Analytics continue.** Plausible stays, with the same site ids and the `cta_clicked` event shape, so that numbers stay comparable.
10. **Performance is a release criterion.** A release that breaks a performance budget does not ship.
11. **Brand.** Web-facing pages use the Knowii web palette and components. The slide palette is never used on the web.
12. **No timing in plans.**
13. **This repository is public.** See the privacy section of `AGENTS.md`.
14. **Only allowed properties are published.** Each note type has an allow list of properties. A property that is not on it never reaches any output.
15. **Personal data of other people is not published** beyond what the allow list for person notes permits.
16. **A takedown removes everything.** The page, the Markdown, the images, and every derived file, and it does not wait for a normal publication.

## Documentation Guidelines

When a new business rule is mentioned:

1. Add it to this document immediately
2. Use a concise format (single line or brief paragraph)
3. Maintain precision - do not lose important details for brevity
4. Include rationale where it adds clarity
