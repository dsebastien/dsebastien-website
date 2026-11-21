import { describe, expect, test } from 'bun:test'
import { rejectionOf } from '@dsebastien-website/testing'
import { noteTypesOf } from '../publishing/queue.ts'
import { STARTER_KIT_ID, starterKitNoteTypes } from './starter-kit.ts'
import type { PluginHost } from './starter-kit.ts'

// The face of the Starter Kit in Obsidian (decision R61). A fake `app` stands
// for Obsidian: the real plugin is checked by hand inside Obsidian.

const ANSWER = {
    noteTypes: [{ name: 'quotes', displayName: 'Quotes', prefix: '', suffix: ' (Quote)' }],
    notes: [
        { path: 'A.md', noteType: 'quotes' },
        { path: 'B.md', noteType: null }
    ]
}

function host(plugin: unknown): PluginHost {
    return { plugins: { plugins: plugin === undefined ? {} : { [STARTER_KIT_ID]: plugin } } }
}

describe('the Starter Kit in Obsidian', () => {
    test('asks the API of the plugin with the paths, and gives its data', async () => {
        const asked: unknown[] = []
        const api = {
            prefix: 'kept',
            recognizeNoteTypes(this: { prefix: string }, paths: string[]) {
                // The API is called as a method of its object.
                asked.push(this.prefix, paths)
                return Promise.resolve({ success: true, data: ANSWER })
            }
        }
        const types = await noteTypesOf(starterKitNoteTypes(host({ api })), ['A.md', 'B.md'])
        expect(asked).toEqual(['kept', ['A.md', 'B.md']])
        expect(Object.fromEntries(types)).toEqual({
            'A.md': { displayName: 'Quotes', name: 'quotes', suffix: ' (Quote)' }
        })
    })

    test('stops when the plugin is not enabled', async () => {
        expect(await rejectionOf(noteTypesOf(starterKitNoteTypes(host(undefined)), []))).toContain(
            'the Obsidian Starter Kit plugin is not enabled in this vault'
        )
    })

    test('stops when the plugin is too old for the batch API', async () => {
        const old = { api: { recognizeNoteType: () => Promise.resolve(null) } }
        expect(await rejectionOf(noteTypesOf(starterKitNoteTypes(host(old)), []))).toContain(
            'it needs a newer version'
        )
    })

    test('stops with the error of the plugin', async () => {
        const failing = {
            api: {
                recognizeNoteTypes: () =>
                    Promise.resolve({ success: false, error: 'not a note: C.txt' })
            }
        }
        const message = await rejectionOf(noteTypesOf(starterKitNoteTypes(host(failing)), ['A.md']))
        expect(message).toContain('the Obsidian Starter Kit cannot give the note types')
        expect(message).toContain('not a note: C.txt')
    })
})
