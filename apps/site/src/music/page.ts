import { DEFAULT_PROPERTY_NAMES } from '@dsebastien/music-notation'

// What the build writes into a note page with music blocks (REN-07): the
// properties of the note that an empty block draws from, as on the current
// site (a chord, a scale, an arpeggio, a strumming or a picking pattern
// note). Every property of a note is public (business rule 14); the page
// holds only the ones that the library reads, in a data block that runs
// nothing, so the Content Security Policy needs no hash for it.

/** The names of the properties that the library reads. */
const NAMES: ReadonlySet<string> = new Set(Object.values(DEFAULT_PROPERTY_NAMES))

/**
 * The properties of a note that its empty music blocks draw from; `undefined`
 * when the note has none of them but its tags (the tags alone draw nothing).
 */
export function musicProperties(
    properties: Readonly<Record<string, unknown>>
): Record<string, unknown> | undefined {
    const kept = Object.entries(properties).filter(([name]) => NAMES.has(name))
    if (!kept.some(([name]) => name !== DEFAULT_PROPERTY_NAMES.tags)) return undefined
    return Object.fromEntries(kept)
}

/** The text of the data block of some properties: JSON that no `<` can end early. */
export function propertiesText(properties: Readonly<Record<string, unknown>>): string {
    return JSON.stringify(properties).replaceAll('<', '\\u003c')
}
