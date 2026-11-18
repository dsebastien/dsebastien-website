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
    /** True when the vault has a folder with exactly this vault path, which is not a symbolic link. */
    hasFolder(path: string): Promise<boolean>
    write(path: string, text: string): Promise<void>
}

/** The copy of the content store on this device. */
export interface ContentStore {
    /**
     * Throws when the folder is not the root of its own git repository, or
     * when the copy has commits that the content store does not have: a
     * publication that git could not take back would else be pushed later.
     */
    verify(): Promise<void>
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

/** The plans of this device. They are stored outside the vault and outside the content of the store. */
export interface PlanStore {
    save(id: string, record: string): Promise<void>
    load(id: string): Promise<string | undefined>
}

/** Everything that a publication needs on one device. */
export interface Device {
    readonly vault: Vault
    readonly store: ContentStore
    readonly plans: PlanStore
}
