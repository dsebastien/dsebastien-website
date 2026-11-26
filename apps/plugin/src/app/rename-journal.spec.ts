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

describe('the rename journal after a restart of Obsidian', () => {
    test('the next session appends to the same journal, and reads it one time', async () => {
        const files = new Map<string, string>()
        const values = new Map<string, unknown>()
        const storage = memoryStorage(values)
        const random = (): Uint8Array => Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])
        const first = new RenameRecorder(memoryAdapter(files), FOLDER, journalName(storage, random))
        await first.record('file', 'A.md', 'B.md', MOMENT)

        // A restart: a new recorder, with the name that the local storage kept.
        let reads = 0
        const adapter = memoryAdapter(files, new Set([FOLDER]))
        const counted: JournalAdapter = {
            ...adapter,
            readBinary: (path) => {
                reads += 1
                return adapter.readBinary(path)
            }
        }
        const second = new RenameRecorder(
            counted,
            FOLDER,
            journalName(storage, () => new Uint8Array(8))
        )
        for (const name of ['C', 'D', 'E']) {
            await second.record('file', 'B.md', `${name}.md`, MOMENT)
        }

        const text = files.get(`${FOLDER}/0102030405060708.jsonl`) ?? ''
        expect(text.split('\n').filter((line) => line !== '')).toHaveLength(4)
        expect(text).toStartWith('{"from":"A.md"')
        expect(reads).toBe(1)
    })
})

// Issue 105: the content store counts the lines of each journal that a
// publication read. A journal with fewer lines than its count applies none of
// them, so the plugin never appends to a journal that lost lines that it
// wrote: it takes a new name, whose lines are all new.
describe('the rename journal that lost lines', () => {
    const random = (): Uint8Array => Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])
    const OLD = '0102030405060708.jsonl'
    const NEW = '0909090909090909.jsonl'

    async function recordTwo(
        files: Map<string, string>,
        values: Map<string, unknown>
    ): Promise<void> {
        const storage = memoryStorage(values)
        const first = new RenameRecorder(
            memoryAdapter(files),
            FOLDER,
            journalName(storage, random),
            {
                storage,
                random
            }
        )
        await first.record('file', 'A.md', 'B.md', MOMENT)
        await first.record('file', 'B.md', 'C.md', MOMENT)
    }

    function nextSession(files: Map<string, string>, values: Map<string, unknown>): RenameRecorder {
        const storage = memoryStorage(values)
        const again = (): Uint8Array => new Uint8Array(8).fill(9)
        return new RenameRecorder(
            memoryAdapter(files, new Set([FOLDER])),
            FOLDER,
            journalName(storage, again),
            { storage, random: again }
        )
    }

    test('a journal that was deleted is written again under a new name', async () => {
        const files = new Map<string, string>()
        const values = new Map<string, unknown>()
        await recordTwo(files, values)
        files.delete(`${FOLDER}/${OLD}`)

        await nextSession(files, values).record('file', 'C.md', 'D.md', MOMENT)

        expect(files.has(`${FOLDER}/${OLD}`)).toBe(false)
        expect(files.get(`${FOLDER}/${NEW}`)).toBe(
            '{"from":"C.md","kind":"note","time":"2031-05-02T08:00:00Z","to":"D.md"}\n'
        )
        expect(values.get(JOURNAL_KEY)).toBe(NEW)
    })

    test('a journal with fewer lines than the plugin wrote gets no new line', async () => {
        const files = new Map<string, string>()
        const values = new Map<string, unknown>()
        await recordTwo(files, values)
        const cut = (files.get(`${FOLDER}/${OLD}`) ?? '').split('\n')[0] ?? ''
        files.set(`${FOLDER}/${OLD}`, `${cut}\n`)

        await nextSession(files, values).record('file', 'C.md', 'D.md', MOMENT)

        expect(files.get(`${FOLDER}/${OLD}`)).toBe(`${cut}\n`)
        expect(files.get(`${FOLDER}/${NEW}`)).toContain('"to":"D.md"')
    })

    test('a journal with every line that the plugin wrote keeps its name', async () => {
        const files = new Map<string, string>()
        const values = new Map<string, unknown>()
        await recordTwo(files, values)

        await nextSession(files, values).record('file', 'C.md', 'D.md', MOMENT)

        expect((files.get(`${FOLDER}/${OLD}`) ?? '').split('\n').filter(Boolean)).toHaveLength(3)
        expect(files.has(`${FOLDER}/${NEW}`)).toBe(false)
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
