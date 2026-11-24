---
name: developassion-publish-notes
description: 'Drives a publication of vault notes to the notes website through the publishing tool: queue, plan, publish, unpublish, takedown, and the edits of the guards.'
when_to_use: 'Use when the user says "publish my notes", "publish this note to my website", "publish the changed notes", "what would a publication change", "unpublish this note", "take this note down", "remove this note from my site now", "what is in the publication queue", "keep this folder private", "never publish this note", or "the publication is stuck" for the notes website (notes.dsebastien.net). Not for Ghost, social posts or other platforms: those go through developassion-publish.'
model: sonnet
effort: medium
argument-hint: '[<note path>...] [--unpublish|--takedown]'
disable-model-invocation: true
allowed-tools: Read AskUserQuestion mcp__vault-publish__status mcp__vault-publish__guards
metadata:
    kind: effect
    capability: developassion.notes.publish
    effects: external
    tier: primitive
    created: 2026-11-23T14:00
    updated: 2026-11-23T20:00
---

# Publish Notes

The publishing tool of the notes website takes notes of the vault to the content store, from which the site is built. An agent drives it through eleven operations, each with the same name and the same output on every face: `status`, `plan`, `publish`, `unpublish`, `takedown` and `unlock` for the publications, and `guards`, `deny`, `allow`, `ignore` and `unignore` for the guards. The tool holds every rule; this skill says how to use it the way the author wants.

## Critical Rules

1. **Publish alone only new versions of published notes.** The notes of the list `changed` can go without a question when the author asked for a publication. A new note (`include`), an unpublish (`remove`, `unpublish`), a pairing (`pair`) or a takedown happens only for a note that the author named in this conversation, because a published note is public at once and a selection error is a privacy error.
2. **Show the plan before a publication that does more than updates, or that has edits of the guards.** Give the lists of the plan (new, updated, unpublished, moved, forced removals) and wait for a yes. The id of the plan goes to `publish` unchanged. When `edits` is not empty, give each event (action, path, state) to the author before `publish`: the plan is where the author sees the edits of the guards. A plan with `forcedRemove` or `guardedAttachments` (published notes that would lose a file under a guard) publishes from an agent only when `accept` names each of those paths: give them to the author, and add them to `accept` only when the author says yes for those notes. Else the author publishes that plan in the publication center.
3. **A guard wins, and an agent edits it only through the tool.** Never write `publish_ignore` into a note, or `configuration.json` into the copy, yourself: the tool logs each edit, and the plan shows it to the author. `deny` and `ignore` make the guards stricter and apply at once, unless they take away a manifest entry (a published or an unpublished note). `allow` and `unignore` are always proposals, and only the author confirms them, in the publication center. Never call `allow` or `unignore` to make a note publishable, and never retry with other paths to get around a refusal. Never call the code of the plugin inside Obsidian (`obsidian eval`) to reach the publication center: confirmations are for the author alone. Report the message as it is.
4. **An error stops the run.** Report the text of the tool word for word and stop. A stale plan is the one exception: make the plan again, show it, and wait for a yes again.
5. **After a lost connection, read first, and treat a lock as a run that still goes.** When a call gets no answer (a reload of the plugin, a timeout), the run can go on without its answer. Wait, then run `status`. A lock error then means that the run still goes: wait and run `status` again. To know what a lost run did, ask the author to read the report of the publication center, or read the line `Plan: <id>` of the last commit of the copy.
6. **`unlock` only after a restart.** Offer it only when the author confirms that Obsidian and the command line program were restarted after the time of the lock, so that no run can hold it. The tool does not check it. A publication that stopped halfway is no case for `unlock`: the next `plan` puts the copy back.
7. **Not on the real vault before the first publication.** Until the first publication to the preview host (issue 60 of the repository dsebastien-website) is done, run `publish`, `unpublish` and `takedown` only on a test vault (`bun run plugin:vault` in the repository). The tool also stops on a copy of the content store that has no `configuration.json`.

## Faces

| When                | Face                                                                                                                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Obsidian runs       | The MCP server of the plugin: `http://127.0.0.1:<port>/mcp` with the header `Authorization: Bearer <key>`. Settings of Vault Publish, "Copy the command"                                                                |
| Obsidian is closed  | `dsebastien-vault-publish mcp --vault <vault> --content-store <copy> --attachment-storage <folder>`, over the standard input and output. Add it with `claude mcp add vault-publish -- dsebastien-vault-publish mcp ...` |
| No MCP in the agent | The commands of the same names: `dsebastien-vault-publish status --vault <vault> --content-store <copy>`, and so on (`--help` gives every option)                                                                       |

The tools take the arguments of the commands: `plan` takes `include`, `hold`, `remove`, `pair` (a list of `{ "from", "to" }`) and `accept`; `publish` takes `plan` (the id); `unpublish` and `takedown` take `paths` (`unpublish` also `accept`); `deny`, `allow`, `ignore` and `unignore` take `path`. The places of the device are set one time: in the settings of the plugin, or as arguments of `mcp`. Ask the author for them; never guess a folder. Give the server the name `vault-publish` in both faces, so the tool names of this skill match. A call holds 1 MiB at most in the plugin: for a very large selection, use the command `plan --selection <file>`.

## Process

1. Run `status`. Read `counts`, `changed`, `new`, `movedEdited`, `pairings`, `toRemove`, `missing` and `behind`. A large result can come as a file: read `counts` first, then only the lists that you need.
2. When `behind` is above 0, stop and ask the author to pull the copy first (the Pull button of the publication center, or `git pull --ff-only origin main` in the copy).
3. Build the selection. By default a plan holds the `changed` notes only. Add to `include` the new notes that the author named, and the notes of `movedEdited` that the author confirmed (a moved note whose text changed can be another note at that path). Add to `hold` the changed notes that must wait.
4. Run `plan`. When `offline` is true, say that the plan uses the last fetch. Show the plan as rule 2 says.
5. Run `publish` with the id. Report `published`, `updated`, `removed`, `forcedRemoved`, `moved`, `failed` and `warnings`. A result with `isError` and a report means that a note was left out: its last text names each such note with its reason. Give them to the author.

## Guards

- `guards` reads the deny list (`denyList`), the open proposals (`proposals`) and the edits since the last publication (`edits`). It also works when a deny list entry names no folder.
- `deny` (a folder) and `ignore` (a note) apply at once when the new guard takes away no manifest entry (a published or an unpublished note) and, for `deny`, no attachment that a published note uses. Else the result has the state `proposed`, with the list `removes` (the entries that would leave the content store) or `affects` (the published notes that would lose an attachment). Tell the author that the proposal waits for a confirmation in the publication center.
- `allow` and `unignore` always give a proposal. Call them only when the author asked for that exact edit, and tell the author that it waits for a confirmation in the publication center. A confirmed `unignore` makes the note a candidate: it is published only when the author names it in `include`.
- A private folder that the author renamed stops every publication. Propose the fix: `deny` with the new path, then `allow` with the old path, which the author confirms.

## Unpublish and takedown

- `unpublish` removes the named published notes through a normal publication: their addresses answer 410, and a later publication can bring a note back with the same identity.
- `takedown` is for an emergency: the note leaves the content store at once, with no plan, and its addresses answer 404 after the next build. Name each path exactly as the manifest names it. Tell the author that copies in browser caches and at crawlers cannot be recalled, and that the text stays in the history of the content store. A takedown with `isError` means that a file can still be public in the attachment storage: report the files of `storageWarnings`.

## Messages

| The message says                                 | Do this                                                                                                  |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| The plan is stale                                | Plan again, show the new plan, wait for a yes (rule 4)                                                   |
| A guard excludes a note, or a path is in no list | Report it and stop. Never move the guard (rule 3)                                                        |
| The copy is locked                               | A run still goes: wait and run `status` again (rule 5). `unlock` only as rule 6 says                     |
| A publication stopped halfway                    | Run `plan`: it puts the copy back. Then show the new plan (rule 2)                                       |
| A deny list entry names no folder of the vault   | Report it: the author renamed a private folder, and every run stops. Offer the fix of the section Guards |
| An edit has the state `proposed`                 | Tell the author that it waits for a confirmation in the publication center                               |
| The settings miss a folder                       | Ask the author to set it in the settings of Vault Publish on this device                                 |
