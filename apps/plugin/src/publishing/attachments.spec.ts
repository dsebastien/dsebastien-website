import { describe, expect, test } from 'bun:test'
import type { Attachment } from './attachments.ts'
import { removedAttachments } from './attachments.ts'
import type { ManifestEntry } from './manifest.ts'
import { attachmentsAfterPlan, makePlan } from './plan.ts'

// The attachments that a publication takes off the site (issue 135,
// `attachmentsRemoved` of "The publication plan"). The shared cases are the
// scenarios of `fixtures/canonical/queue.json`.

const ONE = `sha256:${'1'.repeat(64)}`
const TWO = `sha256:${'2'.repeat(64)}`
const NEW = `sha256:${'3'.repeat(64)}`

function file(path: string, hash: string, link = path): Attachment {
    return { hash, link, path, size: 1 }
}

function entry(path: string, attachments: Attachment[], state = 'published'): ManifestEntry {
    return { path, attachments, state } as unknown as ManifestEntry
}

describe('removedAttachments', () => {
    test('a file that no attachment after has by key and by path leaves the site', () => {
        expect(
            removedAttachments([[file('b.png', TWO), file('a.png', ONE)]], [[file('c.png', NEW)]])
        ).toEqual([
            { key: '1'.repeat(64), path: 'a.png' },
            { key: '2'.repeat(64), path: 'b.png' }
        ])
    })

    test('a file whose path stays with new bytes is an update, not a removal', () => {
        expect(removedAttachments([[file('a.png', ONE)]], [[file('a.png', NEW)]])).toEqual([])
    })

    test('a file that moves with the same bytes keeps its key', () => {
        expect(removedAttachments([[file('a.png', ONE)]], [[file('b/a.png', ONE)]])).toEqual([])
    })

    test('each pair is in the list one time', () => {
        expect(
            removedAttachments([[file('a.png', ONE)], [file('a.png', ONE, 'other link')]], [])
        ).toEqual([{ key: '1'.repeat(64), path: 'a.png' }])
    })
})

describe('attachmentsAfterPlan', () => {
    const manifest = new Map([
        ['Moved.md', entry('Moved.md', [file('m.png', ONE)])],
        ['Gone.md', entry('Gone.md', [file('g.png', TWO)])],
        ['Off.md', entry('Off.md', [file('o.png', TWO)], 'unpublished')]
    ])

    test('an entry keeps its files at the new path of a move, and a note to remove has none', () => {
        const plan = makePlan({
            forcedRemove: [],
            move: [{ from: 'Moved.md', to: 'New place.md' }],
            publish: [],
            update: [],
            remove: ['Gone.md']
        })
        expect(attachmentsAfterPlan(manifest, plan, new Map())).toEqual([[file('m.png', ONE)]])
    })

    test('a note of the plan has the files of the record, also a new one and one published again', () => {
        const plan = makePlan({
            forcedRemove: ['Gone.md'],
            move: [{ from: 'Moved.md', to: 'New place.md' }],
            publish: ['Fresh.md', 'Off.md'],
            update: ['New place.md'],
            remove: []
        })
        const planned = new Map([
            ['Fresh.md', [file('f.png', NEW)]],
            ['New place.md', [file('m.png', NEW)]],
            ['Off.md', [file('o.png', TWO)]]
        ])
        expect(attachmentsAfterPlan(manifest, plan, planned)).toEqual([
            [file('m.png', NEW)],
            [file('o.png', TWO)],
            [file('f.png', NEW)]
        ])
    })
})
