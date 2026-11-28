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
    /** The note of Obsidian for this vault path (by its Obsidian path, issue 114), or `null` when Obsidian does not know it or it has a twin (R72). */
    getFileByPath(path: string): File | null
    /** Saves each open editor of the note, so that text that the author typed is in the note. */
    saveOpenEditors(file: File): Promise<void>
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
            // The typing that an open editor did not save yet goes into the
            // note first: it makes the note another text than the one that
            // the tool read, so the write does not happen.
            await editor.saveOpenEditors(file)
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

/** What a save needs of an open editor of Obsidian (`MarkdownView`). */
export interface OpenEditor<File> {
    readonly file: File | null
    /** The text of the note as the editor last loaded or saved it. */
    readonly data: string
    /** The text in the editor now. */
    getViewData(): string
    save(): Promise<void>
}

/**
 * Saves each open editor of the note whose text is not saved yet, so that
 * what the author typed is in the note before a write of the tool. An
 * editor with no change is not saved: its buffer can be older than the note
 * (another program wrote it), and a save would write it over the newer text.
 */
export async function saveUnsavedEditors<File>(
    editors: readonly OpenEditor<File>[],
    file: File
): Promise<void> {
    for (const editor of editors) {
        if (editor.file === file && editor.getViewData() !== editor.data) {
            await editor.save()
        }
    }
}
