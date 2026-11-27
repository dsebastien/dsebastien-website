// The configuration of the publishing tool. It lives in one file of the
// content store (GATE-04 of the spec). The Rust twin is `cli/src/configuration.rs`.

import { parseJson } from './json.ts'

/** The path of the configuration in the content store. */
export const CONFIGURATION_FILE = 'configuration.json'

/** True when the text is a path inside a vault: relative, with `/`, and with no part that leaves a folder. */
export function isVaultPath(path: string): boolean {
    const parts = path.split('/')
    return (
        path !== '' &&
        !path.includes('\\') &&
        parts.every((part) => part !== '' && part !== '.' && part !== '..')
    )
}

export interface Configuration {
    /** The vault folders whose notes can never be published. */
    readonly denyList: readonly string[]
    /**
     * The vault folders whose notes are published but say `noindex` (R103):
     * the site build applies them; the publishing tool only checks them.
     */
    readonly noindexFolders: readonly string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reads the configuration from the text of its file. A content store without
 * the file has an empty deny list. The list `noindexFolders` is optional. It
 * throws when the text is not a valid configuration: a wrong deny list must
 * never be read as an empty one.
 */
export function parseConfiguration(text: string | undefined): Configuration {
    if (text === undefined) {
        return { denyList: [], noindexFolders: [] }
    }
    let value: unknown
    try {
        value = parseJson(text)
    } catch {
        throw new Error(`${CONFIGURATION_FILE} is not JSON`)
    }
    const object = isRecord(value) ? value : {}
    const denyList = foldersOf(object['denyList'], 'deny list')
    // An optional list (R103), but a wrong one is never read as an empty one.
    const noindexFolders =
        'noindexFolders' in object ? foldersOf(object['noindexFolders'], 'noindex folders') : []
    return { denyList, noindexFolders }
}

/** The folders of a list of the configuration, or an error that names the list. */
function foldersOf(list: unknown, name: string): readonly string[] {
    if (
        !Array.isArray(list) ||
        !list.every((folder: unknown): folder is string => typeof folder === 'string')
    ) {
        throw new Error(`${CONFIGURATION_FILE}: the ${name} must be a list of folders`)
    }
    // An entry in another form would match no note: the guard would be open,
    // or the notes of a noindex folder would stay in the index.
    const wrong = list.find((folder) => !isVaultPath(folder))
    if (wrong !== undefined) {
        throw new Error(
            `${CONFIGURATION_FILE}: the ${name} entry "${wrong}" is not a vault path. Write a folder as "Folder/Sub folder"`
        )
    }
    return list
}

/** The text of the configuration. It throws when the copy has none. */
export async function configurationText(device: {
    readonly store: { read(path: string): Promise<string | undefined> }
}): Promise<string> {
    const text = await device.store.read(CONFIGURATION_FILE)
    if (text === undefined) {
        // A wrong folder must never read as a content store with an empty
        // deny list: every private folder would be a candidate (R67).
        throw new Error(
            `the copy of the content store has no ${CONFIGURATION_FILE} in its last commit: the folder is not the copy of the content store, or the content store has no configuration yet. Add ${CONFIGURATION_FILE} with the deny list ("denyList"), commit it and push it`
        )
    }
    return text
}
