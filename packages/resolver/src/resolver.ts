import { sha256Hex } from './sha256.ts'
import { smallLetters } from './small-letters.ts'

// The resolver (MOD-05 of the spec): a pure function, in plain TypeScript, so
// that it runs in tests, at the edge and on a plain server (HOST-02). The rules
// are in `documentation/Configuration.md`, section "The URL contract".

/** The kinds of the files of the site that are not pages. */
export type SiteFileType = 'markdown' | 'text' | 'icon'

/** A file of the site that is not a page: the Markdown of a note, a text file, or the icon of the site. */
export interface SiteFile {
    readonly file: string
    readonly type: SiteFileType
}

/** What the build knows about the paths of the site. The build writes it, and the resolver reads it. */
export interface ResolverMap {
    /** The file of the page of each canonical path, relative to the output of the build. */
    readonly pages: Readonly<Record<string, string>>
    /** The files of the site that are not pages, by their path: `/robots.txt`, `/favicon.ico`, the Markdown of each note. */
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
    /** The addresses of the notes that the author unpublished (URL-27). */
    readonly gone?: GoneMap
    /** The former paths of the published notes that moved (URL-06, URL-21). */
    readonly former?: FormerMap
    /** The rows of the redirect list of the content store (issue 44): old paths and old folders. */
    readonly redirects?: RedirectMap
}

/**
 * The rows of the redirect list that lead somewhere (issue 44, section 10.3
 * of the spec): the old addresses of the current site that no other rule
 * finds. The gone rows of the list are in the gone part, as keys.
 */
export interface RedirectMap {
    /**
     * The length of the longest folded old path of the parts, in UTF-16
     * units: a longer text of a request is never hashed.
     */
    readonly longest: number
    /**
     * The target of each old path, by the key (`goneKey()`) of its folded
     * form (the old path, decoded, without `.md`): the map holds no old path
     * as text.
     */
    readonly folded: Readonly<Record<string, string>>
    /**
     * The target of each old folder, by the key of its folded form with a
     * slash at its end. A path under one of them leads to the target of the
     * longest one, when no other rule finds the path (RES-04).
     */
    readonly prefixes: Readonly<Record<string, string>>
    /**
     * The lengths of the folded old folders of `prefixes`, the longest first:
     * the resolver hashes only the folders of a request of these lengths.
     */
    readonly prefixLengths: readonly number[]
    /**
     * The keys of `folded` and `prefixes` whose target the build reached
     * through an alias: their answer is the one of an alias (302, not kept,
     * R47), as a note can take the alias later.
     */
    readonly temporary: Readonly<Record<string, true>>
    /** What the build did with the rows: numbers only, for the warning of the build and the parity run. */
    readonly counts: Readonly<Record<string, number>>
}

/**
 * The former paths of the published notes that moved (decision R66). The
 * resolver reads them after the current paths and folders, and before the
 * file names and the aliases: a former path was the canonical URL of a note
 * (business rule 1).
 */
export interface FormerMap {
    /** The canonical paths of the notes of each former text (the old vault path without `.md`), by its folded form. */
    readonly folded: Readonly<Record<string, readonly string[]>>
    /** The canonical paths of the notes of each former file name, by its folded form. */
    readonly names: Readonly<Record<string, readonly string[]>>
    /** The Markdown path of the note of each former Markdown path, as written. */
    readonly markdown: Readonly<Record<string, string>>
    /**
     * The target of each former folder whose notes all moved to one folder,
     * by its folded form (decision of the author R79): the folder note of
     * that folder, or its folder page.
     */
    readonly folders?: Readonly<Record<string, string>>
}

/**
 * The addresses of the unpublished notes, apart from the rest of the map: the
 * resolver reads them only when no published note, folder or page has the
 * path, so a published note always wins (decision R64). Each part is a set of
 * keys (`goneKey()`), never of texts: the map holds no title and no alias of
 * an unpublished note.
 */
export interface GoneMap {
    /** The file of the gone page. */
    readonly file?: string
    /**
     * The length of the longest text of the sets, in UTF-16 units: a longer
     * text of a request is never hashed, so a long path costs no hash.
     */
    readonly longest: number
    /** The canonical path and the Markdown path of each unpublished note and of each of its former paths, as written. */
    readonly paths: Readonly<Record<string, true>>
    /** The folded form of the text of each unpublished note and of each of its former paths. */
    readonly folded: Readonly<Record<string, true>>
    /** The folded form of the file name of each unpublished note and of each of its former paths. */
    readonly names: Readonly<Record<string, true>>
    /** The folded form of each alias of an unpublished note. */
    readonly aliases: Readonly<Record<string, true>>
}

/**
 * The key of a text in the gone part of the map: 32 hexadecimal digits of its
 * SHA-256. The resolver only asks whether a text is in a set, so the key is
 * enough, and a release that leaks the map shows no title (decision R64).
 */
export function goneKey(text: string): string {
    return sha256Hex(text).slice(0, 32)
}

/**
 * The keys of the texts of one request: a text that the gone part, the
 * redirect list and the prefix rules all look for is hashed one time. The
 * resolver starts a new one for each request, so the memory stays small.
 */
let requestKeys = new Map<string, string>()

/** The key of a text of the request, from the keys of the request when it was hashed already. */
function keyOf(text: string): string {
    let key = requestKeys.get(text)
    if (key === undefined) {
        key = goneKey(text)
        requestKeys.set(text, key)
    }
    return key
}

/** What a requested path leads to. */
export type Resolution =
    | { kind: 'page'; file: string }
    | { kind: 'file'; file: string; type: SiteFileType }
    | { kind: 'attachment'; key: string; name: string }
    | { kind: 'redirect'; status: 301 | 302; location: string; cacheControl: string }
    | { kind: 'not-found'; suggestions: string[]; file?: string }
    | { kind: 'gone'; file?: string }

/**
 * How long a client keeps a redirect: a variant of the syntax, a file name
 * alone, an alias (decision R47). A variant is kept one hour only: after a
 * rename in letter case, a redirect that a browser kept loops for that hour
 * at most.
 */
const CACHE = {
    variant: 'public, max-age=3600',
    name: 'public, max-age=3600',
    alias: 'no-store',
    // A former path can be taken again by a note or come back: one hour.
    former: 'public, max-age=3600'
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
    // NFC again: a small letter can make a pair that NFC composes (J and U+030C).
    return smallLetters(text.normalize('NFC')).normalize('NFC')
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
export function readingsOf(path: string): string[] {
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
    if (smallLetters(form).endsWith('.md')) {
        forms.push(form.slice(0, -'.md'.length))
    }
    return [...new Set(forms)]
}

/** A location with the query of the request: after the query of the location, when it has one. */
function withQuery(location: string, query: string): string {
    if (query === '') {
        return location
    }
    return location.includes('?') ? `${location}&${query.slice(1)}` : location + query
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
 * text in any letter case and Unicode form (301), a former path of a note that
 * moved (301, kept one hour, URL-21), a file name (301, kept one hour), and an
 * alias (302) (URL-04); then, in every reading, for a former file name (301).
 * The former Markdown path of a note answers 301 to its Markdown. A slash at the end and a `.md` suffix
 * are left out. A name or an alias of several notes gives the "not found" page
 * with those notes. A path under `/-/` has no variant.
 *
 * Only when no published note, folder or page has the path: the canonical
 * path, the Markdown path, a variant, the file name or an alias of a note
 * that the author unpublished is "gone" (410, URL-27, decision R64).
 *
 * @param query the query of the request, with its `?`, or nothing. A
 * redirect keeps it, so that the parameters of analytics survive (URL-12).
 */
export function resolve(path: string, map: ResolverMap, query = ''): Resolution {
    requestKeys = new Map()
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
    const gone: Resolution = {
        kind: 'gone',
        ...(map.gone?.file === undefined ? {} : { file: map.gone.file })
    }
    if (path.startsWith(PREFIX)) {
        // The Markdown of a note that moved, as its old path was written.
        const markdown = own(map.former?.markdown, path)
        if (markdown !== undefined) {
            return {
                kind: 'redirect',
                status: 301,
                location: markdown + query,
                cacheControl: CACHE.former
            }
        }
        return isGonePath(path, map.gone) ? gone : notFound
    }
    const published = resolvePublished(readingsOf(path), map, query)
    if (published !== undefined) {
        return published
    }
    if (isGone(path, map.gone)) {
        return gone
    }
    return withEncodedQuery(path, map, query, gone) ?? underOldFolder(path, map, query) ?? notFound
}

/**
 * The answer for a query encoded into the path (RES-02): the text before the
 * first `?` of a reading, looked for one time among the published addresses
 * and the redirect list. It comes after the gone addresses: a name with a
 * question mark is a name, so an unpublished note "Why?" stays gone.
 */
function withEncodedQuery(
    path: string,
    map: ResolverMap,
    query: string,
    gone: Resolution
): Resolution | undefined {
    for (const reading of readingsOf(path)) {
        const at = reading.indexOf('?')
        if (at > 0) {
            const found = resolvePublished(
                [reading.slice(0, at)],
                map,
                encodedQuery(reading.slice(at + 1), query)
            )
            if (found?.kind === 'redirect') {
                return found
            }
            // The text before the query is the address of an unpublished
            // note only when no published address and no row has it.
            if (isGoneForm(formsOf(reading.slice(0, at)).map(foldedForm), map.gone)) {
                return gone
            }
        }
    }
    return undefined
}

/**
 * The answer of a row of the redirect list, by the key of its old path: a
 * 301 kept one hour, or the answer of an alias when the build reached the
 * target through an alias.
 */
function listAnswer(
    redirects: RedirectMap,
    key: string,
    location: string,
    query: string
): Resolution {
    return Object.hasOwn(redirects.temporary, key)
        ? {
              kind: 'redirect',
              status: 302,
              location: withQuery(location, query),
              cacheControl: CACHE.alias
          }
        : {
              kind: 'redirect',
              status: 301,
              location: withQuery(location, query),
              cacheControl: CACHE.former
          }
}

/** The target of an old path of the redirect list, by the key of its folded form. */
function redirectOf(form: string, redirects: RedirectMap | undefined): string | undefined {
    return redirects === undefined || form.length > redirects.longest
        ? undefined
        : own(redirects.folded, keyOf(form))
}

/**
 * The answer of a prefix rule of the redirect list for a path under an old
 * folder (RES-04): after every exact address and after the gone addresses,
 * so a row of the list and an unpublished note under the folder win. The
 * longest prefix wins. The folder itself is no address of the rule.
 */
function underOldFolder(path: string, map: ResolverMap, query: string): Resolution | undefined {
    const redirects = map.redirects
    if (redirects === undefined || redirects.prefixLengths.length === 0) {
        return undefined
    }
    // The text before a query that is encoded into the path (RES-02), with
    // that query as a real query: as for an exact address.
    const heads: [string, string][] = readingsOf(path).map((reading) => {
        const at = reading.indexOf('?')
        return at > 0
            ? [reading.slice(0, at), encodedQuery(reading.slice(at + 1), query)]
            : [reading, query]
    })
    const forms: [string, string][] = []
    for (const [head, kept] of heads) {
        for (const form of formsOf(head).map(foldedForm)) {
            forms.push([form, kept])
        }
    }
    // The folders of the request of each length of a prefix, the longest
    // first, each one time. The form itself is no folder of it: something
    // must follow the slash.
    for (const length of redirects.prefixLengths) {
        const seen = new Set<string>()
        for (const [form, kept] of forms) {
            if (form.length <= length || form[length - 1] !== '/') {
                continue
            }
            const folder = form.slice(0, length)
            if (seen.has(folder)) {
                continue
            }
            seen.add(folder)
            const key = keyOf(folder)
            const location = own(redirects.prefixes, key)
            if (location !== undefined) {
                return listAnswer(redirects, key, location, kept)
            }
        }
    }
    return undefined
}

/**
 * The query that a path holds in its text, encoded into the path by a site
 * that linked to the current site (`Note%3Fref%3Dsite`, RES-02), as a real
 * query, then the query of the request.
 */
function encodedQuery(text: string, query: string): string {
    const encoded = new URLSearchParams(text).toString()
    const request = query === '' ? '' : query.slice(1)
    return `?${[encoded, request].filter((part) => part !== '').join('&')}`
}

/**
 * The answer of the published notes and folders, the former paths and the
 * redirect list for the readings of a path outside the prefix, or
 * `undefined` when none has it.
 */
function resolvePublished(
    readings: readonly string[],
    map: ResolverMap,
    query: string
): Resolution | undefined {
    for (const reading of readings) {
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
        // A former path of a note that moved (URL-21).
        for (const form of forms) {
            const notes = own(map.former?.folded, form)
            if (notes !== undefined) {
                return toNotes(notes, 301, CACHE.former, query, map)
            }
        }
        // An old path of the redirect list (issue 44): it wins over a file
        // name and an alias, and over an address of an unpublished note.
        for (const form of forms) {
            const location = redirectOf(form, map.redirects)
            if (location !== undefined && map.redirects !== undefined) {
                return listAnswer(map.redirects, keyOf(form), location, query)
            }
        }
        // A row of the redirect list wins over a former folder: the author wrote it.
        // A former folder whose notes all moved to one folder (R79).
        for (const form of forms) {
            const target = own(map.former?.folders, form)
            if (target !== undefined) {
                return {
                    kind: 'redirect',
                    status: 301,
                    location: target + query,
                    cacheControl: CACHE.former
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
    // A former file name comes after every current address.
    for (const reading of readings) {
        for (const form of formsOf(reading).map(foldedForm)) {
            const notes = form.includes('/') ? undefined : own(map.former?.names, form)
            if (notes !== undefined) {
                return toNotes(notes, 301, CACHE.former, query, map)
            }
        }
    }
    return undefined
}

/** True when a path, in one of its readings and forms, is the text, the file name or an alias of an unpublished note (decision R64). */
function isGone(path: string, gone: GoneMap | undefined): boolean {
    if (gone === undefined) {
        return false
    }
    if (isGonePath(path, gone)) {
        return true
    }
    return isGoneForm(
        readingsOf(path).flatMap((reading) => formsOf(reading).map(foldedForm)),
        gone
    )
}

/** True when a folded form is the text, the file name or an alias of an unpublished note. */
function isGoneForm(forms: readonly string[], gone: GoneMap | undefined): boolean {
    if (gone === undefined) {
        return false
    }
    for (const form of new Set(forms)) {
        if (form.length > gone.longest) {
            continue
        }
        const key = keyOf(form)
        if (
            own(gone.folded, key) !== undefined ||
            (!form.includes('/') && own(gone.names, key) !== undefined) ||
            own(gone.aliases, key) !== undefined
        ) {
            return true
        }
    }
    return false
}

/** True when a path, as written, is the canonical path or the Markdown path of an unpublished note. */
function isGonePath(path: string, gone: GoneMap | undefined): boolean {
    return (
        gone !== undefined &&
        path.length <= gone.longest &&
        own(gone.paths, keyOf(path)) !== undefined
    )
}
