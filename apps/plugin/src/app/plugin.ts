import { Notice, Plugin, TFolder } from 'obsidian'
import { JOURNAL_FOLDER } from '../publishing/renames.ts'
import { journalName, RenameRecorder } from './rename-journal.ts'

/**
 * The Obsidian plugin of the publishing tool.
 *
 * It is a face of the tool (MOD-16 of the spec): a thin layer over the
 * publishing logic in `src/publishing/`, which never imports Obsidian. No rule
 * of the publishing logic lives here.
 */
export class VaultPublishPlugin extends Plugin {
    override onload(): void {
        // The rename journal of this device (PUB-60, decision R66): each
        // rename that Obsidian reports, so that the next publication keeps the
        // old URL as a redirect. The view comes with issue 39.
        const recorder = new RenameRecorder(
            this.app.vault.adapter,
            `${this.app.vault.configDir}/${JOURNAL_FOLDER}`,
            journalName(this.app, () => crypto.getRandomValues(new Uint8Array(8)))
        )
        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath) => {
                const kind = file instanceof TFolder ? 'folder' : 'file'
                recorder.record(kind, oldPath, file.path, new Date()).catch((error: unknown) => {
                    // A rename that is not recorded loses its redirect: the
                    // author must know, and can confirm the pairing later.
                    new Notice(
                        `Vault Publish could not record the rename of "${oldPath}" in its journal: ${error instanceof Error ? error.message : 'it failed'}. At the next publication, confirm the pairing, or pair the two notes by hand.`
                    )
                })
            })
        )
    }
}
