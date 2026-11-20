# dsebastien-website

The website of my public notes: [notes.dsebastien.net](https://notes.dsebastien.net), a digital garden with more than 20,000 notes.

A static site built with Astro, TypeScript and Tailwind from an Obsidian vault, and the tool that publishes notes to it from Obsidian. It replaces Obsidian Publish.

## Status

The plan is approved, and the build started. The first slice works: one note goes from a vault to a served page. The site has no design yet.

- Plan: [`documentation/plans/spec-v2.md`](documentation/plans/spec-v2.md)
- Decisions so far: [`documentation/plans/decisions.md`](documentation/plans/decisions.md)
- Ideas: [`documentation/plans/ideas-backlog.md`](documentation/plans/ideas-backlog.md)
- Facts about the existing sites: [`documentation/research/`](documentation/research/)

## Goals

- A fast static page per note, readable without JavaScript.
- Every existing URL continues to work.
- Global and local graph, full-text search, properties panel, recent notes, Markdown download.
- Publishing stays a decision per note, made in Obsidian.
- Ready for AI agents: Markdown on request, discovery files, clear content policy.

## Development

Tools: Bun, Node (see `.nvmrc`), Git 2.54 or later, and Rust through `rustup` (the version is pinned in `rust-toolchain.toml`).

```bash
bun install
bun run setup         # one time per clone: activates the commit hooks
bun run dev           # the site on a local server
bun run build         # the static site in apps/site/dist, and the plugin in apps/plugin/dist
bun run serve         # the built site on a plain local server, through the resolver
bun run budgets       # the time budgets of the note page in Lighthouse (needs Chrome and a quiet machine)
bun run corpus        # an invented vault of full size in .cache/corpus, for prototypes
bun run corpus:published --vault <folder> --list <file>   # the published notes of a vault in .cache/published
```

Or in a container, with Docker as the only tool on the machine:

```bash
docker compose up     # the dev server on http://localhost:4321, with the source mounted
```

The checks:

```bash
bun run tsc
bun run check
bun run lint
bun run test
bun run format:check
bun run rust:format:check
bun run rust:lint
bun run rust:test
```

Layout: `apps/site` is the Astro site, `apps/plugin` is the Obsidian plugin of the publishing tool, `cli` is its Rust command line program, `parity` holds the tests that compare the two, `fixtures` holds the invented test data, and `scripts` holds the tooling.

Agents and contributors: read [`AGENTS.md`](AGENTS.md) first.
