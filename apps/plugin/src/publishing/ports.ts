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

/** The copy of the content store on this device. */
export interface ContentStore {
    /**
     * Throws when the folder is not the root of its own git repository, or
     * when the copy has commits that the content store does not have: a
     * publication that git could not take back would else be pushed later.
     * With `fetch`, it fetches the content store first, and throws when the
     * content store cannot be reached. It gives the number of commits of the
     * branch `main` of the content store, at the last fetch, that the copy
     * does not have.
     */
    verify(fetch: boolean): Promise<number>
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

/** The plans of this device. They are stored outside the vault and outside the content of the store. */
export interface PlanStore {
    save(id: string, record: string): Promise<void>
    load(id: string): Promise<string | undefined>
}

/** Everything that a publication needs on one device. */
export interface Device {
    readonly vault: Vault
    readonly store: ContentStore
    readonly attachments: AttachmentStorage
    readonly plans: PlanStore
}
