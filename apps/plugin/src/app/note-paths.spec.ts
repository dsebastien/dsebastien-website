import { describe, expect, test } from 'bun:test'
import { obsidianNamesOf, noteTarget, vaultPathOf } from './note-paths.ts'
import { obsidianTwins } from '../publishing/names.ts'

// The path by which the plugin asks Obsidian for a note of the scan (issue
// 114). The paths are invented. U+00A0 is a no-break space; `e` and U+0301
// is a name that is not in the composed Unicode form.

const NBSP = '\u00a0'
const DECOMPOSED = 'Cafe\u0301.md'

function namesOf(paths: string[]): ReturnType<typeof obsidianNamesOf> {
    return obsidianNamesOf(paths, obsidianTwins(paths))
}

describe('the note that the plugin opens for a path of the scan', () => {
    test('a plain path opens that path', () => {
        expect(noteTarget('10 Garden/Plain.md', namesOf(['10 Garden/Plain.md']))).toEqual({
            kind: 'open',
            path: '10 Garden/Plain.md'
        })
    })

    test('a path with a no-break space opens the path with a space', () => {
        const path = `X${NBSP}Y.md`
        expect(noteTarget(path, namesOf([path]))).toEqual({ kind: 'open', path: 'X Y.md' })
    })

    test('a path with a backslash opens the path with a slash', () => {
        const path = 'Folder\\Note.md'
        expect(noteTarget(path, namesOf([path]))).toEqual({ kind: 'open', path: 'Folder/Note.md' })
    })

    test('a name that is not in the composed form opens the composed name', () => {
        expect(noteTarget(DECOMPOSED, namesOf([DECOMPOSED]))).toEqual({
            kind: 'open',
            path: 'Caf\u00e9.md'
        })
    })

    test('a twin opens nothing, and the message says to rename one of the two files', () => {
        const twin = `X${NBSP}Y.md`
        const names = namesOf(['X Y.md', twin])
        for (const [path, other] of [
            [twin, 'X Y.md'],
            ['X Y.md', twin]
        ] as const) {
            expect(noteTarget(path, names)).toEqual({
                kind: 'twin',
                message: `"${path}" cannot be opened: the file "${other}" has the same path in Obsidian ("X Y.md"), so Obsidian can take one for the other. Give one of the two files another name`
            })
        }
    })
})

describe('the note of the scan for the path of the open file in Obsidian', () => {
    test('a plain path is that path', () => {
        expect(vaultPathOf('Plain.md', namesOf(['Plain.md']))).toBe('Plain.md')
    })

    test('a path that Obsidian changed is the path of the scan', () => {
        const names = namesOf([`X${NBSP}Y.md`, 'Folder\\Note.md', DECOMPOSED])
        expect(vaultPathOf('X Y.md', names)).toBe(`X${NBSP}Y.md`)
        expect(vaultPathOf('Folder/Note.md', names)).toBe('Folder\\Note.md')
        expect(vaultPathOf('Caf\u00e9.md', names)).toBe(DECOMPOSED)
    })

    test('the Obsidian path of twins is no note: Obsidian can show either file', () => {
        expect(vaultPathOf('X Y.md', namesOf(['X Y.md', `X${NBSP}Y.md`]))).toBeUndefined()
        expect(vaultPathOf('X Y.md', namesOf([`X${NBSP}Y.md`, 'X\u202fY.md']))).toBeUndefined()
    })

    test('before the first check, a path is itself', () => {
        expect(vaultPathOf('Plain.md', undefined)).toBe('Plain.md')
        expect(noteTarget('X Y.md', undefined)).toEqual({ kind: 'open', path: 'X Y.md' })
    })
})
