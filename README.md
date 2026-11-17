# dsebastien-website

The website of my public notes: [notes.dsebastien.net](https://notes.dsebastien.net), a digital garden with more than 20,000 notes.

A static site built with Astro, TypeScript and Tailwind from an Obsidian vault, and the tool that publishes notes to it from Obsidian. It replaces Obsidian Publish.

## Status

Planning. No application code yet.

- Plan: [`documentation/plans/spec-v1.md`](documentation/plans/spec-v1.md) (draft)
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

```bash
bun install
bun run tsc
bun run test
bun run format
```

Agents and contributors: read [`AGENTS.md`](AGENTS.md) first.
