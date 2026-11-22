import { journalLine, renameLine } from '../publishing/renames.ts'

// The rename journal of this device inside Obsidian (PUB-60, decision R66).
// The plugin appends one line for each rename that Obsidian reports. The
// journal is a file of the plugin folder, so it survives a restart and
// travels with the vault to the other devices. The logic only reads it
// (`documentation/Canonical Form.md`, "The rename journal").

/** What this face needs of the adapter of the vault of Obsidian. */
export interface JournalAdapter {
    exists(path: string): Promise<boolean>
    mkdir(path: string): Promise<void>
    readBinary(path: string): Promise<ArrayBuffer>
    write(path: string, data: string): Promise<void>
    append(path: string, data: string): Promise<void>
}

/** The local storage of Obsidian: one value per device, never synchronized. */
export interface DeviceStorage {
    loadLocalStorage(key: string): unknown
    saveLocalStorage(key: string, data: unknown): void
}

/** The key of the name of the journal of this device in the local storage. */
export const JOURNAL_KEY = 'dsebastien-vault-publish-journal'

/** The form of the name of a journal. */
const JOURNAL_NAME = /^[0-9a-f]{16}\.jsonl$/

/**
 * The name of the journal of this device: 16 hexadecimal digits that the
 * plugin makes one time per device, then keeps in the local storage.
 *
 * @param random 8 random bytes
 */
export function journalName(storage: DeviceStorage, random: () => Uint8Array): string {
    const kept = storage.loadLocalStorage(JOURNAL_KEY)
    if (typeof kept === 'string' && JOURNAL_NAME.test(kept)) {
        return kept
    }
    const digits = [...random().subarray(0, 8)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
    if (digits.length !== 16) {
        throw new Error('the name of the rename journal needs 8 random bytes')
    }
    const name = `${digits}.jsonl`
    storage.saveLocalStorage(JOURNAL_KEY, name)
    return name
}

/** A moment as a time in the canonical form: UTC, cut to the second. */
export function canonicalTime(moment: Date): string {
    return `${moment.toISOString().slice(0, 19)}Z`
}

/**
 * Appends the renames of Obsidian to the journal of this device, one at a
 * time and in the order of the events: a folder rename gives many events at
 * once.
 */
export class RenameRecorder {
    readonly #adapter: JournalAdapter
    readonly #folder: string
    readonly #name: string
    #last: Promise<void> = Promise.resolve()

    /**
     * @param folder the folder of the journals, as a path of the adapter
     * @param name the name of the journal of this device
     */
    constructor(adapter: JournalAdapter, folder: string, name: string) {
        this.#adapter = adapter
        this.#folder = folder
        this.#name = name
    }

    /**
     * Records one rename. The result settles when the line is written: it
     * is false when the journal does not record such a rename (a file that is
     * not a note before and after). It throws when the write fails.
     */
    record(kind: 'file' | 'folder', from: string, to: string, moment: Date): Promise<boolean> {
        const line = renameLine(kind, from, to, canonicalTime(moment))
        const done = this.#last.then(async () => {
            if (line === undefined) {
                return false
            }
            await this.#append(journalLine(line))
            return true
        })
        // A failure of one write does not stop the next ones.
        this.#last = done.then(
            () => undefined,
            () => undefined
        )
        return done
    }

    async #append(text: string): Promise<void> {
        if (!(await this.#adapter.exists(this.#folder))) {
            await this.#adapter.mkdir(this.#folder)
        }
        const path = `${this.#folder}/${this.#name}`
        if (!(await this.#adapter.exists(path))) {
            await this.#adapter.write(path, text)
            return
        }
        // A line that was cut (a crash during a write) stays one line: the
        // new line starts on a line of its own.
        const bytes = new Uint8Array(await this.#adapter.readBinary(path))
        const cut = bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a
        await this.#adapter.append(path, cut ? `\n${text}` : text)
    }
}
