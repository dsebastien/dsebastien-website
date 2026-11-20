import { extractFrontmatter } from '@astrojs/markdown-remark'
import { parseDocument } from 'yaml'

// The properties of a cleaned note, as the build reads them (issue 48, R59).
//
// The reader of a content collection of Astro turns a date of the properties
// into a moment in UTC. That loses what the vault writes: a time with a time
// zone shows another hour and sometimes another day, a time at midnight loses
// its time, and a day that the calendar does not have becomes another day. So
// the build reads the properties itself, with the same reader and the same
// rules as Astro but for one: a date stays a text. The panel and the title
// band then show a date as the vault writes it (R58, R59).

/**
 * The properties of a cleaned note, in the order of the note. A note without
 * properties, or whose properties are no list of keys, has none.
 *
 * @param source the text of the cleaned note
 */
export function readProperties(source: string): Readonly<Record<string, unknown>> {
    const yaml = extractFrontmatter(source)
    if (yaml === undefined) {
        return {}
    }
    // The options of the reader of Astro (`parseYaml`), without its tag for dates.
    const document = parseDocument(yaml, { merge: true, schema: 'core' })
    const [error] = document.errors
    if (error !== undefined) {
        throw error
    }
    const properties: unknown = document.toJS()
    return typeof properties === 'object' && properties !== null && !Array.isArray(properties)
        ? (properties as Readonly<Record<string, unknown>>)
        : {}
}
