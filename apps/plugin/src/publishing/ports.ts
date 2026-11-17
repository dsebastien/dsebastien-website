// What the publishing logic needs from the place where it runs. The plugin
// gives the vault of Obsidian. The tests and the parity harness give folders.
// The logic itself never touches a file system, git or Obsidian.

/** The vault: the only source of content. */
export interface Vault {
    /** The text of a file, by its vault path. `undefined` when there is no such file. */
    read(path: string): Promise<string | undefined>
    write(path: string, text: string): Promise<void>
}

/** The copy of the content store on this device. */
export interface ContentStore {
    /** The text of a file, by its path in the content store. `undefined` when there is no such file. */
    read(path: string): Promise<string | undefined>
    /** The files below a folder, as paths in the content store, in the order of the code points. */
    list(folder: string): Promise<string[]>
    write(path: string, text: string): Promise<void>
    /** Puts every change in one commit and pushes it, without force. It throws when the push is refused. */
    commitAndPush(message: string): Promise<void>
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
