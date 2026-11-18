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

## Corpus of full size

`bun run corpus` writes an invented vault of full size for prototypes and budget tests (`scripts/generate-corpus.ts`, with the generator in `scripts/corpus.ts`).

- Options: `--seed` (default 1, from 0 to 4,294,967,295), `--notes` (default 20,735, the number of public notes that the research counted) and `--out` (default `.cache/corpus/`). The vault is in the `vault/` folder of the output.
- The same seed and the same number of notes give the same files, byte for byte, on every machine. The generator reads no clock and no random source of the system, and it writes its images without a compression library. A test pins the digest of a small corpus.
- The numbers follow the public counts of `documentation/research/2026-11-17-current-state.md`. Tuned to the totals and checked by a test: the size of the notes (about 66 MB for 71 MB) and the number of links (about 154,000 for 155,000). Close to the counts: the shares of the note types, the notes with an image, with aliases, with a table, with a frozen list, with a code block and with a link to a heading, and the aliases that two notes share. The words are invented syllables.
- Four media notes in ten are stubs, with no text. No link goes to a heading of a stub.
- Name patterns: a dot, an ending like a file extension, an apostrophe, a character outside ASCII, an ampersand, a literal plus, a percent sign. No name holds a question mark, because Windows refuses it. No two notes share a file name, also when letter case is ignored.
- A corpus of full size is about 32,000 files. It is written in a few seconds.

Both corpus commands share the rules of their output folder (`scripts/output-folder.ts`):

- Inside the clone, the output goes below `.cache/`, `.content/` or `.private/` only: git ignores those folders, and the check of private files refuses every file of them. Another folder of the clone is refused, also when git ignores it.
- The output is never the clone, a folder that holds the clone, a folder that the command reads, a folder inside one, or a folder that holds one. Symbolic links are resolved before the comparison.
- A command writes over a folder only when the folder is empty or is its own earlier output: it holds the marker file of the command, and the marker names the command. Files that the user added to an earlier output are removed with it.
- A path that is a file is refused.
- The options are checked before the earlier output is removed.

## Published corpus

`bun run corpus:published --vault <folder> --list <file>` copies the files that the list names from a vault into `.cache/published/vault/`, with their vault paths (`scripts/export-published.ts`). The author runs it on his machines with the list of what Obsidian Publish serves today, so that prototypes and budget measurements use the real published notes (decision R30).

- The list: a file that ends in `.json` is the site cache of Obsidian Publish (a JSON object whose keys are the paths) or a JSON list. Every other file is text with one path per line. An empty list stops the command.
- The path of the vault and the list are inputs of the command. Neither is stored in this repository. The list of the author is in his private working files.
- The command never reads a file outside the vault. A path of the list that leaves the vault is not read, and a symbolic link that leads out of the vault is not followed.
- A file that is missing in the vault, that leaves the vault or that cannot be read is written to `missing.txt` of the output, and the command goes on.
- A file that the list names two times is copied and counted one time.
- The command never writes into the vault, and its output folder never touches the vault (see the rules above).
- Its marker file, `published.json`, holds the name of the command and three counts, and no path.
- The public CI never has the published corpus. Its tests use the fixture vault as the vault, with an invented list.

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

- The variable `CONTENT_STORE` names the folder of a copy of the content store. The build reads the cleaned notes (`notes/`) as a content collection and the manifest (`manifest/`), and nothing else. It never reads the vault. Without the variable the site has no note: that is the state of the public CI, which never sees the content store.
- One file per page (`build.format` is `file`). The page of a note is `-/note/<id>.html`, where the id is the identity of the note in the manifest. That name is plain ASCII on every system and on every host, whatever the name of the note is.
- The build writes the resolver map to `-/resolver-map.json`: the canonical path of each published note, and the home page, with the file of its page.
- `packages/resolver` holds the URL function (`canonicalPath`) and the resolver (`resolve`). The first version of the resolver knows the canonical path of a published note. The variants, the redirects and "gone" come with the slice of the URL contract, which also checks the encoding against the URLs of today.
- `bun run serve` starts the plain local server on `http://127.0.0.1:4322` (`apps/site/server/serve.ts`, options `--dist` and `--port`). It answers through the resolver: 200 with the page for a path of the resolver map. It also gives the files of the `_astro/` folder of the output (the style sheets), from a list that it reads one time at its start. Every other path answers 404. The file of a response comes from the resolver map or from that list, never from the request. It is not a server for production.
- The build stops when the content store cannot be trusted: `CONTENT_STORE` names no folder, a file of the manifest is not an entry, the id of an entry is not 16 hexadecimal digits, or two entries have the same path.
- The markup of a note comes from the Markdown renderer of Astro for now. The slice of the rendering replaces it after the adopt check of issue 12.

The tests of the builds write their output to `apps/site/.cache/`, which git ignores. The folder must be on the file system of the site: Astro moves files into the output folder, and a move to another file system fails.

To see a note on this machine: publish it into a copy of a content store with the command line program, build with `CONTENT_STORE=<copy> bun run build`, then `bun run serve`.

## Plugin

`apps/plugin`, from the Obsidian plugin template of the author. Only what the skeleton needs was taken: the entry (`src/main.ts`), the plugin class (`src/app/plugin.ts`), the manifest and the build script. The settings tab, the release scripts and the lint rules of the plugin catalog are not taken yet.

- `manifest.json`: the id is `dsebastien-vault-publish`, the name of the Rust program too (TOOL-14). The plugin is for desktop only.
- `bun run build:plugin` writes `main.js` and `manifest.json` to `apps/plugin/dist/`. The modules that Obsidian gives at run time stay out of the bundle.
- `bun run dev:plugin` builds at each change. With the variable `VAULT_PUBLISH_DEV_VAULT`, it also copies the build into the plugins folder of that vault. The folder must hold `.obsidian`, else the command stops and makes nothing. The path is read from the environment only, and it is never stored here.
- Use a test vault for `VAULT_PUBLISH_DEV_VAULT`, never the real vault, while the plugin is young. The plugin template reads `OBSIDIAN_VAULT_LOCATION`, which names the real vault on the machines of the author: this script does not read it, on purpose.
- The test of the build (`apps/plugin/src/build.spec.ts`) builds a release into `apps/plugin/.cache/`, loads the bundle with a stand-in for the `obsidian` module, and checks that the plugin adds nothing to Obsidian.
- A load in a real vault is a check by hand: copy the two files of `dist/` into `.obsidian/plugins/dsebastien-vault-publish/` of a vault, enable the plugin, and read the errors of the developer console.

## Publishing logic and parity

- The commands of the Rust program, for now:
    - `status --vault <folder> --content-store <folder>` writes the publication queue: the lists `new`, `changed`, `toRemove` and `unchanged` with a count per list, and `technicalUpdates` for the changed notes that the author did not edit. It changes nothing.
    - `plan --vault <folder> --content-store <folder> [--include <vault path>]... [--hold <vault path>]... [--remove <vault path>]... | [--selection <file>]` computes a plan, stores it on the device and writes it with its id. Without a path, the plan holds the changed notes only. A note that was never published enters a plan only with `--include`. `--hold` leaves a changed note out. `--remove` unpublishes a published note. `--selection <file>` reads the three lists from a JSON file in the place of the options (`{"include": [...], "hold": [...], "remove": [...]}`, each list optional): a large first publication holds more paths than the system takes as arguments of one command. It changes nothing in the vault and in the content of the store.
    - `publish --vault <folder> --content-store <folder> --plan <id> [--time <time>] [--device <name>]` applies one plan: one commit with the cleaned notes and the manifest entries, a push without force, then the correction of the `public_note` property in the vault. It writes the publication report. Without `--time`, the program reads the clock one time. Without `--device`, it reads the name of the host. The name goes into the message of the commit, with the counts and the face.
    - Exit codes: 0, and 1 for an error. `publish` also ends with 1 when the report names a note that was left out. The report is then written first.
    - `--content-store` is the copy of the content store on this device: a git clone whose `origin` is the content store. The plans are stored in its git folder (`.git/vault-publish/plans/`): on the device, never in a commit, never in the vault.
    - The copy must be the root of its own git repository, else the program stops. `configuration.json` and `manifest/` in the copy must be the files of its last commit, else the program stops. So after an edit of the deny list by hand, commit `configuration.json` and push it before the next run: the message of the program says so, and only proposes to put back the manifest, which the tool alone writes. A publication stages and commits only the files that it wrote, also when a rule of the store ignores them.
    - When the commit fails or the push is refused (another device pushed first), nothing is published: the program takes its commit back and puts every file of the publication back as it was, the copy is as it was before, and no property is written in the vault. The full recovery of a refused push comes with the slice of the failure cases.
    - Every git command of the tool reads paths as they are written (a note name can hold `[` or `*`) and converts no line end, whatever the settings of the machine say. The paths of a publication go to git on its standard input, so the number of notes of one publication has no limit of the system, and the folder of the copy can be a relative path.
    - A note is read from the vault only by its exact path: each part must be a name of the folder listing, with the same letter case, and a symbolic link is not a file of the vault.
- In TypeScript the same operations are `status`, `plan` and `publish` of `apps/plugin/src/publishing/tool.ts`. They take a device (`ports.ts`): a vault, a content store and a plan store. `publish` also takes the time of the run, the name of the device and the face. `node/device.ts` gives a device from two folders, with the `git` program of the system.
- Both implementations read the properties of a note as lines of text, with the rules of `documentation/Canonical Form.md`, and use no YAML library.
- TypeScript: `apps/plugin/src/publishing/`. Rust: `cli/src/`. The Rust program uses `clap` for its commands and `serde_json` for data. The feature `preserve_order` of `serde_json` stays off: the canonical form needs sorted keys.
- `documentation/Canonical Form.md` is the written canonical form. `fixtures/canonical/` holds its shared cases: `cases.json` (data), `properties.json` (the properties of a note) and `queue.json` (scenarios of the publication queue).
- `parity/harness.ts` builds the Rust program with `cargo build --locked` and asks cargo where the program is. `parity/*.spec.ts` compare the bytes of both implementations.
- ESLint refuses an import of `obsidian` and of the plugin code in `apps/plugin/src/publishing/` (`no-restricted-imports`).
- The Rust program writes its output with one write and a flush. A reader that closed the pipe is not an error. Another failure of the write gives exit code 1 with a message. Exit codes: 0 for success, 1 for an error, 2 for wrong arguments.

## Formatting

Prettier (`prettier.config.cjs`): no semicolons, single quotes, width 100, 4 spaces, no trailing commas.

## Bun

`bunfig.toml`: exact versions, and a 3-day waiting time for new package versions.
