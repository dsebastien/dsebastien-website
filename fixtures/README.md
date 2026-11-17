# Fixtures

Test data of the repository. Everything here is invented. Nothing comes from a real vault.

- `vault/`: the fixture vault. One invented note per feature and per trap of the spec (section 18.4 of `documentation/plans/spec-v2.md`).
- `configuration.json`: the invented configuration of the publishing tool for the fixture vault, with its deny list.
- `catalog.json`: the fixture catalog. Each entry names a feature or a trap and the files that serve it.

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

`configuration.json` has one field for now, `denyList`. The ticket that writes the canonical form (issue 29) settles the shape of the configuration.
