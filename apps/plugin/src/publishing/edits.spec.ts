import { describe, expect, test } from 'bun:test'
import {
    configurationChanged,
    editsText,
    eventId,
    eventsSince,
    logAfterPublication,
    makeEvent,
    NO_EDITS,
    openProposals,
    parseEdits,
    withConfiguration,
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

describe('the hash of the configuration at the last publication (issue 108)', () => {
    const HASH = `sha256:${'a'.repeat(64)}`

    test('is read, compared and moved as the canonical form says', () => {
        const log = parseEdits(textOf({ configuration: HASH, edits: [], published: 0 }))
        expect(log.configuration).toBe(HASH)
        expect(configurationChanged(log, HASH)).toBe(false)
        expect(configurationChanged(log, 'sha256:other')).toBe(true)
        expect(configurationChanged(NO_EDITS, HASH)).toBe(false)
        expect(logAfterPublication(log, 0, HASH, true)).toBeUndefined()
        expect(logAfterPublication(log, 0, 'sha256:new', false)?.configuration).toBe('sha256:new')
        // A log with no hash gets one only with a commit that happens anyway.
        expect(logAfterPublication(NO_EDITS, 0, HASH, false)).toBeUndefined()
        expect(logAfterPublication(NO_EDITS, 0, HASH, true)).toEqual({
            configuration: HASH,
            edits: [],
            published: 0
        })
        expect(withConfiguration(log, HASH, 'sha256:new').configuration).toBe('sha256:new')
        expect(withConfiguration(log, 'sha256:other', 'sha256:new').configuration).toBe(HASH)
    })

    test.each(['sha256:abc', 1, null])('refuses the value %p', (bad) => {
        expect(() => parseEdits(textOf({ configuration: bad, edits: [], published: 0 }))).toThrow(
            '"configuration" must be'
        )
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
        ['a list', '[]', 'an object with exactly "edits" and "published"'],
        [
            'another key',
            textOf({ edits: [], published: 0, more: 1 }),
            'an object with exactly "edits" and "published"'
        ],
        [
            'no list of events',
            textOf({ edits: {}, published: 0 }),
            '"edits" must be a list of events'
        ],
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
            'which is not the hash of the event'
        ],
        [
            'an event that was changed after its id',
            textOf({ edits: [{ ...DENY, path: 'Other' }], published: 0 }),
            'which is not the hash of the event'
        ],
        [
            'a decision of an unknown proposal',
            textOf({ edits: [DENY, REJECTED], published: 0 }),
            'the event 2 decides "979410bc2e7c049d", which is not an earlier proposal that no other event decided'
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
            'the event 1 has the key "note", which no event has'
        ],
        [
            'an action that does not exist',
            textOf({ edits: [{ ...DENY, action: 'delete' }], published: 0 }),
            'which is not deny, allow, ignore or unignore'
        ],
        [
            'a face that does not exist',
            textOf({ edits: [{ ...DENY, face: 'web' }], published: 0 }),
            'which is not a face of the tool'
        ],
        [
            'a time that is not in the canonical form',
            textOf({ edits: [{ ...DENY, time: '2031-06-01 09:00' }], published: 0 }),
            'has a time that is not a real date and time'
        ],
        [
            'a path that is not a vault path',
            textOf({ edits: [{ ...DENY, path: '/Private' }], published: 0 }),
            'has a path that is not the vault path'
        ],
        [
            'an ignore of a path that is not a note',
            textOf({ edits: [{ ...DENY, action: 'ignore' }], published: 0 }),
            'has a path that is not the vault path'
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
            'has a "proposal" that is not the id of a proposal it decides'
        ],
        [
            'a confirmation that the face plugin did not write',
            textOf({
                edits: [PROPOSAL, makeEvent({ ...CONFIRMED, face: 'mcp-server' })],
                published: 0
            }),
            'only the author decides a proposal'
        ],
        [
            'a rejection of the command line program',
            textOf({
                edits: [ALLOW, makeEvent({ ...REJECTED, face: 'command-line' })],
                published: 0
            }),
            'only the author decides a proposal'
        ],
        [
            'a list affects on an ignore',
            textOf({
                edits: [
                    makeEvent({
                        ...PROPOSAL,
                        action: 'ignore',
                        path: 'Mixed/Shown.md',
                        affects: ['a.md']
                    })
                ],
                published: 0
            }),
            'has a list "affects", which only a proposal and a confirmation of a deny have'
        ],
        [
            'a list affects on a deny that applied',
            textOf({ edits: [{ ...DENY, affects: ['a.md'] }], published: 0 }),
            'has a list "affects", which only a proposal and a confirmation of a deny have'
        ],
        [
            'a list affects that is not sorted',
            textOf({ edits: [{ ...PROPOSAL, affects: ['b.md', 'a.md'] }], published: 0 }),
            'has a list "affects" that is not vault paths, each one time, sorted'
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
