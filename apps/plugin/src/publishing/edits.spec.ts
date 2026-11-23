import { describe, expect, test } from 'bun:test'
import {
    editsText,
    eventId,
    eventsSince,
    makeEvent,
    NO_EDITS,
    openProposals,
    parseEdits,
    withEvent
} from './edits.ts'
import type { EditEvent, EditsLog } from './edits.ts'

// The log of the edits of the guards (issue 42, R69): `edits.json` of the
// content store. The ids were computed with sha256sum on the canonical form
// of each event without its id, not with this code.

const DENY: EditEvent = {
    action: 'deny',
    device: 'garden-shed',
    face: 'mcp-server',
    id: '34f508006aa66095',
    path: 'Private',
    state: 'applied',
    time: '2031-06-01T09:00:00Z'
}

const PROPOSAL: EditEvent = {
    action: 'deny',
    device: 'garden-shed',
    face: 'mcp-server',
    id: 'f2acc19e4bd54a30',
    path: 'Mixed',
    removes: ['Mixed/Shown.md'],
    state: 'proposed',
    time: '2031-06-01T10:00:00Z'
}

const ALLOW: EditEvent = {
    action: 'allow',
    device: 'garden-shed',
    face: 'command-line',
    id: '979410bc2e7c049d',
    path: 'Locked',
    state: 'proposed',
    time: '2031-06-01T11:00:00Z'
}

const CONFIRMED: EditEvent = {
    action: 'deny',
    device: 'garden-shed',
    face: 'plugin',
    id: '2c98e8dcc4c24a0d',
    path: 'Mixed',
    proposal: 'f2acc19e4bd54a30',
    removes: ['Mixed/Shown.md'],
    state: 'confirmed',
    time: '2031-06-01T15:00:00Z'
}

const REJECTED: EditEvent = {
    action: 'allow',
    device: 'garden-shed',
    face: 'plugin',
    id: '956359ea1ea6f305',
    path: 'Locked',
    proposal: '979410bc2e7c049d',
    state: 'rejected',
    time: '2031-06-01T16:00:00Z'
}

/** The text of a log, as JSON that the test changes. */
function textOf(log: unknown): string {
    return JSON.stringify(log)
}

describe('the id of an event', () => {
    test('is 16 digits of the SHA-256 of the event without its id, in the canonical form', () => {
        expect(eventId(DENY)).toBe(DENY.id)
        expect(eventId(PROPOSAL)).toBe(PROPOSAL.id)
        expect(eventId(CONFIRMED)).toBe(CONFIRMED.id)
        expect(eventId(REJECTED)).toBe(REJECTED.id)
    })

    test('makeEvent sorts the list removes, keeps each path one time, and drops an empty list', () => {
        const { id: _id, ...fields } = PROPOSAL
        expect(makeEvent({ ...fields, removes: ['Mixed/Shown.md', 'Mixed/Shown.md'] })).toEqual(
            PROPOSAL
        )
        expect(
            makeEvent({
                action: 'deny',
                device: 'garden-shed',
                face: 'mcp-server',
                path: 'Private',
                removes: [],
                state: 'applied',
                time: '2031-06-01T09:00:00Z'
            })
        ).toEqual(DENY)
        const sorted = makeEvent({ ...fields, removes: ['b.md', 'a b/c.md', 'a/z.md'] })
        expect(sorted.removes).toEqual(['a b/c.md', 'a/z.md', 'b.md'])
    })
})

describe('the strict read of edits.json', () => {
    const LOG: EditsLog = { edits: [DENY, PROPOSAL, ALLOW, CONFIRMED, REJECTED], published: 2 }

    test('a content store without the file has no event', () => {
        expect(parseEdits(undefined)).toEqual(NO_EDITS)
    })

    test('reads the text that it writes, in the canonical form', () => {
        expect(parseEdits(editsText(LOG))).toEqual(LOG)
        expect(editsText(withEvent(NO_EDITS, DENY))).toBe(
            '{\n  "edits": [\n    {\n      "action": "deny",\n      "device": "garden-shed",\n      "face": "mcp-server",\n      "id": "34f508006aa66095",\n      "path": "Private",\n      "state": "applied",\n      "time": "2031-06-01T09:00:00Z"\n    }\n  ],\n  "published": 0\n}\n'
        )
    })

    test.each([
        ['a text that is not JSON', '{', 'is not JSON'],
        ['a list', '[]', 'is not an object'],
        ['another key', textOf({ edits: [], published: 0, more: 1 }), 'key "more"'],
        ['no list of events', textOf({ edits: {}, published: 0 }), '"edits" is not a list'],
        ['no published', textOf({ edits: [] }), '"published"'],
        ['a published that is negative', textOf({ edits: [], published: -1 }), '"published"'],
        ['a published with a fraction', textOf({ edits: [], published: 0.5 }), '"published"'],
        [
            'a published above the number of events',
            textOf({ edits: [DENY], published: 2 }),
            '"published" is 2, above the number of events (1)'
        ],
        [
            'an id that is not the hash of its event',
            textOf({ edits: [{ ...DENY, id: '0123456789abcdef' }], published: 0 }),
            'the id of event 1 is not the hash'
        ],
        [
            'an event that was changed after its id',
            textOf({ edits: [{ ...DENY, path: 'Other' }], published: 0 }),
            'the id of event 1 is not the hash'
        ],
        [
            'a decision of an unknown proposal',
            textOf({ edits: [DENY, REJECTED], published: 0 }),
            'event 2 decides "979410bc2e7c049d", which is not an earlier proposal'
        ],
        [
            'a decision before its proposal',
            textOf({ edits: [REJECTED, ALLOW], published: 0 }),
            'event 1 decides'
        ],
        [
            'a proposal that is decided two times',
            textOf({ edits: [ALLOW, REJECTED, { ...REJECTED }], published: 0 }),
            'event 3 decides "979410bc2e7c049d"'
        ],
        [
            'a decision of an event that is not a proposal',
            textOf({
                edits: [
                    DENY,
                    makeEvent({ ...REJECTED, action: 'deny', path: 'Private', proposal: DENY.id })
                ],
                published: 0
            }),
            'event 2 decides'
        ],
        [
            'a decision with another path than its proposal',
            textOf({
                edits: [ALLOW, makeEvent({ ...REJECTED, path: 'Other' })],
                published: 0
            }),
            'another action or path'
        ],
        [
            'an allow that applied',
            textOf({ edits: [makeEvent({ ...ALLOW, state: 'applied' })], published: 0 }),
            'always a proposal'
        ],
        [
            'an event with a key that it does not know',
            textOf({ edits: [{ ...DENY, note: 'x' }], published: 0 }),
            'event 1 has the key "note"'
        ],
        [
            'an action that does not exist',
            textOf({ edits: [{ ...DENY, action: 'delete' }], published: 0 }),
            'no action'
        ],
        [
            'a face that does not exist',
            textOf({ edits: [{ ...DENY, face: 'web' }], published: 0 }),
            'no face'
        ],
        [
            'a time that is not in the canonical form',
            textOf({ edits: [{ ...DENY, time: '2031-06-01 09:00' }], published: 0 }),
            'no time'
        ],
        [
            'a path that is not a vault path',
            textOf({ edits: [{ ...DENY, path: '/Private' }], published: 0 }),
            'no path'
        ],
        [
            'an ignore of a path that is not a note',
            textOf({ edits: [{ ...DENY, action: 'ignore' }], published: 0 }),
            'no path'
        ],
        [
            'a list removes that is not sorted',
            textOf({ edits: [{ ...PROPOSAL, removes: ['b.md', 'a.md'] }], published: 0 }),
            'removes'
        ],
        [
            'an empty list removes',
            textOf({ edits: [{ ...PROPOSAL, removes: [] }], published: 0 }),
            'removes'
        ],
        [
            'a list removes on an event that applied',
            textOf({ edits: [{ ...DENY, removes: ['Private/a.md'] }], published: 0 }),
            'removes'
        ],
        [
            'a proposal key on a proposal',
            textOf({ edits: [{ ...ALLOW, proposal: DENY.id }], published: 0 }),
            'has a proposal'
        ]
    ])('refuses %s', (_name, text, says) => {
        let message = ''
        try {
            parseEdits(text)
        } catch (error) {
            message = error instanceof Error ? error.message : ''
        }
        expect(message).toContain('edits.json')
        expect(message).toContain(says)
    })
})

describe('the open proposals and the events since the last publication', () => {
    test('a proposal is open until an event confirms or rejects it, in the order of the log', () => {
        const log: EditsLog = { edits: [DENY, PROPOSAL, ALLOW], published: 0 }
        expect(openProposals(log)).toEqual([PROPOSAL, ALLOW])
        expect(openProposals({ edits: [...log.edits, REJECTED], published: 0 })).toEqual([PROPOSAL])
        expect(openProposals({ edits: [...log.edits, REJECTED, CONFIRMED], published: 0 })).toEqual(
            []
        )
    })

    test('a proposal that comes again after its decision is open again', () => {
        const log: EditsLog = { edits: [ALLOW, REJECTED, ALLOW], published: 0 }
        expect(parseEdits(editsText(log))).toEqual(log)
        expect(openProposals(log)).toEqual([ALLOW])
    })

    test('the plan shows the events after the first published ones', () => {
        const log: EditsLog = { edits: [DENY, PROPOSAL, ALLOW], published: 1 }
        expect(eventsSince(log)).toEqual([PROPOSAL, ALLOW])
        expect(eventsSince({ ...log, published: 3 })).toEqual([])
        expect(eventsSince(NO_EDITS)).toEqual([])
    })
})
