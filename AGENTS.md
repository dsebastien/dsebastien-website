## Project overview

One codebase for dsebastien.net: the public notes (digital garden), the blog and the store. Static sites built with Astro, TypeScript and Tailwind from an Obsidian vault. The vault is private and is the only source of content.

- Current plan: `documentation/plans/spec-v1.md` (draft, not approved).
- Ideas that are not part of the plan: `documentation/plans/ideas-backlog.md`.
- Measured facts about the existing sites: `documentation/research/`.
- No application code exists yet. Do not scaffold apps or packages before the spec is approved.

## Privacy: this repository is public

**CRITICAL**. The vault is private. This repository is public.

- Never commit note content, attachments, customer data, secrets, tokens, internal host names, IP addresses or infrastructure details.
- Exported content goes to `.content/` (ignored by git) or to the content store. Never into the repository.
- Test data comes from the fixture vault, which holds invented notes only. Fake secrets for tests are built at run time, never stored as text.
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
- `bun run lint` passes with zero warnings (once ESLint is set up).
- `bun run test` passes. New logic has `.spec.ts` coverage next to the file it tests.
- `bun run format:check` passes.
- The build completes (once a build exists).
- The file of the day in `documentation/history/` says what was done, which decisions were made, and what is open.
- The plan that drove the work is updated or closed.
- `documentation/` matches the code.

State in the final message what could not be verified (for example: a visual check in a browser, a check on the live host).

### Commit conventions

- Conventional Commits: `type(scope): subject`.
- One logical change per commit.
- Never bypass commit hooks.

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

### Development workflow

Before code changes, start the type check in watch mode in the background:

```bash
bun run tsc:watch
```

After code changes:

```bash
bun run format
bun run test
```

## Testing

- Run tests with `bun run test`, never bare `bun test`. The script adds `--isolate`.
- Test files end in `.spec.ts` and sit next to the file they test.
- Test external behavior through the interface of a module. Do not test internals.
- Privacy gate, URL contract and the `products-light.json` shape have tests that block a release.

## Design principles

- Static first: HTML at build time. JavaScript only where a feature needs it, loaded when used.
- Deep modules: a lot of behavior behind a small interface. Few seams.
- Fail closed: when the pipeline is not sure that something is public, it does not publish it. Allow lists, never hide lists.
- One cleaned artifact per note. Every output derives from it. Nothing reads the vault after the publication step.
- Performance is a release criterion. Budgets are checked in CI.
- Brand: the Knowii web palette and components. The canonical values are in the research file.

## Tooling status

Set up: TypeScript, Prettier, Bun test, EditorConfig.

Not set up yet (planned with the first code): ESLint with `--max-warnings 0`, commitlint and commit hooks, CI workflow, Astro, Tailwind.
