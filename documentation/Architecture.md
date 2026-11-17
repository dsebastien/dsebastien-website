# Architecture

The architecture is in section 7 of `plans/spec-v2.md`: the vault, the publishing tool, the content store, the build, the hosting and the remote MCP server.

## What exists in this repository

| Folder        | What it is                                                                                                        | State                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `apps/site`   | The Astro and Tailwind site, and the plain local server                                                           | One page per published note of a content store, served through the resolver              |
| `cli`         | The Rust command line program of the publishing tool (ADR 0009)                                                   | `plan` and `publish`: the first publication of selected notes                            |
| `packages`    | TypeScript code that more than one app uses                                                                       | `packages/testing`: test support. `packages/resolver`: the URL function and the resolver |
| `fixtures`    | The fixture vault, its configuration and its catalog. Invented data only                                          | A first set of notes (spec 18.4)                                                         |
| `scripts`     | Tooling of the repository and its guard tests                                                                     | Lint, commit hooks, CI, compiler options, the check of private files                     |
| `apps/plugin` | The Obsidian plugin of the publishing tool, with the TypeScript implementation of the publishing logic (ADR 0009) | The logic publishes a note for the first time. The plugin itself loads and does nothing  |
| `parity`      | The parity tests: they run both implementations and compare the bytes                                             | A first publication of six notes, and an empty plan                                      |

The content store and the vault are never part of this repository.
