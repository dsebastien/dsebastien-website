# dsebastien-website

The website of my public notes: [notes.dsebastien.net](https://notes.dsebastien.net), a digital garden with more than 20,000 notes.

A static site built with Astro, TypeScript and Tailwind from an Obsidian vault, and the tool that publishes notes to it from Obsidian. It replaces Obsidian Publish.

## Status

The plan is approved, and the build started. The site is empty for now.

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

Tools: Bun, Node (see `.nvmrc`), Git 2.54 or later, and the stable Rust toolchain with `rustfmt` and `clippy`.

```bash
bun install
bun run setup         # one time per clone: activates the commit hooks
bun run dev           # the site on a local server
bun run build         # the static site in apps/site/dist
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

Layout: `apps/site` is the Astro site, `cli` is the Rust command line program of the publishing tool, `scripts` holds the tooling.

Agents and contributors: read [`AGENTS.md`](AGENTS.md) first.
