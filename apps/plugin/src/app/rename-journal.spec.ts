import { describe, expect, test } from 'bun:test'
import { rejectionOf } from '@dsebastien-website/testing'
import { canonicalTime, JOURNAL_KEY, journalName, RenameRecorder } from './rename-journal.ts'
import type { DeviceStorage, JournalAdapter } from './rename-journal.ts'

// The rename journal of the plugin in Obsidian (PUB-60, R66). A fake adapter
// and a fake local storage stand for Obsidian: the events of a real vault are
// checked by hand inside Obsidian. The lines that the logic reads are the
// shared scenarios of `fixtures/canonical/queue.json`.

const FOLDER = '.obsidian/plugins/dsebastien-vault-publish/renames'
const NAME = '00000000000000aa.jsonl'
const MOMENT = new Date('2031-05-02T08:00:00.987Z')

/** An adapter in memory: its files, by path. */
function memoryAdapter(files: Map<string, string>, folders = new Set<string>()): JournalAdapter {
    return {
        exists: (path) => Promise.resolve(files.has(path) || folders.has(path)),
        mkdir: (path) => {
            folders.add(path)
            return Promise.resolve()
        },
        readBinary: (path) =>
            Promise.resolve(new TextEncoder().encode(files.get(path) ?? '').buffer),
        write: (path, data) => {
            files.set(path, data)
            return Promise.resolve()
        },
        append: async (path, data) => {
            // An append that waits, so that two records at once would mix
            // their reads and their writes.
            const before = files.get(path) ?? ''
            await new Promise((resolve) => setTimeout(resolve, 5))
            files.set(path, before + data)
        }
    }
}

function memoryStorage(values: Map<string, unknown>): DeviceStorage {
    return {
        loadLocalStorage: (key) => values.get(key) ?? null,
        saveLocalStorage: (key, data) => values.set(key, data)
    }
}

describe('the rename journal of the plugin', () => {
    test('writes a line of a renamed note, with the time cut to the second', async () => {
        const files = new Map<string, string>()
        const recorder = new RenameRecorder(memoryAdapter(files), FOLDER, NAME)

        expect(await recorder.record('file', 'Alpha.md', 'Notes/Alpha.md', MOMENT)).toBe(true)

        expect(files.get(`${FOLDER}/${NAME}`)).toBe(
            '{"from":"Alpha.md","kind":"note","time":"2031-05-02T08:00:00Z","to":"Notes/Alpha.md"}\n'
        )
    })

    test('writes a line of a renamed folder, and escapes a quote and a control character', async () => {
        const files = new Map<string, string>()
        const recorder = new RenameRecorder(memoryAdapter(files), FOLDER, NAME)

        await recorder.record('folder', 'Old "x"', 'New\u0001', MOMENT)

        expect(files.get(`${FOLDER}/${NAME}`)).toBe(
            '{"from":"Old \\"x\\"","kind":"folder","time":"2031-05-02T08:00:00Z","to":"New\\u0001"}\n'
        )
    })

    test('records no file that is not a note before and after the rename', async () => {
        const files = new Map<string, string>()
        const recorder = new RenameRecorder(memoryAdapter(files), FOLDER, NAME)

        expect(await recorder.record('file', 'photo.png', 'image.png', MOMENT)).toBe(false)
        expect(await recorder.record('file', 'Alpha.md', 'Alpha.txt', MOMENT)).toBe(false)
        expect(await recorder.record('file', 'Alpha.MD', 'Beta.md', MOMENT)).toBe(false)
        expect(await recorder.record('file', 'Alpha.md', 'Alpha.md', MOMENT)).toBe(false)
        expect(files.size).toBe(0)
    })

    test('keeps the order of the events, also when many come at once', async () => {
        const files = new Map<string, string>()
        const recorder = new RenameRecorder(memoryAdapter(files), FOLDER, NAME)

        await Promise.all(
            ['One', 'Two', 'Three'].map((name) =>
                recorder.record('file', `Folder/${name}.md`, `Area/${name}.md`, MOMENT)
            )
        )

        expect(
            (files.get(`${FOLDER}/${NAME}`) ?? '')
                .split('\n')
                .filter((line) => line !== '')
                .map((line) => (JSON.parse(line) as { from: string }).from)
        ).toEqual(['Folder/One.md', 'Folder/Two.md', 'Folder/Three.md'])
    })

    test('starts a new line after a line that was cut', async () => {
        const files = new Map([[`${FOLDER}/${NAME}`, '{"from":"Cut.md","kind":"no']])
        const recorder = new RenameRecorder(memoryAdapter(files, new Set([FOLDER])), FOLDER, NAME)

        await recorder.record('file', 'Alpha.md', 'Beta.md', MOMENT)

        expect(files.get(`${FOLDER}/${NAME}`)).toBe(
            '{"from":"Cut.md","kind":"no\n{"from":"Alpha.md","kind":"note","time":"2031-05-02T08:00:00Z","to":"Beta.md"}\n'
        )
    })

    test('a write that fails is reported, and the next rename is still recorded', async () => {
        const files = new Map<string, string>()
        const adapter = memoryAdapter(files)
        let fail = true
        const failing: JournalAdapter = {
            ...adapter,
            write: (path, data) =>
                fail ? Promise.reject(new Error('disk full')) : adapter.write(path, data)
        }
        const recorder = new RenameRecorder(failing, FOLDER, NAME)

        expect(await rejectionOf(recorder.record('file', 'A.md', 'B.md', MOMENT))).toContain(
            'disk full'
        )
        fail = false
        expect(await recorder.record('file', 'B.md', 'C.md', MOMENT)).toBe(true)
        expect(files.get(`${FOLDER}/${NAME}`)).toContain('"to":"C.md"')
    })
})

describe('the name of the journal of the device', () => {
    test('is made one time from random bytes, then kept in the local storage', () => {
        const values = new Map<string, unknown>()
        const storage = memoryStorage(values)
        const bytes = Uint8Array.from([0, 1, 0xab, 0x10, 0xff, 2, 3, 4])

        expect(journalName(storage, () => bytes)).toBe('0001ab10ff020304.jsonl')
        expect(values.get(JOURNAL_KEY)).toBe('0001ab10ff020304.jsonl')
        expect(journalName(storage, () => new Uint8Array(8))).toBe('0001ab10ff020304.jsonl')
    })

    test('a value of the local storage that is not such a name is made again', () => {
        const storage = memoryStorage(new Map([[JOURNAL_KEY, '../escape.jsonl']]))

        expect(journalName(storage, () => new Uint8Array(8).fill(0xcd))).toBe(
            'cdcdcdcdcdcdcdcd.jsonl'
        )
    })
})

describe('the time of a line', () => {
    test('is UTC, cut to the second', () => {
        expect(canonicalTime(new Date('2031-12-31T23:59:59.999Z'))).toBe('2031-12-31T23:59:59Z')
    })
})
