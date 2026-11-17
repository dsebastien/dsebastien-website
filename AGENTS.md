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
- A check refuses a private file (`scripts/private-files.ts`): a file of `.private/`, `.content/` or `.cache/`, a vault file outside the fixture vault (a Markdown file with properties, `.obsidian/`, a canvas, a base), and a file of the fixture vault that its catalog does not declare. It runs as a pre-commit hook and in the tests. It cannot see the real vault: it does not replace care.
- Raw review reports and raw exports from the vault never go into the repository.
- Business numbers that are not public (members, revenue, customers) do not belong in documents here.
- When unsure whether something is public, leave it out and ask.

## Documentation surfaces

Do not mix them:

- `README.md`: GitHub landing page. What this is and how to run it.
- `GLOSSARY.md`: the domain language. Terms only, no implementation details. Created when the first term is settled.
- `documentation/`: technical documentation for the author and for coding agents.
    - `Architecture.md`, `Business Rules.md`, `Configuration.md`, `Domain Model.md`
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
- The CI workflow passes on the branch.
- The file of the day in `documentation/history/` says what was done, which decisions were made, and what is open.
- The plan that drove the work is updated or closed.
- `documentation/` matches the code.

State in the final message what could not be verified (for example: a visual check in a browser, a check on the live host).

### Commit conventions

- Conventional Commits: `type(scope): subject`. The scopes are in `commitlint.config.ts`: `all`, `build`, `ci`, `cli`, `deps`, `docs`, `plugin`, `release`, `site`.
- One logical change per commit.
- Never bypass commit hooks. They are activated one time per clone with `bun run setup` (Git 2.54 or later): a hook refuses a private file, a hook formats the staged files, and a hook refuses a message that breaks the convention.

### Documentation rules

- **NO TIMING IN PLANS**. Plans never hold durations, dates of delivery or effort estimates. They say what must be done and in which order.
- Plans go to `documentation/plans/`. Keep them actionable.
- Clarity over grammar. Short and exact is better than long and polished.
- Update the documentation with the change, in the same commit.

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
- Rust: the stable toolchain, with `rustfmt` and `clippy`.
- A container for local work: `docker compose up` runs the dev server of the site with the source mounted. It is not an image for production, and the publishing tool never runs in it. The image gets no file of the clone (`.dockerignore` excludes everything). Keep it that way.

### Layout of the repository

- `apps/site/`: the Astro and Tailwind site. A Bun workspace with its own `package.json` and `tsconfig.json`.
- `cli/`: the Rust command line program of the publishing tool, a member of the Cargo workspace at the root (`Cargo.toml`).
- `packages/`: TypeScript code that more than one app uses. Each package is a Bun workspace.
    - `packages/testing/`: test support for TypeScript. The paths of the fixture vault, and `makeTestStores()`.
- `fixtures/`: the test data, invented. It is at the root because no implementation owns it: the TypeScript tests and the Rust tests read the same files.
    - `fixtures/vault/`: the fixture vault.
    - `fixtures/configuration.json`: the invented configuration of the publishing tool, with its deny list.
    - `fixtures/catalog.json`: the fixture catalog. It says which feature or trap each file of the fixture vault serves.
    - `fixtures/README.md`: the rules, and how to add a note.
- `cli/tests/support/mod.rs`: test support for Rust, the twin of `packages/testing`.
- `scripts/`: tooling of the repository and its guard tests.
- The home of the Obsidian plugin is set by the ticket that creates it.

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
- Rust tests run with `bun run rust:test`. Tests of the command line program go through the program itself (`cli/tests/`).
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
- `@apply` in a CSS file: for a component class that more than one element uses, for pseudo-selectors (`:hover`, `::after`), and where utilities are combined with token variables. Component classes live in `apps/site/src/styles/components.css`, apart from the tokens. The file is created with the first component class.
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

Set up: TypeScript, Prettier, Bun test, EditorConfig, ESLint with `--max-warnings 0`, commitlint and commit hooks, the CI workflow, Astro with its check, Tailwind, the Cargo workspace with `rustfmt` and `clippy`, the container for local work (`Dockerfile`, `compose.yaml`).

Not set up yet: the Obsidian plugin, the deployment, the performance budgets in CI.
