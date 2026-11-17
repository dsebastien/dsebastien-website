# dsebastien-website

One codebase for [dsebastien.net](https://www.dsebastien.net): the public notes (digital garden), the blog and the store.

Static sites built with Astro, TypeScript and Tailwind from an Obsidian vault.

## Status

Planning. No application code yet.

- Plan: [`documentation/plans/spec-v1.md`](documentation/plans/spec-v1.md) (draft)
- Facts about the existing sites: [`documentation/research/`](documentation/research/)

## Goals

- A fast static page per note, readable without JavaScript.
- Every existing URL continues to work.
- Global and local graph, full-text search, properties panel, recent notes, Markdown download.
- Publishing stays a decision per note, made in Obsidian.
- Ready for AI agents: Markdown on request, discovery files, clear content policy.

## Development

```bash
bun install
bun run tsc
bun run test
bun run format
```

Agents and contributors: read [`AGENTS.md`](AGENTS.md) first.
