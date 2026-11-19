## Project overview

The website of the author's public notes (notes.dsebastien.net, a digital garden with more than 20,000 notes), and the tool that publishes notes to it from Obsidian. A static site built with Astro, TypeScript and Tailwind from an Obsidian vault. It replaces Obsidian Publish. The vault is private and is the only source of content.

The main site and the store of the author are out of scope (ADR 0001).

- Current plan: `documentation/plans/spec-v2.md` (approved by the author on 2026-11-17; it is adjusted as the build and the tests teach us), read together with `documentation/plans/decisions.md` (the answers of the author) and the decision records in `documentation/adr/`. `documentation/plans/spec-v1.md` is the older draft that it replaces.
- Ideas that are not part of the plan: `documentation/plans/ideas-backlog.md`.
- Measured facts about the existing sites: `documentation/research/`.
- The spec is approved. The work is cut into tickets: GitHub issues with the labels `setup`, `prototype` and `slice`. The tooling exists (issue 16). A prototype lives on a `prototype/<name>` branch, every other ticket on a `ticket/<number>-<name>` branch.

## Privacy: this repository is public

**CRITICAL**. The vault is private. This repository is public.

- Never commit note content, attachments, customer data, secrets, tokens, internal host names, IP addresses or infrastructure details.
- Exported content goes to `.content/` (ignored by git) or to the content store. Never into the repository.
- Analytics exports, vault analysis and raw reports go to `.private/` (ignored by git). Never into the repository. That folder is a clone of a private repository of the author, so that it exists on each of his machines.
- Test data comes from the fixture vault (`fixtures/vault/`), which holds invented notes only. Fake secrets for tests are built at run time, never stored as text.
- A check refuses a private file (`scripts/private-files.ts`): a file of `.private/`, `.content/` or `.cache/`, a vault file outside the fixture vault (a Markdown file with properties, `.obsidian/`, a canvas, a base), a file of the fixture vault that its catalog does not declare, and a symbolic link. It runs before a commit, before a push and in the tests. It cannot see the real vault: a note without properties and an attachment pass it outside the fixture vault. It does not replace care.
- Raw review reports and raw exports from the vault never go into the repository.
- Business numbers that are not public (members, revenue, customers) do not belong in documents here.
- When unsure whether something is public, leave it out and ask.

## Documentation surfaces

Do not mix them:

- `README.md`: GitHub landing page. What this is and how to run it.
- `GLOSSARY.md`: the domain language. Terms only, no implementation details. Created when the first term is settled.
- `documentation/`: technical documentation for the author and for coding agents.
    - `Architecture.md`, `Business Rules.md`, `Configuration.md`, `Domain Model.md`
    - `Canonical Form.md`: the exact bytes that the two implementations of the publishing logic must both write
    - `adr/`: architecture decision records, `0001-slug.md`, one short paragraph each
    - `plans/`: specs and plans
    - `research/`: dated, cited fact files
    - `history/`: one file per day, `yyyy-mm-dd.md`

## Agent workflow

### Session-start checklist

Read these in order before any change:

1. `documentation/Business Rules.md`: mandatory invariants.
2. The most recent `documentation/history/yyyy-mm-dd.md`: what was done last and open blockers.
3. Active plans under `documentation/plans/`.
4. `GLOSSARY.md` and `documentation/adr/`, when they exist. Use the glossary terms in code, tickets and documents.

### Working method

The project follows the skill flow of Matt Pocock (https://github.com/mattpocock/skills, enabled in `.claude/settings.json`):

1. `/grill-with-docs`: interview in rounds. Terms go to `GLOSSARY.md`, hard-to-reverse decisions with real trade-offs go to `documentation/adr/`.
2. `/prototype`: when a question needs running code. A prototype lives on a `prototype/<name>` branch.
3. `/to-spec`: the settled decisions become a spec.
4. `/to-tickets`: tracer-bullet tickets (vertical slices), each with its blocking edges.
5. `/implement` per ticket, in a fresh context, with `/tdd` and `/code-review`.
6. `/retro` after a build session: improve this file, the checks and the standards.

Configuration for those skills:

- Issue tracker: GitHub issues on this repository. Blocking edges use native issue links.
- Documents: `documentation/` (ADRs in `documentation/adr/`, not `docs/adr/`).
- Glossary: `GLOSSARY.md` at the repository root.

### Definition of done

A change is done only when all of these hold:

- `bun run tsc` passes with zero errors.
- `bun run check` passes with zero errors and zero warnings (the Astro check of the site).
- `bun run lint` passes with zero warnings.
- `bun run test` passes. New logic has `.spec.ts` coverage next to the file it tests.
- `bun run format:check` passes.
- `bun run build` completes.
- When Rust code changed: `bun run rust:format:check`, `bun run rust:lint` and `bun run rust:test` pass.
- The CI workflow passes on the branch. For the first milestone (decision R43), a ticket is merged when every other point passes on the machine, with no wait for CI. When CI fails after the merge, correct it before the next ticket.
- The file of the day in `documentation/history/` says what was done, which decisions were made, and what is open.
- The plan that drove the work is updated or closed.
- `documentation/` matches the code.

State in the final message what could not be verified (for example: a visual check in a browser, a check on the live host).

### Commit conventions

- Conventional Commits: `type(scope): subject`. The scopes are in `commitlint.config.ts`: `all`, `build`, `ci`, `cli`, `deps`, `docs`, `plugin`, `release`, `site`.
- One logical change per commit.
- Never bypass commit hooks. They are activated one time per clone with `bun run setup` (Git 2.54 or later): a hook refuses a private file before a commit and before a push, a hook formats the staged files, and a hook refuses a message that breaks the convention.

### Documentation rules

- **NO TIMING IN PLANS**. Plans never hold durations, dates of delivery or effort estimates. They say what must be done and in which order.
- Plans go to `documentation/plans/`. Keep them actionable.
- Clarity over grammar. Short and exact is better than long and polished.
- Update the documentation with the change, in the same commit.

### Two implementations, one result

The publishing logic exists in TypeScript (`apps/plugin/src/publishing/`) and in Rust (`cli/src/`), under the parity rule (ADR 0009, business rule 17).

- A change of the publishing logic lands in both implementations in the same commit, with a test on each side and a parity test when the output changes.
- `documentation/Canonical Form.md` says what both must write. Change it first, then the code.
- The logic takes the time of the run as an input, reads no clock, uses no random value, and never depends on the system (path separator, locale, order of a folder listing).
- The TypeScript logic never imports `obsidian`. The plugin gives it what it needs. A lint rule refuses the import.
- A list that the parity rule compares is sorted with `compareCodePoints` (TypeScript) and as `String` (Rust), never with the default `sort()`, never with `<` on two texts, and never as `PathBuf`.

### Business rules compliance

**CRITICAL**: the rules in `documentation/Business Rules.md` are always respected, unless the author approves a change.

- A new business rule is written into that file at once, in one line or one short paragraph.
- A change or bypass needs explicit approval.

## TypeScript

`tsconfig.json` is at maximum strictness. Keep it that way.

- No `any`. Use `unknown` and narrow.
- No `@ts-ignore` and no `@ts-expect-error` without a comment that says why.
- No non-null assertion (`!`) where a check is possible.
- Index access returns `T | undefined` (`noUncheckedIndexedAccess`). Handle it.
- Optional properties are exact (`exactOptionalPropertyTypes`). Do not assign `undefined` to them.
- Type-only imports use `import type` (`verbatimModuleSyntax`).
- Validate external data (frontmatter, JSON files, API answers) at the boundary with a schema. Inside the boundary, trust the types.
- Never weaken a compiler option to make an error go away.

## Environment and tooling

- Runtime and package manager: Bun. Use `bun install`, `bun run <script>`, `bunx`.
- Node version for tools with a `node` shebang: see `.nvmrc`.
- Package versions are exact, and new versions wait 3 days before install (`bunfig.toml`).
- Rust: the toolchain that `rust-toolchain.toml` pins, with `rustfmt` and `clippy`. `rustup` installs it at the first `cargo` command. Raise the version in a commit of its own.
- A container for local work: `docker compose up` runs the dev server of the site with the source mounted. It is not an image for production, and the publishing tool never runs in it. The image gets no file of the clone (`.dockerignore` excludes everything). Keep it that way.

### Layout of the repository

- `apps/site/`: the Astro and Tailwind site. A Bun workspace with its own `package.json` and `tsconfig.json`.
    - `apps/site/src/content-store.ts`: how the build reads the content store. The build never reads the vault.
    - `apps/site/src/note-links.ts`: the links between notes on a page. A plugin of the Markdown processor of Astro (Sätteri, `markdown.processor` in `astro.config.ts`) marks each link when a note is rendered. The page gives each mark its state at each build: a link when the target is published, plain text when it is not. Astro keeps the markup of a note between two builds, so nothing that depends on another note goes into that markup. Astro does not see a change of the plugin code either: raise `MARKUP_VERSION` in that file with every change of what the plugin writes, or the old markup of every note stays. That holds also for a change of `wikilinksOf` and of `linkPathOfDestination` in `apps/plugin/src/publishing/links.ts`, which the plugin calls. The Markdown processor reads the text first, so a wikilink with Markdown syntax inside its brackets stays text until the rendering slice (issue 45).
    - `apps/site/server/`: the plain local server that serves the built site through the resolver, and the attachments from a folder of the attachment storage.
- `apps/plugin/`: the Obsidian plugin of the publishing tool, from the plugin template of the author. A Bun workspace. Its type check is the one of the root.
    - `apps/plugin/src/publishing/`: the TypeScript implementation of the publishing logic. It never imports Obsidian.
    - `apps/plugin/src/app/`: the plugin itself, a thin layer over the publishing logic.
- `cli/`: the Rust command line program of the publishing tool, a member of the Cargo workspace at the root (`Cargo.toml`). It holds the Rust implementation of the publishing logic.
- `parity/`: the parity tests. They run both implementations and compare their output byte by byte.
- `packages/`: TypeScript code that more than one app uses. Each package is a Bun workspace.
    - `packages/testing/`: test support for TypeScript. The paths of the fixture vault, `makeTestStores()` (a content store and an attachment storage), and for a test of a publication `copyFixtureVault()`, `makeContentStoreCopy()` and `refusePushes()` (a content store that refuses every push: `plan` and `publish` fetch first, so a push of another device before the run stops it before its push), and `crashingStore()` (a copy of the content store whose commit and push never return: the run halts there with its lock and its journal, as after a power cut).
    - `packages/resolver/`: the URL function, the hashed path of an attachment and the resolver, in plain TypeScript. The build, the plain server and later the edge use them. No other code writes or reads a URL of a note.
- `fixtures/`: the test data, invented. It is at the root because no implementation owns it: the TypeScript tests and the Rust tests read the same files.
    - `fixtures/vault/`: the fixture vault.
    - `fixtures/configuration.json`: the invented configuration of the publishing tool, with its deny list.
    - `fixtures/catalog.json`: the fixture catalog. It says which feature or trap each file of the fixture vault serves.
    - `fixtures/canonical/`: the shared cases of the canonical form. The TypeScript and the Rust tests both read them: `cases.json` (data), `properties.json` (the properties of a note), `links.json` (the links of a note), `images.json` (the size of an image), `names.json` (the root names of the site), `queue.json` (scenarios of the publication queue).
    - `fixtures/README.md`: the rules, and how to add a note.
- `cli/tests/support/mod.rs`: test support for Rust, the twin of `packages/testing`.
- `scripts/`: tooling of the repository and its guard tests.

Run every script from the root. The root scripts call the workspaces.

### Development workflow

Before code changes, start the type check in watch mode in the background:

```bash
bun run tsc:watch
```

After code changes:

```bash
bun run format
bun run lint
bun run check
bun run test
```

After changes of Rust code:

```bash
bun run rust:format
bun run rust:lint
bun run rust:test
```

## Testing

- Run tests with `bun run test`, never bare `bun test`. The script adds `--isolate`.
- Test files end in `.spec.ts` and sit next to the file they test.
- Test external behavior through the interface of a module. Do not test internals.
- The tooling has guard tests in `scripts/`: the strict compiler options, the lint script, the commit hooks, the CI workflow, the container files and the check of private files. The build of the site has a test next to its source.
- Test data comes from the fixture vault. Read it through `packages/testing` (TypeScript) or `cli/tests/support/mod.rs` (Rust), never with a path of your own. To add a note, follow `fixtures/README.md`: every file is invented and declared in the fixture catalog.
- Never write into the fixture vault from a test. A test that changes notes works on a copy.
- A test that needs a content store or an attachment storage takes them from the test helper: `await using stores = await makeTestStores()` in TypeScript, `TestStores::new()` in Rust. The content store is a bare git repository with no commit, which stands for the remote one. The attachment storage is an empty folder. Both are removed after the test.
- A test that needs a folder of its own makes it inside the ignored `.cache/` folder of the clone, and removes only a folder that it made.
- Data of full size is never committed. `bun run corpus` writes an invented vault of the size of the public notes into `.cache/corpus/`. The same seed gives the same bytes. Use it for prototypes and for budget tests, not for correctness tests: those use the fixture vault.
- On a machine of the author, `bun run corpus:published` copies the notes that are published today from his vault into `.cache/published/`. That folder holds real notes: never copy a file of it into the repository, into an issue or into a test. The public CI never has it.
- Rust tests run with `bun run rust:test`. Tests of the command line program go through the program itself (`cli/tests/`). One exception: the shared cases of the canonical form are a unit test next to the Rust writer.
- The parity tests in `parity/` build the Rust program with cargo, so `bun run test` needs the Rust toolchain.
- A test of a publication works on a copy of the fixture vault and on a copy of the content store, both inside the folder of the test. The expected texts of the two implementations are the same, with hashes that were computed with another tool.
- A rule of link resolution gets a case in `fixtures/canonical/links.json` before the second implementation is written. Both test suites read every case (`apps/plugin/src/publishing/links.spec.ts`, `cli/src/links.rs`). The build reads a link with the functions of the TypeScript logic, on the text that the Markdown processor gives it.
- A rule of the size of an image gets a case in `fixtures/canonical/images.json` before the second implementation is written (`apps/plugin/src/publishing/images.spec.ts`, `cli/src/images.rs`).
- A rule of the publication queue gets a step in a scenario of `fixtures/canonical/queue.json` before the second implementation is written. Both test suites run every scenario (`apps/plugin/src/publishing/queue.spec.ts`, `cli/tests/queue.rs`). A scenario has its own small invented vault, so a new note of the fixture vault changes no scenario.
- The test of the note page publishes a note with the tool, builds the site of that content store and asks the local server: it covers the whole path.
- A run that stops halfway (issue 36): in TypeScript, `crashingStore()` of `packages/testing`; in Rust, the switch `DSEBASTIEN_VAULT_PUBLISH_TEST_CRASH=write|commit|push` of the debug build of the program (`crash_point` in `cli/src/device.rs`). The release build has no switch. The lock, the run journal and the plans of a device are in `.git/vault-publish/` of the copy of the content store.
- The guards (deny list, `publish_ignore`), the parity of the two implementations, the URL contract and the `products-light.json` shape have tests that block a release.

## Design principles

- Static first: HTML at build time. JavaScript only where a feature needs it, loaded when used.
- Deep modules: a lot of behavior behind a small interface. Few seams.
- The author selects, the guards exclude: nothing is published that the author did not select, and a deny list folder or the `publish_ignore` property always wins. The first version runs no content check on a selected note (ADR 0011).
- One cleaned artifact per note. Every output derives from it. Nothing reads the vault after the publication step.
- Performance is a release criterion. Budgets are checked in CI.
- Brand: the Knowii web palette and components. The canonical values are in the research file.

## Styling with Tailwind

The rules of the author for Tailwind, taken from his other repositories. They apply to the site and to the mockups (DES-12 of the spec).

- Tailwind CSS 4, the latest stable version. The configuration is in CSS (`@theme`). There is no JavaScript configuration file.
- Always use Tailwind. Prefer its utilities to custom CSS. Write raw CSS only for what Tailwind cannot express cleanly (`color-mix()`, `clamp()`, a gradient on a pseudo-element).
- Utilities in the markup: for layout that one element needs, and for simple combinations that need no class.
- `@apply` in a CSS file: for a component class that more than one element uses, for pseudo-selectors (`:hover`, `::after`), and where utilities are combined with token variables. Component classes live in `apps/site/src/styles/components.css`, apart from the tokens.
- Tokens: every color, font, radius, shadow and motion value is a token, defined with `@theme`. A theme defines token values only, and components compose tokens. A change of theme or of mode changes the look with no change to a component. The token names are the same in every theme.
- Colors: the default Tailwind palette is switched off. Never write a raw hex value or a color of the Tailwind palette in the markup or in a component class. Never write `white` or `black` directly: use the token for the text, the fill or the overlay.
- Token names follow the store website and the Knowii app where they exist: `background`, `surface`, `surface-elevated`, `well`, `primary` (text), `muted`, `secondary` (magenta), `secondary-text`, `border`, `border-strong`, `overlay`, `success`, `warning`, `danger`.
- `secondary-text` fails WCAG AA for normal text on the dark background. Use it for large or decorative text only.
- Modes: dark is the default and light is the second. Check every page in both.
- Responsive: every page works on a small, a medium and a wide screen, with the Tailwind breakpoints. Content is never cut and never needs a horizontal scroll.
- Known traps:
    - Tailwind 4 refuses a nested `@import url(...)` after its own import.
    - Do not put two padding shorthands on one element through two classes: the later one removes the earlier one. Use `padding-block` and `padding-inline`.
    - The `!` modifier does not always give `!important` in a minified build. Write the declaration in CSS when it matters.

## Tooling status

Set up: TypeScript, Prettier, Bun test, EditorConfig, ESLint with `--max-warnings 0`, commitlint and commit hooks, the CI workflow, Astro with its check, Tailwind, the Cargo workspace with `rustfmt` and `clippy`, the container for local work (`Dockerfile`, `compose.yaml`), the fixture vault with its catalog, the test helpers for a content store and an attachment storage, the check of private files.

The publishing logic works for the publication queue, the guards and the links (issues 31, 33 and 34): the two implementations give the four lists (`status`), make a plan with paths to include, to hold and to remove (`plan`), and publish new notes, updates and removals into a content store with a report (`publish`), under the canonical form and the parity tests. Every plan removes a published note that came under a guard (forced removal). The failure cases (issue 36): one publication at a time per device (the lock, and `unlock`), a run that stops halfway is put back by the next `plan` or `publish` (the run journal), a plan without a network uses the last fetch, a note that is missing from this vault is listed apart, and each publication uploads again a file that the attachment storage lost. The manifest entry of a note says to which note each of its links leads. The site builds one page per published note, with a link to each published target and plain text for every other target, and a plain local server serves it through the resolver. The resolver and the URL variants (issue 43): every form of a URL of today (another letter case or Unicode form, `%20` or `%2B`, a slash at the end, a `.md` suffix, the file name alone, an alias) reaches its note in one redirect, a folder leads to its folder note or shows a list, and the shared table `fixtures/urls.json` runs on the resolver and over HTTP. The tool reads the aliases of a note and stops a plan that would give a note a reserved root name. The plugin itself still does nothing: its view comes later.

Not set up yet: the deployment, the performance budgets in CI, the lint rules of the Obsidian plugin catalog (the plugin is a tool for the author first).
