import { describe, expect, test } from 'bun:test'
import { SERIALIZER_ID, serializerLists } from './serializer.ts'
import type { PluginHost } from './starter-kit.ts'

// The face of the Dataview Serializer in Obsidian (PUB-35, R71). A fake `app`
// stands for Obsidian: the real plugin is checked by hand inside Obsidian.

function host(plugin: unknown): PluginHost {
    return { plugins: { plugins: plugin === undefined ? {} : { [SERIALIZER_ID]: plugin } } }
}

function note(
    path: string,
    outcome: string,
    more: {
        errors?: { query: string; message: string }[]
        skipped?: { query: string; reason: string }[]
    } = {}
): unknown {
    return { path, outcome, errors: more.errors ?? [], skipped: more.skipped ?? [] }
}

function serializer(answer: (paths: string[]) => unknown, asked: unknown[] = []): unknown {
    return {
        api: {
            name: 'kept',
            refreshNotes(this: { name: string }, paths: string[]) {
                // The API is called as a method of its object.
                asked.push(this.name, paths)
                return Promise.resolve(answer(paths))
            }
        }
    }
}

describe('the Dataview Serializer in Obsidian', () => {
    test('asks the API with the paths, and counts the notes that it refreshed', async () => {
        const asked: unknown[] = []
        const lists = serializerLists(
            host(
                serializer(
                    () => ({
                        state: 'ready',
                        notes: [
                            note('A.md', 'updated'),
                            note('B.md', 'unchanged'),
                            note('C.md', 'no-queries')
                        ]
                    }),
                    asked
                )
            )
        )

        const result = await lists.refresh(['A.md', 'B.md', 'C.md'])

        expect(asked).toEqual(['kept', ['A.md', 'B.md', 'C.md']])
        expect([...result.refreshed].sort()).toEqual(['A.md', 'B.md', 'C.md'])
        expect(result.wrote).toBe(true)
        expect(result.problems).toEqual([])
    })

    test('a refresh with no update wrote nothing', async () => {
        const lists = serializerLists(
            host(serializer(() => ({ state: 'ready', notes: [note('A.md', 'unchanged')] })))
        )

        expect((await lists.refresh(['A.md'])).wrote).toBe(false)
    })

    test.each([
        ['ignored', 'dataview_serializer_ignore'],
        ['not-found', 'no note at this path'],
        ['conflict', 'changed during the refresh'],
        ['not-run', 'did not run']
    ])('a note with the outcome %s is not refreshed', async (outcome, says) => {
        const lists = serializerLists(
            host(serializer(() => ({ state: 'ready', notes: [note('A.md', outcome)] })))
        )

        const result = await lists.refresh(['A.md'])

        expect(result.refreshed.size).toBe(0)
        expect(result.problems).toHaveLength(1)
        expect(result.problems[0]?.path).toBe('A.md')
        expect(result.problems[0]?.message).toContain(says)
    })

    test('a failed note names its errors', async () => {
        const lists = serializerLists(
            host(
                serializer(() => ({
                    state: 'ready',
                    notes: [
                        note('A.md', 'failed', {
                            errors: [{ query: 'LIST FROM #a', message: 'Parsing failed' }]
                        })
                    ]
                }))
            )
        )

        const result = await lists.refresh(['A.md'])

        expect(result.refreshed.size).toBe(0)
        expect(result.problems).toEqual([
            { path: 'A.md', message: 'a query failed: LIST FROM #a: Parsing failed' }
        ])
    })

    test('a note with a skipped query is not refreshed, also when it was written', async () => {
        const lists = serializerLists(
            host(
                serializer(() => ({
                    state: 'ready',
                    notes: [
                        note('A.md', 'updated', {
                            skipped: [
                                {
                                    query: 'LIST FROM [[Gone]]',
                                    reason: 'The previous output was kept.'
                                }
                            ]
                        })
                    ]
                }))
            )
        )

        const result = await lists.refresh(['A.md'])

        expect(result.refreshed.size).toBe(0)
        expect(result.wrote).toBe(true)
        expect(result.problems[0]?.message).toContain('The previous output was kept.')
    })

    test.each([
        ['disabled-on-device', 'turned off on this device'],
        ['dataview-not-loaded', 'Dataview is not loaded'],
        ['dataview-index-not-ready', 'index of Dataview is not ready']
    ])('the state %s refreshes no note', async (state, says) => {
        const lists = serializerLists(
            host(serializer(() => ({ state, notes: [note('A.md', 'not-run')] })))
        )

        const result = await lists.refresh(['A.md'])

        expect(result.refreshed.size).toBe(0)
        expect(result.wrote).toBe(false)
        expect(result.problems).toEqual([
            { path: 'A.md', message: expect.stringContaining(says) as string }
        ])
    })

    test('a plugin that is not enabled refreshes no note', async () => {
        const result = await serializerLists(host(undefined)).refresh(['A.md', 'B.md'])

        expect(result.refreshed.size).toBe(0)
        expect(result.problems.map((problem) => problem.path)).toEqual(['A.md', 'B.md'])
        expect(result.problems[0]?.message).toContain('not enabled')
    })

    test('a plugin without refreshNotes needs a newer version', async () => {
        const result = await serializerLists(host({ api: {} })).refresh(['A.md'])

        expect(result.problems[0]?.message).toContain('3.9.0')
    })

    test('an API that throws refreshes no note, and the plan is computed again', async () => {
        const lists = serializerLists(
            host(
                serializer(() => {
                    throw new Error('boom')
                })
            )
        )

        const result = await lists.refresh(['A.md'])

        expect(result.refreshed.size).toBe(0)
        // A note can have been written before the error.
        expect(result.wrote).toBe(true)
        expect(result.problems[0]?.message).toContain('boom')
    })

    test.each([
        ['no object', null],
        ['no state', { notes: [] }],
        ['an unknown state', { state: 'busy', notes: [] }],
        ['no notes', { state: 'ready' }],
        ['a note of another path', { state: 'ready', notes: [note('B.md', 'updated')] }],
        ['an unknown outcome', { state: 'ready', notes: [note('A.md', 'refreshed')] }],
        [
            'errors that are no list',
            {
                state: 'ready',
                notes: [{ path: 'A.md', outcome: 'updated', errors: 'x', skipped: [] }]
            }
        ]
    ])('an answer with %s refreshes no note', async (_name, answer) => {
        const lists = serializerLists(host(serializer(() => answer)))

        const result = await lists.refresh(['A.md'])

        expect(result.refreshed.size).toBe(0)
        expect(result.wrote).toBe(true)
        expect(result.problems[0]?.message).toContain('answer')
    })
})
