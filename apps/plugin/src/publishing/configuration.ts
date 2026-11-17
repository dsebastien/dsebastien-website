// The configuration of the publishing tool. It lives in one file of the
// content store (GATE-04 of the spec). The Rust twin is `cli/src/configuration.rs`.

/** The path of the configuration in the content store. */
export const CONFIGURATION_FILE = 'configuration.json'

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
    const value: unknown = JSON.parse(text)
    const denyList = isRecord(value) ? value['denyList'] : undefined
    if (!Array.isArray(denyList) || !denyList.every((folder) => typeof folder === 'string')) {
        throw new Error(`${CONFIGURATION_FILE}: the deny list must be a list of folders`)
    }
    return { denyList }
}
