# Configuration

## TypeScript

`tsconfig.json` at the repository root. Maximum strictness, from the Obsidian plugin template of the author, plus `exactOptionalPropertyTypes`, `useUnknownInCatchVariables`, `noUncheckedSideEffectImports` and `forceConsistentCasingInFileNames`.

- `types` is pinned to `bun` and `node`, so that a missing type package is a hard error.
- `allowJs` is off: JavaScript files cannot skip the type check.
- `lib` includes `DOM` for now. Packages that run only on a server get their own configuration without it.
- `jsx` is not set. It is added with the first package that needs it.
- Packages and apps extend this file. An Astro app also extends the strictest Astro preset.
- The root project holds `scripts/`, `packages/`, `parity/`, `apps/plugin/` and the configuration files: `bun run tsc` checks them. The site has its own `tsconfig.json` and is not part of the root project: `bun run check` runs `astro check` on it, where a warning fails the run.
- In `apps/site/tsconfig.json` the root configuration comes after the Astro preset, so that the strictness of the root wins (`allowJs` stays off).

## Workspaces

The root `package.json` declares the Bun workspaces `apps/*` and `packages/*`. `apps/site` is the Astro site. `apps/plugin` is the Obsidian plugin. `packages/testing` is the test support (`@dsebastien-website/testing`): it has no build step, and its entry is its TypeScript source. The root package depends on it, so that the tests of the root (`parity/`, `scripts/`) can import it. The root `Cargo.toml` declares the Cargo workspace, with `cli` as its only member.

## Lint

ESLint (`eslint.config.ts`): the recommended rules of ESLint, the strict rules of typescript-eslint with type information, and the recommended rules of `eslint-plugin-astro` for Astro components. Every rule is an error, and the lint script adds `--max-warnings 0`. `eslint-config-prettier` switches off the rules that Prettier owns.

Rust: `cargo clippy` with every warning denied. The Cargo workspace denies the `all` and `pedantic` groups of clippy and forbids unsafe code. `rust-toolchain.toml` pins one exact version of the toolchain for the machines of the author and for CI (the workflow names the same version, and a guard test compares the two): with "stable", a new version of clippy brought a new rule and failed CI with no change of the code. A guard test checks the pin.

## Commits

`commitlint.config.ts`: Conventional Commits with a fixed list of scopes and a header of 100 characters at most.

`.gitconfig` at the root declares four config-based hooks (Git 2.54 or later). `bun run setup` includes that file in the configuration of the clone, one time per clone.

- `pre-commit` and `pre-merge-commit`: `bun scripts/private-files.ts` refuses a commit that holds a private file (see "Private files" below). It runs first.
- `pre-push`: `bun scripts/private-files.ts --pushed` refuses a push of a commit that holds a private file.
- `pre-commit`: `scripts/git-hooks/format-staged.sh` formats the staged files with Prettier and stages them again.
- `commit-msg`: commitlint refuses a message that breaks the convention.

## Private files

`scripts/private-files.ts` is the check that keeps private files out of this public repository. It cannot see the real vault, so its rules use structure:

1. No file of a folder named `.private`, `.content` or `.cache`, at any depth and in any letter case.
2. A vault file exists only in `fixtures/vault/`: a Markdown file (`.md`, `.markdown`, `.mdx`) that starts with a block of properties, a file of a folder named `.obsidian` or `.trash`, and a file that ends in `.canvas`, `.base` or `.excalidraw`.
3. Every file of `fixtures/vault/` is declared in `fixtures/catalog.json`.
4. No symbolic link.

What it cannot find outside the fixture vault: a note without properties, an attachment, and real text that someone pastes into a file. Care stays necessary.

It runs three times, and each run reads the files and the catalog from the place that it checks:

- Before a commit and before the commit of a merge: the index. A change of the work tree that is not staged does not count.
- Before a push: each commit that the push sends. A cherry-pick, a rebase and a commit from a clone without the hooks run no pre-commit hook, so the push is the last door of the machine. Only the last commit of each pushed branch is read, not the commits before it.
- In the tests (`scripts/private-files.spec.ts`): every file of the clone that git tracks or does not ignore. The test also checks that git ignores the private folders, and `.obsidian/` and `.trash/`, so that the fixture vault can be opened in Obsidian.

A clone where `bun run setup` did not run has no hook. CI then finds a private file only after the push.

A Markdown file with properties that is not a note (for example an issue template) needs an exception in the script. None exists today.

## Fixtures and test stores

- `fixtures/` holds the fixture vault, its configuration and its catalog. `fixtures/README.md` has the rules.
- Prettier does not format `fixtures/vault/` (`.prettierignore`): the notes are test data, and their bytes must not change.
- `.gitattributes` gives every text file Unix line ends on every system. A Rust test checks it for the notes on Windows too, because the parity rule compares bytes.
- The test helpers make their folders in `.cache/test-stores/` of the clone, which git ignores.

## CI

`.github/workflows/ci.yml` runs on each push to any branch.

- Job `checks`: dependency audit (level high, with one advisory ignored: the workflow file says which and why), type check, Astro check, lint, tests, format check, build of the site and of the plugin. The job has the Rust toolchain, because the parity tests build the Rust program.
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

## Plugin

`apps/plugin`, from the Obsidian plugin template of the author. Only what the skeleton needs was taken: the entry (`src/main.ts`), the plugin class (`src/app/plugin.ts`), the manifest and the build script. The settings tab, the release scripts and the lint rules of the plugin catalog are not taken yet.

- `manifest.json`: the id is `dsebastien-vault-publish`, the name of the Rust program too (TOOL-14). The plugin is for desktop only.
- `bun run build:plugin` writes `main.js` and `manifest.json` to `apps/plugin/dist/`. The modules that Obsidian gives at run time stay out of the bundle.
- `bun run dev:plugin` builds at each change. With the variable `VAULT_PUBLISH_DEV_VAULT`, it also copies the build into the plugins folder of that vault. The folder must hold `.obsidian`, else the command stops and makes nothing. The path is read from the environment only, and it is never stored here.
- Use a test vault for `VAULT_PUBLISH_DEV_VAULT`, never the real vault, while the plugin is young. The plugin template reads `OBSIDIAN_VAULT_LOCATION`, which names the real vault on the machines of the author: this script does not read it, on purpose.
- The test of the build (`apps/plugin/src/build.spec.ts`) builds a release into `apps/plugin/.cache/`, loads the bundle with a stand-in for the `obsidian` module, and checks that the plugin adds nothing to Obsidian.
- A load in a real vault is a check by hand: copy the two files of `dist/` into `.obsidian/plugins/dsebastien-vault-publish/` of a vault, enable the plugin, and read the errors of the developer console.

## Publishing logic and parity

- TypeScript: `apps/plugin/src/publishing/`. Rust: `cli/src/`. The Rust program uses `clap` for its commands and `serde_json` for data. The feature `preserve_order` of `serde_json` stays off: the canonical form needs sorted keys.
- `documentation/Canonical Form.md` is the written canonical form. `fixtures/canonical/cases.json` holds its shared cases.
- `parity/harness.ts` builds the Rust program with `cargo build --locked` and asks cargo where the program is. `parity/*.spec.ts` compare the bytes of both implementations.
- ESLint refuses an import of `obsidian` and of the plugin code in `apps/plugin/src/publishing/` (`no-restricted-imports`).
- The Rust program writes its output with one write and a flush. A reader that closed the pipe is not an error. Another failure of the write gives exit code 1 with a message. Exit codes: 0 for success, 1 for an error, 2 for wrong arguments.

## Formatting

Prettier (`prettier.config.cjs`): no semicolons, single quotes, width 100, 4 spaces, no trailing commas.

## Bun

`bunfig.toml`: exact versions, and a 3-day waiting time for new package versions.
