import type { Vault } from '../publishing/ports.ts'

// The writes of the tool into the notes of the vault, in Obsidian (issue 106):
// the state property after a publication and the ignore property of an edit
// of the guards go through the vault of Obsidian (`app.vault.process`), as an
// edit in its editor. A write through Node, beside Obsidian, can race with a
// save of the editor: the editor can then write its older text over it, or
// lose what the author typed. It imports no Obsidian: the plugin gives it the
// two methods of the vault of Obsidian that it uses.

/** What the writes need of the vault of Obsidian. */
export interface EditorVault<File> {
    /** The note with exactly this path, or `null` when Obsidian does not know it. */
    getFileByPath(path: string): File | null
    /** Reads the note, changes its text and saves it, in one step for the editor of Obsidian. */
    process(file: File, change: (text: string) => string): Promise<string>
}

/**
 * The vault of the logic, whose writes go through the vault of Obsidian. A
 * note that Obsidian does not know is written through the vault of the logic.
 */
export function editorWrites<File>(vault: Vault, editor: EditorVault<File>): Vault {
    return {
        ...vault,
        async write(path, text, before) {
            const file = editor.getFileByPath(path)
            if (file === null) {
                return await vault.write(path, text, before)
            }
            // The text of the note in Obsidian, at the moment of the write:
            // a note that changed since the tool read it stays as it is.
            let wrote = false
            await editor.process(file, (now) => {
                if (now !== before) {
                    return now
                }
                wrote = true
                return text
            })
            return wrote
        },
        forRun: () => editorWrites(vault.forRun(), editor)
    }
}
