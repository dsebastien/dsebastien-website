---
name: developassion-publish-notes
description: 'Drives a publication of vault notes to the notes website through the publishing tool: queue, plan, publish, unpublish, takedown.'
when_to_use: 'Use when the user says "publish my notes", "publish this note to my website", "publish the changed notes", "what would a publication change", "unpublish this note", "take this note down", "remove this note from my site now", "what is in the publication queue", or "the publication is stuck" for the notes website (notes.dsebastien.net). Not for Ghost, social posts or other platforms: those go through developassion-publish.'
model: sonnet
effort: medium
argument-hint: '[<note path>...] [--unpublish|--takedown]'
disable-model-invocation: true
allowed-tools: Read AskUserQuestion Bash(dsebastien-vault-publish:*) mcp__vault-publish__status mcp__vault-publish__plan mcp__vault-publish__publish mcp__vault-publish__unpublish mcp__vault-publish__takedown mcp__vault-publish__unlock
metadata:
    kind: effect
    capability: developassion.notes.publish
    effects: external
    tier: primitive
    created: 2026-11-23T14:00
    updated: 2026-11-23T14:00
---

# Publish Notes

The publishing tool of the notes website takes notes of the vault to the content store, from which the site is built. An agent drives it through six operations, each with the same name and the same output on every face: `status`, `plan`, `publish`, `unpublish`, `takedown` and `unlock`. The tool holds every rule; this skill says how to use it the way the author wants.

## Critical Rules

1. **Publish alone only new versions of published notes.** The notes of the list `changed` can go without a question when the author asked for a publication. A new note (`include`), an unpublish (`remove`, `unpublish`), a pairing (`pair`) or a takedown happens only for a note that the author named in this conversation, because a published note is public at once and a selection error is a privacy error.
2. **Show the plan before a publication that does more than updates.** Give the lists of the plan (new, updated, unpublished, moved, forced removals) and wait for a yes. The id of the plan goes to `publish` unchanged.
3. **A guard wins, and an agent never moves it.** Never edit `publish_ignore`, the deny list or `configuration.json` to make a note publishable, and never retry with other paths to get around a refusal. Report the message as it is.
4. **An error stops the run.** Report the text of the tool word for word and stop. A stale plan is the one exception: make the plan again, show it, and wait for a yes again.
5. **`unlock` only when the author confirms that no publication runs on this device**, in Obsidian or in the command line program. The tool does not check it.
6. **Not on the real vault before the first publication.** Until the first publication to the preview host (issue 60 of the repository dsebastien-website) is done, run `publish`, `unpublish` and `takedown` only on a test vault (`bun run plugin:vault` in the repository). The tool also stops on a copy of the content store that has no `configuration.json`.

## Faces

| When                | Face                                                                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Obsidian runs       | The MCP server of the plugin: `http://127.0.0.1:<port>/mcp` with the header `Authorization: Bearer <key>`. Settings of Vault Publish, "Copy the command" |
| Obsidian is closed  | `dsebastien-vault-publish mcp --vault <vault> --content-store <copy> --attachment-storage <folder>`, over the standard input and output                  |
| No MCP in the agent | The commands of the same names: `dsebastien-vault-publish status --vault <vault> --content-store <copy>`, and so on (`--help` gives every option)        |

The tools take the arguments of the commands: `plan` takes `include`, `hold`, `remove` and `pair` (a list of `{ "from", "to" }`); `publish` takes `plan` (the id); `unpublish` and `takedown` take `paths`. The places of the device are set one time: in the settings of the plugin, or as arguments of `mcp`. Ask the author for them; never guess a folder.

## Process

1. Run `status`. Read `counts`, `changed`, `new`, `movedEdited`, `pairings`, `toRemove`, `missing` and `behind`.
2. When `behind` is above 0, stop and ask the author to pull the copy first (the Pull button of the publication center, or `git pull --ff-only origin main` in the copy).
3. Build the selection. By default a plan holds the `changed` notes only. Add to `include` the new notes that the author named, and the notes of `movedEdited` that the author confirmed (a moved note whose text changed can be another note at that path). Add to `hold` the changed notes that must wait.
4. Run `plan`. When `offline` is true, say that the plan uses the last fetch. Show the plan as rule 2 says.
5. Run `publish` with the id. Report `published`, `updated`, `removed`, `forcedRemoved`, `moved`, `failed` and `warnings`. A result with `isError` and a report means that a note was left out: give the `reason` of each entry of `failed`.

## Unpublish and takedown

- `unpublish` removes the named published notes through a normal publication: their addresses answer 410, and a later publication can bring a note back with the same identity.
- `takedown` is for an emergency: the note leaves the content store at once, with no plan, and its addresses answer 404 after the next build. Name each path exactly as the manifest names it. Tell the author that copies in browser caches and at crawlers cannot be recalled, and that the text stays in the history of the content store. A takedown with `isError` means that a file can still be public in the attachment storage: report the files of `storageWarnings`.

## Messages

| The message says                                     | Do this                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------ |
| The plan is stale                                    | Plan again, show the new plan, wait for a yes (rule 4)                   |
| A guard excludes a note, or a path is in no list     | Report it and stop. Never move the guard (rule 3)                        |
| The copy is locked, or a publication stopped halfway | Ask the author whether a run is still going. Offer `unlock` (rule 5)     |
| A run of the publication center runs already         | Wait, then call again                                                    |
| A deny list entry names no folder of the vault       | Report it: the author renamed a private folder, and every run stops      |
| The settings miss a folder                           | Ask the author to set it in the settings of Vault Publish on this device |
