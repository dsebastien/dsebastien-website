// The resolver (MOD-05 of the spec): a pure function, in plain TypeScript, so
// that it runs in tests, at the edge and on a plain server (HOST-02). The rules
// are in `documentation/Configuration.md`, section "The URL contract".

/** A file of the site that is not a page: the Markdown of a note, or a text file. */
export interface SiteFile {
    readonly file: string
    readonly type: 'markdown' | 'text'
}

/** What the build knows about the paths of the site. The build writes it, and the resolver reads it. */
export interface ResolverMap {
    /** The file of the page of each canonical path, relative to the output of the build. */
    readonly pages: Readonly<Record<string, string>>
    /** The files of the site that are not pages, by their path: `/robots.txt`, the Markdown of each note. */
    readonly files?: Readonly<Record<string, SiteFile>>
    /** The key in the attachment storage of each hashed path of an attachment that a page uses. */
    readonly attachments?: Readonly<Record<string, string>>
    /** The canonical path of each note and of each folder, by the folded form of its text (the vault path without `.md`). */
    readonly folded?: Readonly<Record<string, string>>
    /** The canonical paths of the notes of each file name, by the folded form of the name. */
    readonly names?: Readonly<Record<string, readonly string[]>>
    /** The canonical paths of the notes of each alias, by the folded form of the alias. */
    readonly aliases?: Readonly<Record<string, readonly string[]>>
    /** The file of the "not found" page that names several notes, by their canonical paths joined with line feeds. */
    readonly choices?: Readonly<Record<string, string>>
    /** The file of the "not found" page. */
    readonly notFound?: string
}

/** What a requested path leads to. A later slice adds "gone" (410). */
export type Resolution =
    | { kind: 'page'; file: string }
    | { kind: 'file'; file: string; type: 'markdown' | 'text' }
    | { kind: 'attachment'; key: string; name: string }
    | { kind: 'redirect'; status: 301 | 302; location: string; cacheControl: string }
    | { kind: 'not-found'; suggestions: string[]; file?: string }

/**
 * How long a client keeps a redirect: a variant of the syntax, a file name
 * alone, an alias (decision R47). A variant is kept one hour only: after a
 * rename in letter case, a redirect that a browser kept would else loop.
 */
const CACHE = {
    variant: 'public, max-age=3600',
    name: 'public, max-age=3600',
    alias: 'no-store'
} as const

/** The prefix of the generated pages and files. A path under it has no variant (URL-26). */
const PREFIX = '/-/'

/**
 * The folded form of a text: the composed Unicode form, then small letters.
 * It is the rule of the publishing tool (`apps/plugin/src/publishing/names.ts`
 * and `cli/src/names.rs`), which stops a plan when two published paths have one
 * folded form. The shared cases of `fixtures/canonical/names.json` check it.
 */
export function foldedForm(text: string): string {
    return text.normalize('NFC').toLowerCase()
}

/** The value of a key of a record, when the record has it as its own: a path such as "constructor" is no key. */
function own<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
    return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined
}

/**
 * The texts that a requested path can mean, in their order (URL-03): first
 * `+` as a space, then `+` as itself, then also `%2B` as a space. A text has
 * no slash at its start. `undefined` for a reading whose percent-encoding is
 * not valid UTF-8.
 */
function readingsOf(path: string): string[] {
    const decode = (text: string): string | undefined => {
        try {
            return decodeURIComponent(text)
        } catch {
            return undefined
        }
    }
    const readings = [
        decode(path.replaceAll('+', '%20')),
        decode(path),
        decode(path.replaceAll(/%2B/giu, '%20').replaceAll('+', '%20'))
    ]
    return [...new Set(readings.filter((text) => text !== undefined))].map((text) => text.slice(1))
}

/** The forms of a text without a slash at its end and without a `.md` suffix, in this order, each one time. */
function formsOf(text: string): string[] {
    const forms = [text]
    let form = text
    if (form.endsWith('/')) {
        form = form.slice(0, -1)
        forms.push(form)
    }
    if (form.toLowerCase().endsWith('.md')) {
        forms.push(form.slice(0, -'.md'.length))
    }
    return [...new Set(forms)]
}

/** The answer for the notes of a file name or of an alias: one note is a redirect, more are the "not found" page with them. */
function toNotes(
    paths: readonly string[],
    status: 301 | 302,
    cacheControl: string,
    query: string,
    map: ResolverMap
): Resolution {
    const [only] = paths
    if (paths.length === 1 && only !== undefined) {
        return { kind: 'redirect', status, location: only + query, cacheControl }
    }
    const file = own(map.choices, paths.join('\n'))
    return { kind: 'not-found', suggestions: [...paths], ...(file === undefined ? {} : { file }) }
}

/**
 * Resolves a requested path (URL-02 to URL-05 of the spec).
 *
 * The path is read as it is requested, with its percent-encoding. A path of
 * the map is the answer. Else the resolver reads the path in each of its
 * readings (URL-03) and looks, in this order, for a note or a folder with that
 * text in any letter case and Unicode form (301), a file name (301, kept one
 * hour), and an alias (302) (URL-04). A slash at the end and a `.md` suffix
 * are left out. A name or an alias of several notes gives the "not found" page
 * with those notes. A path under `/-/` has no variant.
 *
 * @param query the query of the request, with its `?`, or nothing. A
 * redirect keeps it, so that the parameters of analytics survive (URL-12).
 */
export function resolve(path: string, map: ResolverMap, query = ''): Resolution {
    const page = own(map.pages, path)
    if (page !== undefined) {
        return { kind: 'page', file: page }
    }
    const file = own(map.files, path)
    if (file !== undefined) {
        return { kind: 'file', file: file.file, type: file.type }
    }
    const key = own(map.attachments, path)
    if (key !== undefined) {
        // The name gives the kind of the file. The map holds only paths that
        // the build wrote, so the name decodes.
        return {
            kind: 'attachment',
            key,
            name: decodeURIComponent(path.slice(path.lastIndexOf('/') + 1))
        }
    }
    const notFound: Resolution = {
        kind: 'not-found',
        suggestions: [],
        ...(map.notFound === undefined ? {} : { file: map.notFound })
    }
    if (path.startsWith(PREFIX)) {
        return notFound
    }
    for (const reading of readingsOf(path)) {
        const forms = formsOf(reading).map(foldedForm)
        for (const form of forms) {
            const target = own(map.folded, form)
            if (target !== undefined) {
                return {
                    kind: 'redirect',
                    status: 301,
                    location: target + query,
                    cacheControl: CACHE.variant
                }
            }
        }
        for (const form of forms) {
            const notes = form.includes('/') ? undefined : own(map.names, form)
            if (notes !== undefined) {
                return toNotes(notes, 301, CACHE.name, query, map)
            }
        }
        for (const form of forms) {
            const notes = own(map.aliases, form)
            if (notes !== undefined) {
                return toNotes(notes, 302, CACHE.alias, query, map)
            }
        }
    }
    return notFound
}
