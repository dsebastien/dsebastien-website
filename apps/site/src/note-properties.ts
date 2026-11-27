import { extractFrontmatter } from '@astrojs/markdown-remark'
import { parseDocument, type ScalarTag } from 'yaml'

// The properties of a cleaned note, as the build reads them (issue 48, R59).
//
// The reader of a content collection of Astro turns a date of the properties
// into a moment in UTC. That loses what the vault writes: a time with a time
// zone shows another hour and sometimes another day, a time at midnight loses
// its time, and a day that the calendar does not have becomes another day. So
// the build reads the properties itself, with the same reader and the same
// rules as Astro but for one: a date stays a text. The panel and the title
// band then show a date as the vault writes it (R58, R59).

/** The tag `!!timestamp` of a property, read as the text that the note writes. */
const TIMESTAMP_AS_TEXT: ScalarTag = {
    tag: 'tag:yaml.org,2002:timestamp',
    resolve: (text) => text
}

/** A note that starts with a block between `+++` lines, as the reader of Astro finds it. */
const TOML_BLOCK = /^\uFEFF?\s*\+\+\+/u

/**
 * The properties of a cleaned note, in the order of the note. A note without
 * properties, or whose properties are no list of keys, has none. It throws
 * for properties that cannot be read, as the reader of Astro does. One case
 * is new: a date is a text, so one date as a key with and without quotes is
 * the same key two times.
 *
 * @param source the text of the cleaned note
 */
export function readProperties(source: string): Readonly<Record<string, unknown>> {
    // Obsidian reads properties between `---` lines only. Astro also finds a
    // TOML block between `+++` lines: for the site that block is no property.
    if (TOML_BLOCK.test(source)) {
        return {}
    }
    const yaml = extractFrontmatter(source)
    if (yaml === undefined) {
        return {}
    }
    // The options of the reader of Astro (`parseYaml`), without its tag for
    // dates. The reader still knows the tag `!!timestamp` when a note writes
    // it: that date stays a text too (issue 93).
    const document = parseDocument(yaml, {
        merge: true,
        schema: 'core',
        customTags: [TIMESTAMP_AS_TEXT]
    })
    const [error] = document.errors
    if (error !== undefined) {
        throw error
    }
    const properties: unknown = document.toJS()
    return typeof properties === 'object' && properties !== null && !Array.isArray(properties)
        ? (properties as Readonly<Record<string, unknown>>)
        : {}
}

/**
 * A published note of a site, with the digest of its cleaned note, when the
 * content collection gives one.
 */
export interface NoteOfSite {
    readonly vaultPath: string
    readonly digest?: string | number
}

/** The properties of a note, with the digest that they were read for. */
interface Kept {
    readonly digest: string | number
    readonly properties: Readonly<Record<string, unknown>>
}

/**
 * The properties of the notes of a site, kept between two reads (issue 93).
 * The dev server makes the site at each request: a note whose digest did not
 * change keeps its properties, so a request reads only the notes that
 * changed. A note with no digest is read each time. A build reads one time.
 */
export class NoteProperties {
    #kept = new Map<string, Kept>()

    /**
     * The properties of these notes, by vault path. A note that is not in the
     * list is forgotten.
     *
     * @param notes the published notes of the site
     * @param source the text of the cleaned note of a vault path
     * @throws when the properties of a note cannot be read, with its vault path
     */
    async read(
        notes: readonly NoteOfSite[],
        source: (vaultPath: string) => Promise<string>
    ): Promise<Map<string, Readonly<Record<string, unknown>>>> {
        const read = new Map<string, Readonly<Record<string, unknown>>>()
        const kept = new Map<string, Kept>()
        for (const { vaultPath, digest } of notes) {
            const known = this.#kept.get(vaultPath)
            let properties: Readonly<Record<string, unknown>>
            if (known !== undefined && digest !== undefined && known.digest === digest) {
                properties = known.properties
            } else {
                const text = await source(vaultPath)
                try {
                    properties = readProperties(text)
                } catch (error) {
                    // The build stops, and says which note the author must correct.
                    throw new Error(
                        `the properties of "${vaultPath}" cannot be read: ${error instanceof Error ? error.message : String(error)}`,
                        { cause: error }
                    )
                }
            }
            read.set(vaultPath, properties)
            if (digest !== undefined) {
                kept.set(vaultPath, { digest, properties })
            }
        }
        this.#kept = kept
        return read
    }
}
