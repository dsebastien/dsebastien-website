# Adopt check of the Markdown conversion (issue 26)

A prototype: it is not merged into main. The result and the decision are in
`documentation/research/2026-11-20-markdown-adopt-check.md` on main.

- `run.ts`: runs each candidate on the corpus of the Markdown forms
  (`fixtures/markdown-forms.json`) and writes `results/` (invented notes only).
- `astro5/`: an Astro 5 project for `astro-loader-obsidian`, which needs Astro 5.
  `run.ts` fills `astro5/vault-copy/` and builds it.
- `measure-speed.ts`: the time to convert the invented corpus (`bun run corpus`).
- `pele-check.ts`: Pele renders Mermaid at build time in Bun.
- `count-forms.ts`: counts the notes that use each form. On the published notes
  of the author its output goes to `.private/`, never into this repository.

```bash
cd prototypes/markdown-adopt-check && bun install && (cd astro5 && bun install) && bun run.ts
```
