import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// The fixture vault is at the root of the repository, in `fixtures/`, because
// no implementation owns it: the TypeScript tests read it through this module,
// and the Rust tests through `cli/tests/support/mod.rs`.

/** The folder that holds the fixture vault, its configuration and its catalog. */
export const FIXTURES = fileURLToPath(new URL('../../../fixtures', import.meta.url))

/** The fixture vault: invented notes only. A test never writes into it. */
export const FIXTURE_VAULT = join(FIXTURES, 'vault')

/** The invented configuration of the publishing tool for the fixture vault. */
export const FIXTURE_CONFIGURATION = join(FIXTURES, 'configuration.json')

/** The list that says which feature or trap each file of the fixture vault serves. */
export const FIXTURE_CATALOG = join(FIXTURES, 'catalog.json')

/**
 * The answers of an invented Obsidian Starter Kit for the fixture vault: the
 * note type of each note (decision R61). A device of the tests reads it with
 * `fileNoteTypes()` of the publishing logic.
 */
export const FIXTURE_NOTE_TYPES = join(FIXTURES, 'note-types.json')

/**
 * A recorded store catalog (`products-light.json`) with invented products, in
 * the shape of the store: the input of the catalog shape test (TEST-04) and of
 * the ads of the fixture site (SEAM-05, SEAM-06).
 */
export const FIXTURE_STORE_CATALOG = join(FIXTURES, 'store-catalog.json')

/** One entry of the catalog: a feature or a trap, and the files that serve it. */
export interface FixtureCatalogEntry {
    /** A short name, stable, used by the tests. */
    id: string
    /** The feature or the trap of the spec, in one sentence. */
    covers: string
    /** Paths relative to the fixture vault, with `/` as the separator. */
    files: string[]
    /** What is not settled yet, when a later ticket must correct the files. */
    open?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function toEntry(value: unknown): FixtureCatalogEntry {
    if (!isRecord(value)) {
        throw new Error('an entry of the fixture catalog is not an object')
    }
    const { id, covers, files, open } = value
    if (typeof id !== 'string' || typeof covers !== 'string' || !isStringArray(files)) {
        throw new Error(`an entry of the fixture catalog is not valid: ${JSON.stringify(value)}`)
    }
    return typeof open === 'string' ? { id, covers, files, open } : { id, covers, files }
}

/** Reads the catalog of the fixture vault. Throws when its shape is wrong. */
export async function readFixtureCatalog(): Promise<FixtureCatalogEntry[]> {
    const catalog: unknown = await Bun.file(FIXTURE_CATALOG).json()
    const entries = isRecord(catalog) ? catalog['entries'] : undefined
    if (!Array.isArray(entries)) {
        throw new Error('the fixture catalog has no list of entries')
    }
    return entries.map(toEntry)
}

/** Every file of the fixture vault: sorted paths relative to it, with `/` as the separator. */
export async function listFixtureVaultFiles(): Promise<string[]> {
    const entries = await readdir(FIXTURE_VAULT, { recursive: true, withFileTypes: true })
    return entries
        .filter((entry) => entry.isFile())
        .map((entry) => relative(FIXTURE_VAULT, join(entry.parentPath, entry.name)))
        .map((path) => path.split(sep).join('/'))
        .sort()
}
