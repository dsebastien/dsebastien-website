// What the publishing logic needs from the place where it runs. The plugin
// gives the vault of Obsidian. The tests and the parity harness give folders.
// The logic itself never touches a file system, git or Obsidian.

/** One name of a folder of the vault. */
export interface VaultEntry {
    readonly name: string
    readonly kind: 'file' | 'folder'
}

/** The vault: the only source of content. */
export interface Vault {
    /**
     * The files and the folders of one folder of the vault, by their names, in
     * any order. The root is the empty path. A symbolic link is not a file and
     * not a folder of the vault, so it is not in the result.
     */
    list(folder: string): Promise<VaultEntry[]>
    /**
     * The text of the file with exactly this vault path. `undefined` when the
     * vault has no such file: each part of the path must be a name of the
     * folder listing, with the same letter case, and a symbolic link is not a
     * file of the vault. It throws when the file is not valid UTF-8.
     */
    read(path: string): Promise<string | undefined>
    /**
     * The bytes of the file with exactly this vault path, as they are: the
     * same rules as `read`, for a file that is not a note. `undefined` when
     * the vault has no such file. It throws when the file cannot be read.
     */
    readBytes(path: string): Promise<Uint8Array | undefined>
    /** True when the vault has a folder with exactly this vault path, which is not a symbolic link. */
    hasFolder(path: string): Promise<boolean>
    /**
     * Writes the text of a note. A stop of the process during the write never
     * leaves the note empty or half written: the text goes into a hidden file
     * of the same folder first, which is then renamed.
     */
    write(path: string, text: string): Promise<void>
    /**
     * The vault for one run of the tool (`status`, `plan`, `publish`). It lists
     * each folder one time per run and keeps the listing until the end of the
     * run, so a scan does not list the folder of each note again (issue 69).
     * The tool asks for it at the start of each run, and never keeps it for a
     * later run: a folder renamed between two runs must be seen.
     */
    forRun(): Vault
}

/**
 * How a check of the copy reaches the content store: `none` reads no network
 * (`status`), `try` fetches and uses the last fetch when the content store
 * cannot be reached (`plan`), `must` fetches and throws when it cannot
 * (`publish`).
 */
export type Fetch = 'none' | 'try' | 'must'

/** What a check of the copy found. */
export interface Verified {
    /** The number of commits of the branch `main` of the content store, at the last fetch, that the copy does not have. */
    readonly behind: number
    /** False when the check tried to fetch and the content store could not be reached. */
    readonly reached: boolean
}

/** What the copy did with the files of a publication that stopped halfway. */
export type Recovery = 'pushed' | 'undone'

/** The copy of the content store on this device. */
export interface ContentStore {
    /**
     * Throws when the folder is not the root of its own git repository, or
     * when the copy has commits that the content store does not have: a
     * publication that git could not take back would else be pushed later.
     * It fetches the content store first unless `fetch` is `none`.
     */
    verify(fetch: Fetch): Promise<Verified>
    /** The commit of the copy, or `undefined` when the copy has no commit. */
    head(): Promise<string | undefined>
    /**
     * Puts back what a publication that stopped halfway left, by the rules of
     * the run journal (`documentation/Canonical Form.md`, "Failure cases"):
     * `head` is the commit before the run, `paths` are the files that the run
     * could write, and `plan` is the id of its plan, which the message of its
     * commit names. `pushed` when the commit of the run arrived in the content
     * store: nothing is put back. `undone` when each path is as the last
     * commit has it, and a commit of the run that did not arrive is taken
     * back. Throws when the copy is not the root of its own git repository,
     * when its history cannot be put back by the rules, or when the tool must
     * know whether the push arrived and the content store cannot be reached.
     * It calls `ownLock` before each step that writes into the copy, and stops
     * with its error when the lock of the run is not its own any more.
     */
    recover(
        head: string | undefined,
        paths: readonly string[],
        plan: string,
        ownLock: () => Promise<void>
    ): Promise<Recovery>
    /**
     * The text of a file, by its path in the content store. `undefined` only
     * when there is no such file. It throws when the file cannot be read or is
     * not valid UTF-8: a file that cannot be read is never taken for a
     * missing one. It throws when a part of the path is a symbolic link.
     */
    read(path: string): Promise<string | undefined>
    /**
     * The files of a folder, one level, as paths in the content store, in the
     * order of the code points. A folder below it and a symbolic link are not
     * in the result. It throws when a part of the path of the folder is a
     * symbolic link.
     */
    list(folder: string): Promise<string[]>
    write(path: string, text: string): Promise<void>
    /** Removes a file. True when the file existed. */
    remove(path: string): Promise<boolean>
    /**
     * Puts exactly these files in one commit and pushes it, without force. A
     * file that was removed is removed by the commit. When the commit fails or
     * the push is refused, it takes the commit back and unstages these paths,
     * and throws. It leaves the files of the copy as they are: the tool puts
     * them back. Other staged work of the copy stays staged.
     */
    commitAndPush(message: string, paths: readonly string[]): Promise<void>
}

/**
 * The attachment storage: an object storage on the host, a folder on a device
 * and in the tests. Its files are named by their keys: the 64 hexadecimal
 * digits of the SHA-256 of their bytes.
 */
export interface AttachmentStorage {
    /** The names of the files of the storage, in any order. A folder and a symbolic link are not files of it. */
    list(): Promise<string[]>
    /** Stores the bytes under the key. The file is complete or does not exist: never a part of it. */
    put(key: string, bytes: Uint8Array): Promise<void>
    /** Removes the file of this name. True when the file existed. */
    remove(name: string): Promise<boolean>
}

/**
 * Who holds the lock of the device: a publication, with its device, its face
 * and its time, or a plan while it puts the copy back.
 */
export type LockHolder =
    | {
          readonly command: 'publish'
          readonly device: string
          readonly face: string
          readonly time: string
      }
    | { readonly command: 'plan' }

/**
 * The files of this device: the plans, the lock and the run journal. They are
 * stored outside the vault and outside the content of the store.
 */
export interface LocalStore {
    save(id: string, record: string): Promise<void>
    load(id: string): Promise<string | undefined>
    /**
     * Takes the lock of the device for a run, in one create: the file is made
     * only when no lock exists, with the holder and the id of the process.
     * `taken` with the text that it wrote, or not `taken` with the text of the
     * lock that is there. It throws when the folder is not a copy: it makes
     * no `.git` folder.
     */
    lock(holder: LockHolder): Promise<{ readonly taken: boolean; readonly text: string }>
    /** Removes the lock only when it still holds this text: a run never removes the lock of another run. */
    release(text: string): Promise<void>
    /** The text of the lock, or `undefined` when no lock exists. */
    readLock(): Promise<string | undefined>
    /** Removes the lock. True when a lock existed. */
    unlock(): Promise<boolean>
    saveJournal(text: string): Promise<void>
    /** The text of the run journal, or `undefined` when there is none. */
    loadJournal(): Promise<string | undefined>
    removeJournal(): Promise<void>
}

/**
 * The Obsidian Starter Kit of the vault, which knows the note type of each
 * note (decision R61): its API in Obsidian, a file of answers in the tests.
 */
export interface NoteTypes {
    /**
     * The answer of the Starter Kit for these vault paths, as data: the
     * document of `recognizeNoteTypes` (`documentation/Canonical Form.md`,
     * "The note type of a note"). The logic reads it strictly. It throws when
     * the Starter Kit is missing or fails.
     */
    recognize(paths: readonly string[]): Promise<unknown>
}

/** Everything that a publication needs on one device. */
export interface Device {
    readonly vault: Vault
    readonly store: ContentStore
    readonly attachments: AttachmentStorage
    readonly local: LocalStore
    readonly noteTypes: NoteTypes
}
