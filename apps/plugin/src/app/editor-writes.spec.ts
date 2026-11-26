import { describe, expect, test } from 'bun:test'
import type { Vault } from '../publishing/ports.ts'
import { editorWrites } from './editor-writes.ts'
import type { EditorVault } from './editor-writes.ts'

// The writes of the tool into the notes, through the vault of Obsidian (issue
// 106). A fake vault of the logic and a fake vault of Obsidian, in memory.

interface Note {
    text: string
}

function logicVault(notes: Map<string, string>, writes: string[]): Vault {
    const vault: Vault = {
        list: () => Promise.resolve([]),
        read: (path) => Promise.resolve(notes.get(path)),
        readBytes: () => Promise.resolve(undefined),
        hasFolder: () => Promise.resolve(false),
        write(path, text, before) {
            if (notes.get(path) !== before) {
                return Promise.resolve(false)
            }
            writes.push(path)
            notes.set(path, text)
            return Promise.resolve(true)
        },
        forRun: () => vault
    }
    return vault
}

function obsidian(files: Map<string, Note>, processed: string[]): EditorVault<Note> {
    return {
        getFileByPath: (path) => files.get(path) ?? null,
        process(file, change) {
            const path = [...files].find(([, one]) => one === file)?.[0] ?? ''
            processed.push(path)
            file.text = change(file.text)
            return Promise.resolve(file.text)
        }
    }
}

describe('the writes of the tool through the vault of Obsidian', () => {
    test('a note that Obsidian knows is written through it, in the vault of a run too', async () => {
        const note: Note = { text: 'Before\n' }
        const processed: string[] = []
        const writes: string[] = []
        const vault = editorWrites(
            logicVault(new Map(), writes),
            obsidian(new Map([['A.md', note]]), processed)
        ).forRun()

        expect(await vault.write('A.md', 'After\n', 'Before\n')).toBe(true)

        expect(note.text).toBe('After\n')
        expect(processed).toEqual(['A.md'])
        expect(writes).toEqual([])
    })

    test('a note whose text in Obsidian is not the text that the tool read is not written', async () => {
        // The author typed in the editor after the tool read the note.
        const note: Note = { text: 'Before, and typed\n' }
        const vault = editorWrites(
            logicVault(new Map(), []),
            obsidian(new Map([['A.md', note]]), [])
        )

        expect(await vault.write('A.md', 'After\n', 'Before\n')).toBe(false)

        expect(note.text).toBe('Before, and typed\n')
    })

    test('a note that Obsidian does not know is written by the vault of the logic', async () => {
        const notes = new Map([['B.md', 'Before\n']])
        const writes: string[] = []
        const vault = editorWrites(logicVault(notes, writes), obsidian(new Map(), []))

        expect(await vault.write('B.md', 'After\n', 'Before\n')).toBe(true)

        expect(writes).toEqual(['B.md'])
        expect(notes.get('B.md')).toBe('After\n')
    })
})
