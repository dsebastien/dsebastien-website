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
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reads the configuration from the text of its file. A content store without
 * the file has an empty deny list. It throws when the text is not a valid
 * configuration: a wrong deny list must never be read as an empty one.
 */
export function parseConfiguration(text: string | undefined): Configuration {
    if (text === undefined) {
        return { denyList: [] }
    }
    let value: unknown
    try {
        value = parseJson(text)
    } catch {
        throw new Error(`${CONFIGURATION_FILE} is not JSON`)
    }
    const denyList = isRecord(value) ? value['denyList'] : undefined
    if (!Array.isArray(denyList) || !denyList.every((folder) => typeof folder === 'string')) {
        throw new Error(`${CONFIGURATION_FILE}: the deny list must be a list of folders`)
    }
    // An entry in another form would match no note, and the guard would be open.
    const wrong = denyList.find((folder) => !isVaultPath(folder))
    if (wrong !== undefined) {
        throw new Error(
            `${CONFIGURATION_FILE}: the deny list entry "${wrong}" is not a vault path. Write a folder as "Folder/Sub folder"`
        )
    }
    return { denyList }
}
