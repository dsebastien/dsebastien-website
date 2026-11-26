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
    return newJournalName(storage, random)
}

/** A new name of the journal of this device, kept in the local storage. */
function newJournalName(storage: DeviceStorage, random: () => Uint8Array): string {
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

/**
 * The key of the lines that this device wrote into its journal, in the local
 * storage: `{ name, lines }`, the line feeds of the file after the last write.
 */
export const JOURNAL_LINES_KEY = 'dsebastien-vault-publish-journal-lines'

/** The number of line feeds of the bytes of a journal. */
function lineFeeds(bytes: Uint8Array): number {
    return bytes.reduce((count, byte) => (byte === 0x0a ? count + 1 : count), 0)
}

/** What a recorder needs to give its journal a new name (issue 105). */
export interface JournalRenewal {
    readonly storage: DeviceStorage
    /** 8 random bytes. */
    readonly random: () => Uint8Array
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
    #name: string
    readonly #renewal: JournalRenewal | undefined
    /** The line feeds of the journal after the last write of this recorder. */
    #lines = 0
    #last: Promise<void> = Promise.resolve()
    /** True when this recorder wrote the last line: the file then ends with a line feed. */
    #wrote = false

    /**
     * @param folder the folder of the journals, as a path of the adapter
     * @param name the name of the journal of this device
     * @param renewal with it, the recorder counts the lines that it writes in
     * the local storage, and gives the journal a new name when the file has
     * fewer lines than it wrote: the file was deleted, cut, or written again
     * by a restore or a synchronization. The content store counts the lines
     * that the publications read, so a line that such a file gets below that
     * count would never be applied. A new name has only new lines.
     */
    constructor(adapter: JournalAdapter, folder: string, name: string, renewal?: JournalRenewal) {
        this.#adapter = adapter
        this.#folder = folder
        this.#name = name
        this.#renewal = renewal
    }

    /** The line feeds that this device wrote into the journal of this name, by the local storage. */
    #written(): number {
        const kept = this.#renewal?.storage.loadLocalStorage(JOURNAL_LINES_KEY)
        if (typeof kept !== 'object' || kept === null) {
            return 0
        }
        const { name, lines } = kept as { name?: unknown; lines?: unknown }
        return name === this.#name && typeof lines === 'number' ? lines : 0
    }

    /** Keeps the line feeds of the journal after a write. */
    #keep(text: string): void {
        this.#lines += lineFeeds(new TextEncoder().encode(text))
        this.#renewal?.storage.saveLocalStorage(JOURNAL_LINES_KEY, {
            name: this.#name,
            lines: this.#lines
        })
    }

    /** The bytes of the journal at a path, empty when it does not exist. */
    async #bytes(path: string, exists: boolean): Promise<Uint8Array> {
        return exists ? new Uint8Array(await this.#adapter.readBinary(path)) : new Uint8Array()
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
        let path = `${this.#folder}/${this.#name}`
        let exists = await this.#adapter.exists(path)
        // Only this device writes its journal, so the file is read one time
        // per session, not for each line: a folder rename gives one event
        // per note.
        let cut = false
        // A file that is gone during the session is checked too.
        if (!this.#wrote || !exists) {
            let bytes = await this.#bytes(path, exists)
            this.#lines = lineFeeds(bytes)
            if (this.#renewal !== undefined && this.#lines < this.#written()) {
                this.#name = newJournalName(this.#renewal.storage, this.#renewal.random)
                path = `${this.#folder}/${this.#name}`
                exists = await this.#adapter.exists(path)
                bytes = await this.#bytes(path, exists)
                this.#lines = lineFeeds(bytes)
            }
            // A line that was cut (a crash during a write) stays one line:
            // the new line starts on a line of its own.
            cut = bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a
        }
        this.#wrote = false
        if (exists) {
            const added = cut ? `\n${text}` : text
            await this.#adapter.append(path, added)
            this.#keep(added)
        } else {
            this.#lines = 0
            await this.#adapter.write(path, text)
            this.#keep(text)
        }
        this.#wrote = true
    }
}
