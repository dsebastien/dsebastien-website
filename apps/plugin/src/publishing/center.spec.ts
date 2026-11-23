import { describe, expect, test } from 'bun:test'
import {
    describePlan,
    filterRows,
    NO_CHOICES,
    pairByHand,
    planOfChoices,
    reconcile,
    rowsOf,
    selectionOf,
    stateOfNote,
    summaryOf,
    toggleRow,
    toggleTechnical,
    togglePairing,
    markUnpublish
} from './center.ts'
import type { Choices } from './center.ts'
import { fileNoteTypes, nodeDevice } from './node/device.ts'
import { plan, status } from './tool.ts'
import {
    copyFixtureVault,
    FIXTURE_NOTE_TYPES,
    makeContentStoreCopy,
    makeTestStores
} from '@dsebastien-website/testing'
import type { PublicationQueue } from './queue.ts'

// The model of the publication center (issue 39, R67): what the ticks of the
// author select, what the publish button counts, the rows of the four lists,
// the filters and the state of the open note. The view of the plugin only
// shows it (section 18.1 of the spec). The expected values are written by hand.

/** A queue as `status` gives it, with every list that the model reads. */
function queueOf(lists: Partial<PublicationQueue>): PublicationQueue {
    const queue = {
        behind: 0,
        changed: [],
        missing: [],
        new: [],
        pairings: [],
        renamed: [],
        technicalUpdates: [],
        toRemove: [],
        unchanged: [],
        unpublishedUnderGuard: [],
        ...lists
    }
    return {
        ...queue,
        counts: {
            changed: queue.changed.length,
            new: queue.new.length,
            toRemove: queue.toRemove.length,
            unchanged: queue.unchanged.length
        }
    }
}

const QUEUE = queueOf({
    changed: ['Garden/Edited.md', 'Garden/Linked.md'],
    technicalUpdates: ['Garden/Linked.md'],
    new: ['Drafts/Idea.md', 'Garden/Renamed outside.md'],
    toRemove: ['Garden/Gone.md', 'Private/Moved in.md'],
    missing: ['Garden/Gone.md'],
    unchanged: ['Garden/Stable.md', 'Garden/Moved.md'],
    unpublishedUnderGuard: ['Private/Old.md'],
    renamed: [{ from: 'Garden/Before.md', to: 'Garden/Moved.md' }],
    pairings: [{ from: 'Garden/Gone.md', to: 'Garden/Renamed outside.md' }]
})

describe('the selection of the ticks', () => {
    test('by default, the changed notes and the forced removals only, as a plan without paths', () => {
        expect(selectionOf(QUEUE, NO_CHOICES)).toEqual({
            include: [],
            hold: [],
            remove: [],
            pair: []
        })
        expect(planOfChoices(QUEUE, NO_CHOICES)).toEqual({
            forcedRemove: ['Private/Moved in.md', 'Private/Old.md'],
            move: [{ from: 'Garden/Before.md', to: 'Garden/Moved.md' }],
            publish: [],
            update: ['Garden/Edited.md', 'Garden/Linked.md'],
            remove: []
        })
    })

    test('a ticked candidate is published, an unticked changed note and the technical line are held', () => {
        let choices = toggleRow(QUEUE, NO_CHOICES, 'Drafts/Idea.md')
        choices = toggleRow(QUEUE, choices, 'Garden/Edited.md')
        choices = toggleTechnical(choices)
        expect(selectionOf(QUEUE, choices)).toEqual({
            include: ['Drafts/Idea.md'],
            hold: ['Garden/Edited.md', 'Garden/Linked.md'],
            remove: [],
            pair: []
        })
        expect(planOfChoices(QUEUE, choices)).toMatchObject({
            publish: ['Drafts/Idea.md'],
            update: []
        })
    })

    test('a mark removes a published note, and a ticked missing note is unpublished', () => {
        let choices = markUnpublish(QUEUE, NO_CHOICES, 'Garden/Edited.md')
        choices = markUnpublish(QUEUE, choices, 'Garden/Stable.md')
        choices = toggleRow(QUEUE, choices, 'Garden/Gone.md')
        expect(selectionOf(QUEUE, choices)).toEqual({
            include: [],
            hold: [],
            remove: ['Garden/Edited.md', 'Garden/Gone.md', 'Garden/Stable.md'],
            pair: []
        })
        expect(planOfChoices(QUEUE, choices)).toMatchObject({
            update: ['Garden/Linked.md'],
            remove: ['Garden/Edited.md', 'Garden/Gone.md', 'Garden/Stable.md']
        })
    })

    test('a confirmed pairing moves the missing note, and its candidate is not a new note', () => {
        let choices = toggleRow(QUEUE, NO_CHOICES, 'Garden/Renamed outside.md')
        choices = toggleRow(QUEUE, choices, 'Garden/Gone.md')
        choices = togglePairing(choices, {
            from: 'Garden/Gone.md',
            to: 'Garden/Renamed outside.md'
        })
        expect(selectionOf(QUEUE, choices)).toEqual({
            include: [],
            hold: [],
            remove: [],
            pair: [{ from: 'Garden/Gone.md', to: 'Garden/Renamed outside.md' }]
        })
        expect(planOfChoices(QUEUE, choices)).toMatchObject({
            move: [
                { from: 'Garden/Before.md', to: 'Garden/Moved.md' },
                { from: 'Garden/Gone.md', to: 'Garden/Renamed outside.md' }
            ],
            update: ['Garden/Edited.md', 'Garden/Linked.md', 'Garden/Renamed outside.md']
        })
    })

    test('a pairing by hand joins a missing note and a candidate', () => {
        const choices = pairByHand(NO_CHOICES, 'Garden/Gone.md', 'Drafts/Idea.md')
        expect(selectionOf(QUEUE, choices).pair).toEqual([
            { from: 'Garden/Gone.md', to: 'Drafts/Idea.md' }
        ])
    })

    test('a choice about a note that left its list is dropped after a check', () => {
        const before: Choices = {
            include: ['Drafts/Idea.md', 'Drafts/Deleted.md'],
            hold: ['Garden/Edited.md', 'Garden/Stable.md'],
            holdTechnical: true,
            unpublish: ['Garden/Stable.md', 'Garden/Deleted.md'],
            pair: [{ from: 'Garden/Gone.md', to: 'Garden/Deleted.md' }]
        }
        expect(reconcile(QUEUE, before)).toEqual({
            include: ['Drafts/Idea.md'],
            hold: ['Garden/Edited.md'],
            holdTechnical: true,
            unpublish: ['Garden/Stable.md'],
            pair: []
        })
    })
})

describe('the label of the publish button', () => {
    test('states each part of the plan', () => {
        expect(
            describePlan({
                forcedRemove: ['a.md', 'b.md'],
                move: [{ from: 'c.md', to: 'd.md' }],
                publish: ['e.md'],
                update: ['f.md', 'g.md', 'h.md'],
                remove: ['i.md']
            })
        ).toBe('Publish: 1 new, 3 updates, 1 removal, 2 forced removals, 1 move')
    })

    test('says when a plan does nothing', () => {
        expect(
            describePlan({ forcedRemove: [], move: [], publish: [], update: [], remove: [] })
        ).toBe('Nothing to publish')
    })
})

describe('the rows of the four lists', () => {
    test('show the default ticks, the locked rows and the marks', () => {
        const choices = markUnpublish(QUEUE, NO_CHOICES, 'Garden/Stable.md')
        const rows = rowsOf(QUEUE, choices)
        const view = (list: keyof typeof rows): string[] =>
            rows[list].map(
                (row) =>
                    `${row.checkable ? (row.ticked ? '[x]' : '[ ]') : '   '}${row.locked ? '#' : ' '} ${row.path} (${row.group})`
            )
        expect(view('new')).toEqual([
            '[ ]  Drafts/Idea.md (candidate)',
            '[ ]  Garden/Renamed outside.md (candidate)'
        ])
        expect(view('changed')).toEqual([
            '[x]  Garden/Edited.md (changed)',
            '[x]# Garden/Linked.md (technical)'
        ])
        expect(view('toRemove')).toEqual([
            '[x]# Private/Moved in.md (forced)',
            '[x]# Private/Old.md (unpublishedUnderGuard)',
            '[x]  Garden/Stable.md (unpublish)',
            '[ ]  Garden/Gone.md (missing)'
        ])
        expect(view('unchanged')).toEqual(['     Garden/Moved.md (unchanged)'])
    })

    test('lock both notes of a confirmed pairing', () => {
        const choices = togglePairing(NO_CHOICES, {
            from: 'Garden/Gone.md',
            to: 'Garden/Renamed outside.md'
        })
        const rows = rowsOf(QUEUE, choices)
        expect(rows.new.find((row) => row.path === 'Garden/Renamed outside.md')).toMatchObject({
            group: 'paired',
            locked: true,
            ticked: true,
            pairedWith: 'Garden/Gone.md'
        })
        expect(rows.toRemove.find((row) => row.path === 'Garden/Gone.md')).toMatchObject({
            group: 'paired',
            locked: true,
            ticked: true,
            pairedWith: 'Garden/Renamed outside.md'
        })
    })

    test('a tick on a locked row changes nothing', () => {
        expect(toggleRow(QUEUE, NO_CHOICES, 'Private/Moved in.md')).toEqual(NO_CHOICES)
        expect(toggleRow(QUEUE, NO_CHOICES, 'Garden/Linked.md')).toEqual(NO_CHOICES)
    })

    test('an untick of a marked note cancels the mark', () => {
        const marked = markUnpublish(QUEUE, NO_CHOICES, 'Garden/Stable.md')
        expect(toggleRow(QUEUE, marked, 'Garden/Stable.md')).toEqual(NO_CHOICES)
    })

    test('only a published note can be marked', () => {
        expect(markUnpublish(QUEUE, NO_CHOICES, 'Drafts/Idea.md')).toEqual(NO_CHOICES)
        expect(markUnpublish(QUEUE, NO_CHOICES, 'Private/Moved in.md')).toEqual(NO_CHOICES)
    })
})

describe('the filters', () => {
    const rows = rowsOf(
        queueOf({
            new: ['Garden/Compost basics.md', 'Garden/Frost dates.md', 'Kitchen/Compost tea.md']
        }),
        { ...NO_CHOICES, include: ['Garden/Frost dates.md', 'Kitchen/Compost tea.md'] }
    ).new

    test('keep the rows whose path holds every word of the text, in any letter case', () => {
        expect(
            filterRows(rows, { text: 'compost GARDEN', folder: '' }).map((row) => row.path)
        ).toEqual(['Garden/Compost basics.md'])
    })

    test('keep the rows of a folder and of the folders below it', () => {
        expect(filterRows(rows, { text: '', folder: 'Garden' }).map((row) => row.path)).toEqual([
            'Garden/Compost basics.md',
            'Garden/Frost dates.md'
        ])
        expect(filterRows(rows, { text: '', folder: 'Gar' })).toEqual([])
    })

    test('count the shown rows, the ticked rows and the ticked rows that the filter hides', () => {
        const shown = filterRows(rows, { text: 'compost', folder: '' })
        expect(summaryOf(rows, shown)).toEqual({ shown: 2, total: 3, selected: 2, hidden: 1 })
    })
})

describe('the state of the open note', () => {
    test('is unknown before the first check', () => {
        expect(stateOfNote(undefined, NO_CHOICES, 'Garden/Stable.md', false)).toEqual({
            kind: 'unknown',
            label: 'State unknown'
        })
    })

    test('names the list of the note at the last check', () => {
        const state = (path: string, choices = NO_CHOICES): string =>
            stateOfNote(QUEUE, choices, path, false).label
        expect(state('Garden/Stable.md')).toBe('Live')
        expect(state('Garden/Edited.md')).toBe('Live: changes not published')
        expect(state('Garden/Linked.md')).toBe('Live: an update of its links or files waits')
        expect(state('Drafts/Idea.md')).toBe('Not published')
        expect(state('Private/Moved in.md')).toBe('Removal forced: a guard excludes it')
        expect(state('Garden/Moved.md')).toBe('Live: moves to this path at the next publication')
        expect(state('Private/Secret.md')).toBe('Not in the queue: a guard excludes it')
        expect(
            state('Garden/Stable.md', markUnpublish(QUEUE, NO_CHOICES, 'Garden/Stable.md'))
        ).toBe('Will be unpublished')
    })

    test('marks an edit after the check', () => {
        expect(stateOfNote(QUEUE, NO_CHOICES, 'Garden/Stable.md', true).label).toBe(
            'Live (edited since the check)'
        )
        expect(stateOfNote(QUEUE, NO_CHOICES, 'Drafts/New.md', true)).toEqual({
            kind: 'unchecked',
            label: 'Not checked yet'
        })
    })
})

describe('the choices on the fixture vault', () => {
    test('give a selection that the logic takes, with the plan that the label counts', async () => {
        await using stores = await makeTestStores()
        const device = nodeDevice({
            vault: await copyFixtureVault(stores),
            contentStore: await makeContentStoreCopy(stores),
            attachmentStorage: stores.attachmentStorage,
            noteTypes: fileNoteTypes(FIXTURE_NOTE_TYPES)
        })
        const queue = await status(device)
        const choices = toggleRow(
            queue,
            toggleRow(queue, NO_CHOICES, '10 Garden/Frost dates explained.md'),
            '10 Garden/Compost basics.md'
        )

        const stored = await plan(device, selectionOf(queue, choices))

        expect(stored.plan).toEqual(planOfChoices(queue, choices))
        expect(describePlan(stored.plan)).toBe('Publish: 2 new')
    }, 60_000)
})
