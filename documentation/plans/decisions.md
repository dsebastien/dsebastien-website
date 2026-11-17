# Decision log

Decisions of the author on `spec-v1.md`, round by round. Spec v2 is written from this log when every decision is settled. Decision ids (D1, D2, ...) are the ids of section 13 of spec v1.

Status: **settled** (decided by the author), **pending** (needs an analysis or a prototype first), **open** (not asked yet).

## Round 1 (2026-11-17)

| Id  | Decision                           | Status       | Answer of the author                                                                                                                                                         |
| --- | ---------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Host names                         | Settled      | The subdomains stay as they are: notes, store, stats. No merge into one host. See ADR 0001                                                                                   |
| D5  | Future of Ghost                    | Out of scope | The main site and the store are not touched by this project. Their future belongs to another project of the author                                                           |
| D2  | Order and scope                    | Settled      | Notes first, and notes only. This project is the notes website                                                                                                               |
| D4  | Publication model                  | Settled      | A content store with a review step. The `public_note` property becomes the trigger. See ADR 0002                                                                             |
| D37 | Selection at the first release     | Settled      | No bridge through Obsidian Publish, not even its panel. An own publishing tool, with inspiration from the author's Ghost Publish plugin. See ADR 0003                        |
| D3  | Hosting                            | Pending      | A prototype decides. The author wants the pros and cons first: `documentation/research/2026-11-17-hosting-options.md`                                                        |
| D6  | Switch condition                   | Settled      | Switch when the gate conditions pass. Other must-haves right after                                                                                                           |
| D7  | Default theme                      | Settled      | Dark when the system states no preference                                                                                                                                    |
| D46 | Indexing by search engines         | Settled      | Everything is indexed. No `noindex` rule for thin notes. See ADR 0004                                                                                                        |
| D8  | Media notes                        | Settled      | Same site, in a library section                                                                                                                                              |
| D40 | Person notes                       | Pending      | To analyze further                                                                                                                                                           |
| D33 | AI use                             | Settled      | Search and AI input allowed for all content. Training allowed for the author's own text, not for quotes, covers and tabs from other people                                   |
| D47 | Public notes against paid products | Pending      | To analyze further                                                                                                                                                           |
| D42 | Canonical URL form                 | Settled      | The long vault path stays the canonical URL. Existing URLs must never break: many sites link to the notes, and so do the author's own articles and newsletters. See ADR 0005 |
| D12 | Who may start a publication        | Pending      | The author and automation that the author started. To analyze further                                                                                                        |
| D22 | Publication from a phone           | Settled      | Not needed. The author does not publish from a phone                                                                                                                         |
| D28 | Issue tracker                      | Settled      | GitHub issues on this repository for public work. Private task notes in the vault for anything sensitive                                                                     |
| D35 | Themes                             | Settled      | A bonus. Tokens from the first commit, one theme at the first release                                                                                                        |

New inputs of round 1:

1. All notes are free. Limiting access to some parts later is an idea, not a requirement (GitHub issue).
2. How often the author holds back a changed note is not known. An analysis of the publishing habits is running.
3. A baseline of search and analytics data is collected through the browser of the author.

## Consequences for spec v2

1. The blog and store sections leave the spec. The codebase stays open to them, but nothing is planned or built for them here.
2. Stories of section 8 with the section "B" or "St" leave. Story 102 (each article exists one time) stays as a canonical URL question: articles and newsletters exist on the notes site and on the main site.
3. The publishing tool is on the critical path of the switch: the first version must do queue, select, publish, unpublish and takedown.
4. Decision D42 is final, not "for now": no shorter URL form is planned.
5. Decision D46 removes the `noindex` rule. The quality of thin pages still matters for search engines, so generated descriptions and the "my take" layout stay in the plan.
6. The stats site keeps its own host (decision to confirm in round 2).
