# Configuration

## TypeScript

`tsconfig.json` at the repository root. Maximum strictness, from the Obsidian plugin template of the author, plus `exactOptionalPropertyTypes`, `useUnknownInCatchVariables`, `noUncheckedSideEffectImports` and `forceConsistentCasingInFileNames`.

- `types` is pinned to `bun` and `node`, so that a missing type package is a hard error.
- `allowJs` is off: JavaScript files cannot skip the type check.
- `lib` includes `DOM` for now. Packages that run only on a server get their own configuration without it.
- `jsx` is not set. It is added with the first package that needs it.
- Packages and apps extend this file. An Astro app also extends the strictest Astro preset.
- The root project holds `scripts/`, `packages/` and the configuration files. Each app has its own `tsconfig.json` and is not part of the root project: `bun run tsc` checks the root project, and `bun run check` runs `astro check` on the site, where a warning fails the run.
- In `apps/site/tsconfig.json` the root configuration comes after the Astro preset, so that the strictness of the root wins (`allowJs` stays off).

## Workspaces

The root `package.json` declares the Bun workspaces `apps/*` and `packages/*`. `apps/site` is the Astro site. `packages/testing` is the test support (`@dsebastien-website/testing`): it has no build step, and its entry is its TypeScript source. The root `Cargo.toml` declares the Cargo workspace, with `cli` as its only member.

## Lint

ESLint (`eslint.config.ts`): the recommended rules of ESLint, the strict rules of typescript-eslint with type information, and the recommended rules of `eslint-plugin-astro` for Astro components. Every rule is an error, and the lint script adds `--max-warnings 0`. `eslint-config-prettier` switches off the rules that Prettier owns.

Rust: `cargo clippy` with every warning denied. The Cargo workspace denies the `all` and `pedantic` groups of clippy and forbids unsafe code.

## Commits

`commitlint.config.ts`: Conventional Commits with a fixed list of scopes and a header of 100 characters at most.

`.gitconfig` at the root declares two config-based hooks (Git 2.54 or later). `bun run setup` includes that file in the configuration of the clone, one time per clone.

- `pre-commit`: `scripts/git-hooks/format-staged.sh` formats the staged files with Prettier and stages them again.
- `commit-msg`: commitlint refuses a message that breaks the convention.

## CI

`.github/workflows/ci.yml` runs on each push to any branch.

- Job `checks`: dependency audit (level high, with one advisory ignored: the workflow file says which and why), type check, Astro check, lint, tests, format check, build of the site.
- Job `rust`, on Linux and on Windows: format check, clippy, tests.

The public CI never sees the content store (BUILD-11 of the spec). It builds the empty site and, later, the site of the fixture vault.

## Container for local work

`Dockerfile` and `compose.yaml` at the root. `docker compose up` installs the packages and runs the dev server of the site on `http://localhost:4321`. `SITE_PORT` selects another port of the machine.

- The image holds Node and Bun only, in the versions of `.nvmrc` and of `packageManager`. A guard test fails when they differ.
- The source of the clone is mounted, so a change of a file shows at once. The packages live in two volumes, apart from the packages of the host.
- `.dockerignore` excludes everything: the image build gets no file of the clone, so no private file can enter an image.
- The port is published on the machine only (`127.0.0.1`).
- The container runs as the user `node` (id 1000), so that the files it writes into the clone have the owner of a normal Linux account.
- It is not an image for production. The plain server that serves the built site comes with the first slice (HOST-02 of the spec).
- CI does not start the container. It is checked by hand.

## Site

`apps/site/astro.config.ts`: Astro with Tailwind 4 through its Vite plugin. `src/styles/global.css` imports Tailwind. Prettier formats Astro components with `prettier-plugin-astro`.

The test of the build writes its output to `apps/site/.cache/`, which git ignores. The folder must be on the file system of the site: Astro moves files into the output folder, and a move to another file system fails.

## Formatting

Prettier (`prettier.config.cjs`): no semicolons, single quotes, width 100, 4 spaces, no trailing commas.

## Bun

`bunfig.toml`: exact versions, and a 3-day waiting time for new package versions.
