# Fixtures

Test data of the repository. Everything here is invented. Nothing comes from a real vault.

- `vault/`: the fixture vault. One invented note per feature and per trap of the spec (section 18.4 of `documentation/plans/spec-v2.md`).
- `configuration.json`: the invented configuration of the publishing tool for the fixture vault, with its deny list.
- `catalog.json`: the fixture catalog. Each entry names a feature or a trap and the files that serve it.
- `canonical/cases.json`: the shared cases of the canonical form (`documentation/Canonical Form.md`). Both implementations of the publishing logic read them.
- `canonical/properties.json`: the shared cases of the rules for the properties of a note, the aliases included.
- `canonical/names.json`: the shared cases of the root names of the site: which names are reserved, and which two texts are one URL.
- `canonical/links.json`: the shared cases of the links of a note: the link paths of a text, the target of a link path in a list of notes, and the list that a manifest entry holds.
- `markdown-forms.json`: the forms of Obsidian Markdown of issue 12 (issue 26). Each form names an invented note of `vault/` and checks on the HTML that a conversion gives for that note alone. `packages/testing` reads it (`readMarkdownForms`, `checkHtml`). The notes are in `vault/50 Field guide/`, beside older notes that already held a form.
- `canonical/note-types.json`: the shared cases of the note type of a note: answers of the Starter Kit that must be read or refused, and the `noteType` of a manifest entry.
- `store-catalog.json`: a recorded store catalog (`products-light.json`) with invented products, in the shape of the store: the input of the catalog shape test (TEST-04) and of the ads of the fixture site (issue 56). `FIXTURE_STORE_CATALOG` of `packages/testing` names it.
- `note-types.json`: the answers of an invented Obsidian Starter Kit for the fixture vault (decision R61): the types and the type of each note. A new note of the fixture vault gets its type here; a note that is not named has no type.
- `canonical/mcp.json`: the shared cases of the MCP server of the publishing tool: one message of the client, the call that the server makes and the answer that it gives. Both faces read them, with a stand-in for the operations.
- `canonical/deploy.json`: the shared cases of the deploy after a push (issue 32): the command that the tool runs from the settings of a device, and the deploy report that it reads from the result line of the deploy. Both faces read them.
- `canonical/originals.json`: the shared cases of the original of a note on the main site (issue 55): the comparison form of a URL, the post URL of a note, the canonical links of a page, the key `original` of a manifest entry, and the judgment of an answer of the main site.
- `canonical/configuration.json`: the shared cases of `configuration.json` of the content store (R103): the texts that both implementations read, with the deny list that they give, and the texts that they refuse, with the message.
- `canonical/queue.json`: the shared scenarios of the publication queue. Each scenario has its own small invented vault, written inside the file, so that a new note of the fixture vault changes no scenario.

## Rules

1. Invent every note, every name and every person. Never copy a note, a folder name or a file from a real vault.
2. Declare every file of `vault/` in `catalog.json`. The check of private files refuses a file that the catalog does not declare (`scripts/private-files.ts`).
3. Never write into `vault/` from a test. A test that changes notes copies the vault into the folder that the test helper made, and works there.
4. Do not use a file name that Windows refuses (`?`, `*`, `:`, `"`, `<`, `>`, `|`, a dot or a space at the end). The Rust checks run on Windows.
5. Do not add two paths that are equal when letter case is ignored.

A test checks rules 2, 4 and 5 (`packages/testing/src/fixture-vault.spec.ts`). 6. Prettier does not format `vault/`. A note stays as it is written, byte for byte.

## Add a note

1. Write the note in `vault/`, with the smallest text that shows the feature or the trap.
2. Add its path to an entry of `catalog.json`, or add an entry. When a property name or a value is not settled yet, say so in the `open` field.
3. Add a check for a new entry to `packages/testing/src/fixture-vault.spec.ts`. An entry without a check fails the tests.
4. When the folder must never be published, add it to the deny list in `configuration.json`.

## Read the fixtures in a test

- TypeScript: `FIXTURE_VAULT`, `FIXTURE_CONFIGURATION` and `makeTestStores()` of `packages/testing`.
- Rust: `fixture_vault()`, `fixture_configuration()` and `TestStores` of `cli/tests/support/mod.rs`.

`configuration.json` has one field for now, `denyList`. The first slice that reads the configuration settles its shape.

- `urls.json`: the URL table (issue 43): invented notes, an invented redirect list (`redirects`, issue 44) and the cases that the resolver, the plain server, the Worker and `bun run urls check` all run.
