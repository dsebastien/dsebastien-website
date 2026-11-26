import { describe, expect, test } from 'bun:test'
import { isolateNames, lockState, waysOut } from './messages.ts'

// The messages of the publication center in the view and the notices (issue
// 106). A right-to-left mark (U+200F) in an invented file name stands for a
// name that could reorder the message.

const RLM = '‏'

describe('the names of a message', () => {
    test('each quoted name is isolated from the text around it', () => {
        expect(
            isolateNames(
                `A new note changed after the check: "10 Garden/${RLM}One.md", "Two.md". Check them.`
            )
        ).toBe(
            `A new note changed after the check: "⁨10 Garden/${RLM}One.md⁩", "⁨Two.md⁩". Check them.`
        )
    })

    test('a name at the start, in brackets and at the end of the text', () => {
        expect(isolateNames('"A.md" moved ("B.md"): "C.md"')).toBe(
            '"⁨A.md⁩" moved ("⁨B.md⁩"): "⁨C.md⁩"'
        )
    })

    test('a name that is isolated already, a text with no name, and a lone quote stay', () => {
        expect(isolateNames('"⁨A.md⁩" stays')).toBe('"⁨A.md⁩" stays')
        expect(isolateNames('Check done: 3 new')).toBe('Check done: 3 new')
        expect(isolateNames('a "lone quote')).toBe('a "lone quote')
    })

    test('a quote inside a word opens no name', () => {
        expect(isolateNames('the 12" record and "A.md"')).toBe('the 12" record and "⁨A.md⁩"')
    })
})

describe('the confirmation of the removal of the lock', () => {
    const runs = (id: number): boolean => id === 41

    test('says whether the process of the lock still runs', () => {
        expect(lockState({ command: 'publish', process: 41 }, runs)).toBe(
            'The lock was taken by a run of publish in the process 41, and a process with that number still runs on this computer: that run can still hold it. Remove it only when you know that it stopped.'
        )
        expect(lockState({ command: 'publish', process: 42 }, runs)).toBe(
            'The lock was taken by a run of publish in the process 42, which no longer runs on this computer: the run stopped.'
        )
    })

    test('a lock that names no process, and no lock', () => {
        expect(lockState({}, runs)).toBe(
            'The lock was taken by a run, and it names no process: the tool cannot tell whether that run still runs.'
        )
        expect(lockState(undefined, runs)).toBe('There is no lock now.')
    })
})

describe('the ways out of an error', () => {
    test('a missing or a wrong setting leads to the settings', () => {
        for (const error of [
            'Set the folder of the copy of the content store in the settings of Vault Publish',
            'The folder of the attachment storage must be an absolute path: "a"',
            'the copy of the content store is not the root of a git repository: /c',
            'the copy of the content store has no origin: it is not a clone of the content store: /c'
        ]) {
            expect(waysOut(error), error).toEqual({ settings: true, pull: false, unlock: false })
        }
    })

    test('a copy that is behind, or that has no configuration yet, leads to a pull, not to the settings', () => {
        for (const error of [
            'the copy of the content store is 2 commit(s) behind the content store: another device changed the content store since the last pull',
            'the copy of the content store has no configuration.json in its last commit: the folder is not the copy of the content store, or the content store has no configuration yet'
        ]) {
            expect(waysOut(error), error).toEqual({ settings: false, pull: true, unlock: false })
        }
    })

    test('a lock leads to its removal, and another error to nothing', () => {
        expect(
            waysOut(
                'a publication runs on this device, or one stopped halfway (the lock holds {"command":"plan"})'
            )
        ).toEqual({ settings: false, pull: false, unlock: true })
        expect(
            waysOut(
                'the copy of the content store has 1 commit(s) that the content store does not have'
            )
        ).toEqual({ settings: false, pull: false, unlock: false })
    })
})
