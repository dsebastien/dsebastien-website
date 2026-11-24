import { describe, expect, test } from 'bun:test'
import { SERIALIZER_ID, serializerLists } from './serializer.ts'
import type { PluginHost } from './starter-kit.ts'

// The face of the Dataview Serializer in Obsidian (PUB-35, R71). A fake `app`
// stands for Obsidian: the real plugin is checked by hand inside Obsidian.

/** The adapter with a `normalizePath` that changes nothing, as for a plain path. */
function listsOf(app: PluginHost, limit?: number): ReturnType<typeof serializerLists> {
    return serializerLists(app, (path) => path, limit)
}

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
    return {
        path,
        resolvedPath: outcome === 'not-found' || outcome === 'not-run' ? null : path,
        writes: outcome === 'updated' ? 1 : 0,
        outcome,
        errors: more.errors ?? [],
        skipped: more.skipped ?? []
    }
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
        const lists = listsOf(
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
        // A note in which the serializer finds no query to run is not refreshed.
        expect([...result.refreshed].sort()).toEqual(['A.md', 'B.md'])
        expect([...result.written]).toEqual([['A.md', 1]])
        expect(result.wrote).toBe(true)
        expect(result.problems).toEqual([
            { path: 'C.md', message: 'the Dataview Serializer found no query to run in this note' }
        ])
    })

    test('a note that the serializer found at another path is not refreshed', async () => {
        const lists = listsOf(
            host(
                serializer(() => ({
                    state: 'ready',
                    notes: [{ ...(note('A.md', 'updated') as object), resolvedPath: 'B.md' }]
                }))
            )
        )

        const result = await lists.refresh(['A.md'])

        expect(result.refreshed.size).toBe(0)
        expect(result.wrote).toBe(true)
        expect(result.problems[0]?.message).toContain('another file')
    })

    test('an answer without resolvedPath cannot be read', async () => {
        const lists = listsOf(
            host(
                serializer(() => ({
                    state: 'ready',
                    notes: [
                        {
                            path: 'A.md',
                            resolvedPath: 'A.md',
                            outcome: 'updated',
                            errors: [],
                            skipped: []
                        }
                    ]
                }))
            )
        )

        expect((await lists.refresh(['A.md'])).problems[0]?.message).toContain('answer')
    })

    test('a note written in two passes counts two writes', async () => {
        const lists = listsOf(
            host(
                serializer(() => ({
                    state: 'ready',
                    notes: [{ ...(note('A.md', 'updated') as object), writes: 2 }]
                }))
            )
        )

        expect([...(await lists.refresh(['A.md'])).written]).toEqual([['A.md', 2]])
    })

    test('a note that a pass wrote before a later pass failed is a write', async () => {
        const lists = listsOf(
            host(
                serializer(() => ({
                    state: 'ready',
                    notes: [
                        {
                            ...(note('A.md', 'failed', {
                                errors: [{ query: 'LIST', message: 'boom' }]
                            }) as object),
                            writes: 1
                        }
                    ]
                }))
            )
        )

        const result = await lists.refresh(['A.md'])

        expect(result.wrote).toBe(true)
        expect([...result.written]).toEqual([['A.md', 1]])
        expect(result.refreshed.size).toBe(0)
    })

    test.each([[-1], [1.5], ['1'], [undefined]])(
        'an answer whose writes is %p cannot be read',
        async (writes) => {
            const lists = listsOf(
                host(
                    serializer(() => ({
                        state: 'ready',
                        notes: [{ ...(note('A.md', 'updated') as object), writes }]
                    }))
                )
            )

            expect((await lists.refresh(['A.md'])).problems[0]?.message).toContain('answer')
        }
    )

    test('a conflict counts as a write: the plan is computed again', async () => {
        const lists = listsOf(
            host(serializer(() => ({ state: 'ready', notes: [note('A.md', 'conflict')] })))
        )

        const result = await lists.refresh(['A.md'])

        expect(result.wrote).toBe(true)
        expect(result.written.size).toBe(0)
        expect(result.refreshed.size).toBe(0)
    })

    test('a path that Obsidian changes is not asked (issue 110)', async () => {
        const asked: unknown[] = []
        const lists = listsOf(
            host(
                serializer(
                    (paths) => ({
                        state: 'ready',
                        notes: paths.map((path) => note(path, 'unchanged'))
                    }),
                    asked
                )
            )
        )

        const result = await lists.refresh(['a\u00a0b.md', 'c\u202fd.md', 'e\u0301.md', 'A.md'])

        expect(asked).toEqual(['kept', ['A.md']])
        expect([...result.refreshed]).toEqual(['A.md'])
        expect(result.problems.map((problem) => problem.path)).toEqual([
            'a\u00a0b.md',
            'c\u202fd.md',
            'e\u0301.md'
        ])
    })

    test('a path that the normalizePath of Obsidian changes is not asked', async () => {
        const asked: unknown[] = []
        const lists = serializerLists(
            host(
                serializer(
                    (paths) => ({
                        state: 'ready',
                        notes: paths.map((path) => note(path, 'unchanged'))
                    }),
                    asked
                )
            ),
            (path) => path.replaceAll('\\', '/')
        )

        const result = await lists.refresh(['a\\b.md', 'A.md'])

        expect(asked).toEqual(['kept', ['A.md']])
        expect(result.problems.map((problem) => problem.path)).toEqual(['a\\b.md'])
    })

    test('a refresh waits for an earlier call that is still running, within the limit', async () => {
        let calls = 0
        const lists = listsOf(
            host(
                serializer(() => {
                    calls += 1
                    return new Promise(() => undefined)
                })
            ),
            20
        )

        await lists.refresh(['A.md'])
        const second = await lists.refresh(['A.md'])

        expect(calls).toBe(1)
        expect(second.wrote).toBe(true)
        expect(second.problems[0]?.message).toContain('still runs an earlier refresh')
    })

    test('a serializer that does not answer in time refreshes no note', async () => {
        const lists = listsOf(host(serializer(() => new Promise(() => undefined))), 20)

        const result = await lists.refresh(['A.md'])

        expect(result.refreshed.size).toBe(0)
        expect(result.wrote).toBe(true)
        expect(result.problems[0]?.message).toContain('did not answer within')
    })

    test.each([['toString'], ['constructor'], ['__proto__']])(
        'the name %s of an object is no state and no outcome',
        async (name) => {
            const asState = listsOf(
                host(serializer(() => ({ state: name, notes: [note('A.md', 'updated')] })))
            )
            const asOutcome = listsOf(
                host(serializer(() => ({ state: 'ready', notes: [note('A.md', name)] })))
            )

            for (const lists of [asState, asOutcome]) {
                const result = await lists.refresh(['A.md'])
                expect(result.refreshed.size).toBe(0)
                expect(result.problems[0]?.message).toContain('answer')
            }
        }
    )

    test('an answer with a list of another length cannot be read', async () => {
        const lists = listsOf(
            host(
                serializer(() => ({
                    state: 'ready',
                    notes: [note('A.md', 'updated'), note('A.md', 'updated')]
                }))
            )
        )

        expect((await lists.refresh(['A.md'])).problems[0]?.message).toContain('answer')
    })

    test('a refresh with no update wrote nothing', async () => {
        const lists = listsOf(
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
        const lists = listsOf(
            host(serializer(() => ({ state: 'ready', notes: [note('A.md', outcome)] })))
        )

        const result = await lists.refresh(['A.md'])

        expect(result.refreshed.size).toBe(0)
        expect(result.problems).toHaveLength(1)
        expect(result.problems[0]?.path).toBe('A.md')
        expect(result.problems[0]?.message).toContain(says)
    })

    test('a failed note names its errors', async () => {
        const lists = listsOf(
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
        const lists = listsOf(
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
        ['dataview-index-not-ready', 'index of Dataview is not ready'],
        ['dataview-index-busy', 'still indexing recent edits']
    ])('the state %s refreshes no note', async (state, says) => {
        const lists = listsOf(host(serializer(() => ({ state, notes: [note('A.md', 'not-run')] }))))

        const result = await lists.refresh(['A.md'])

        expect(result.refreshed.size).toBe(0)
        expect(result.wrote).toBe(false)
        expect(result.problems).toEqual([
            { path: 'A.md', message: expect.stringContaining(says) as string }
        ])
    })

    test('a busy index names the notes that Dataview has not indexed yet', async () => {
        const lists = listsOf(
            host(
                serializer(() => ({
                    state: 'dataview-index-busy',
                    stalePaths: ['B.md'],
                    notes: [note('A.md', 'not-run')]
                }))
            )
        )

        expect((await lists.refresh(['A.md'])).problems[0]?.message).toContain(
            'not indexed yet: "B.md"'
        )
    })

    test('a plugin that is not enabled refreshes no note', async () => {
        const result = await listsOf(host(undefined)).refresh(['A.md', 'B.md'])

        expect(result.refreshed.size).toBe(0)
        expect(result.problems.map((problem) => problem.path)).toEqual(['A.md', 'B.md'])
        expect(result.problems[0]?.message).toContain('not enabled')
    })

    test('a plugin without refreshNotes needs a newer version', async () => {
        const result = await listsOf(host({ api: {} })).refresh(['A.md'])

        expect(result.problems[0]?.message).toContain('3.9.0')
    })

    test('an API that throws refreshes no note, and the plan is computed again', async () => {
        const lists = listsOf(
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
        const lists = listsOf(host(serializer(() => answer)))

        const result = await lists.refresh(['A.md'])

        expect(result.refreshed.size).toBe(0)
        expect(result.wrote).toBe(true)
        expect(result.problems[0]?.message).toContain('answer')
    })
})
