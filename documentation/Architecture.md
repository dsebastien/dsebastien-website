# Architecture

The architecture is in section 7 of `plans/spec-v2.md`: the vault, the publishing tool, the content store, the build, the hosting and the remote MCP server.

## What exists in this repository

| Folder      | What it is                                                                     | State                                    |
| ----------- | ------------------------------------------------------------------------------ | ---------------------------------------- |
| `apps/site` | The Astro and Tailwind site                                                    | An empty site that builds                |
| `cli`       | The Rust command line program of the publishing tool (ADR 0009)                | It prints its name and version           |
| `packages`  | TypeScript code that more than one app uses                                    | Not created yet                          |
| `scripts`   | Tooling of the repository and its guard tests                                  | Lint, commit hooks, CI, compiler options |
| (not set)   | The Obsidian plugin of the publishing tool. The ticket that creates it sets it | Not created yet                          |

The content store and the vault are never part of this repository.
