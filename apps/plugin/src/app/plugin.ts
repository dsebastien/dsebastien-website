import { Plugin } from 'obsidian'

/**
 * The Obsidian plugin of the publishing tool.
 *
 * It is a face of the tool (MOD-16 of the spec): a thin layer over the
 * publishing logic in `src/publishing/`, which never imports Obsidian. No rule
 * of the publishing logic lives here.
 */
export class VaultPublishPlugin extends Plugin {
    override onload(): void {
        // The skeleton adds nothing to Obsidian: no command, no view, no
        // setting. Publishing is an opt-in per device, off by default (TOOL-11).
    }
}
