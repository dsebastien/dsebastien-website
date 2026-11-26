import {
    foldedForm,
    goneKey,
    readingsOf,
    resolve,
    type RedirectMap,
    type Resolution,
    type ResolverMap
} from './resolver.ts'
import { compareCodePoints } from './site.ts'
import { SITE_ORIGIN } from './url.ts'

// The redirect list (issue 44, section 10.3 of the spec): the old addresses
// of the current site that no rule of the resolver finds. The content store
// holds it in `redirects.json`, which is private: its rows name old paths,
// and the public repository never holds one. The author writes it (a script
// of his builds it from the reports of the search engines, the 404 data and
// the rename history of the vault); the publishing tool never reads or
// writes it, and only the build reads it.
//
// An old path is written decoded, as a vault path without `.md` and without
// a slash at its start: `Old folder/Old name`. So one row covers every
// encoding of the path (`+`, `%20`, `%2B`), every letter case and Unicode
// form, a slash at the end and a `.md` suffix, as the resolver reads them
// (RES-06).

/** The name of the redirect list in the content store. */
export const REDIRECT_LIST_FILE = 'redirects.json'

/** A row of the redirect list: an old path and its target. */
export interface RedirectRow {
    /** The old path, decoded, without a slash at its start. A prefix ends with a slash. */
    readonly from: string
    /** A path of the site (`/` and the canonical path of a note, or a generated page), or an `https://` address. */
    readonly to: string
}

/** The redirect list, as the content store holds it. */
export interface RedirectList {
    /** Old paths that lead to a target (301). */
    readonly redirects: readonly RedirectRow[]
    /** Old paths that the author says are gone (410). */
    readonly gone: readonly string[]
    /** Old folders, each with a slash at its end: every path under one leads to its target (301). */
    readonly prefixes: readonly RedirectRow[]
}

/**
 * A refusal of the reader. Its message names the row and its part, never an
 * old path: the message of the build can reach a report.
 */
function refuse(reason: string): never {
    throw new Error(`${REDIRECT_LIST_FILE} is not a redirect list: ${reason}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The place of a row in the file, for a message: `row 2 of redirects`. */
type Place = string

/**
 * The old path of a row, checked: decoded (no `%` and two hexadecimal
 * digits), relative, with no empty part, never under `/-/`, with no `.md`
 * ending.
 */
function oldPath(value: unknown, prefix: boolean, place: Place): string {
    if (typeof value !== 'string' || value === '') {
        return refuse(`the old path of ${place} is not a text`)
    }
    if (prefix !== value.endsWith('/')) {
        return refuse(
            prefix
                ? `the prefix of ${place} does not end with a slash`
                : `the old path of ${place} ends with a slash`
        )
    }
    const text = prefix ? value.slice(0, -1) : value
    const parts = text.split('/')
    if (parts.some((part) => part === '') || parts[0] === '-') {
        return refuse(`the old path of ${place} is not a path of a note`)
    }
    if (/%[0-9A-Fa-f]{2}/u.test(value)) {
        return refuse(`the old path of ${place} is still encoded: write it decoded`)
    }
    if (!prefix && text.toLowerCase().endsWith('.md')) {
        return refuse(`the old path of ${place} ends with .md: write it without`)
    }
    return value
}

/** The target of a row, checked: a path of the site, or an `https://` address, with no fragment. */
function target(value: unknown, place: Place): string {
    if (typeof value === 'string' && !value.includes('#')) {
        if (value.startsWith('/') && !value.startsWith('//')) {
            return value
        }
        if (URL.canParse(value) && new URL(value).protocol === 'https:') {
            return value
        }
    }
    return refuse(`the target of ${place} is not a path of the site or an https address`)
}

function rowsOf(value: unknown, part: 'redirects' | 'prefixes'): RedirectRow[] {
    if (value === undefined) {
        return []
    }
    if (!Array.isArray(value)) {
        return refuse(`the part ${part} is not a list`)
    }
    return value.map((row: unknown, index) => {
        const place = `row ${String(index + 1)} of ${part}`
        if (!isRecord(row) || Object.keys(row).some((key) => key !== 'from' && key !== 'to')) {
            return refuse(`${place} is not an object with "from" and "to"`)
        }
        return {
            from: oldPath(row['from'], part === 'prefixes', place),
            to: target(row['to'], place)
        }
    })
}

/**
 * The redirect list that a value read from the content store is.
 *
 * @throws when the value is not a redirect list: the build stops, and the
 * author corrects the file
 */
export function redirectListFrom(value: unknown): RedirectList {
    if (!isRecord(value)) {
        return refuse('it is not an object')
    }
    if (value['version'] !== 1) {
        return refuse('its version is not 1')
    }
    const known = new Set(['version', 'redirects', 'gone', 'prefixes'])
    const unknown = Object.keys(value).find((key) => !known.has(key))
    if (unknown !== undefined) {
        // The key can be a path that someone wrote in the wrong place.
        return refuse('a key is not known')
    }
    const gone = value['gone'] ?? []
    if (!Array.isArray(gone)) {
        return refuse('the part gone is not a list')
    }
    const list: RedirectList = {
        redirects: rowsOf(value['redirects'], 'redirects'),
        gone: gone.map((path: unknown, index) =>
            oldPath(path, false, `row ${String(index + 1)} of gone`)
        ),
        prefixes: rowsOf(value['prefixes'], 'prefixes')
    }
    const twice = (rows: readonly [string, Place][], what: string): void => {
        const seen = new Map<string, Place>()
        for (const [path, place] of rows) {
            const key = foldedForm(path)
            const first = seen.get(key)
            if (first !== undefined) {
                refuse(`${place} has the ${what} of ${first}`)
            }
            seen.set(key, place)
        }
    }
    twice(
        [
            ...list.redirects.map((row, index): [string, Place] => [
                row.from,
                `row ${String(index + 1)} of redirects`
            ]),
            ...list.gone.map((path, index): [string, Place] => [
                path,
                `row ${String(index + 1)} of gone`
            ])
        ],
        'old path'
    )
    twice(
        list.prefixes.map((row, index): [string, Place] => [
            row.from,
            `row ${String(index + 1)} of prefixes`
        ]),
        'prefix'
    )
    return list
}

/** The rows that the build drops: they would hide a live address, or lead nowhere. */
export interface DroppedRows {
    /** Rows whose old path a published note, a folder or a former path has: the live address wins (business rule 1). */
    readonly shadowed: number
    /** Rows whose target leads to no page: an unpublish or a takedown never blocks a build (business rule 16). */
    readonly deadTarget: number
    /** Rows whose target leads through the list back to itself, or through too many rows. */
    readonly loop: number
}

/** The rows that the build keeps and counts, for the warning of the build. */
export interface KeptRows {
    /** Rows that hide a file name or an alias of a live note: the row wins. */
    readonly hidesNameOrAlias: number
    /**
     * Prefix rules of a folder that is live again: the rule is kept, and it
     * only leads a path under the folder that no exact address has.
     */
    readonly prefixOnLiveFolder: number
    /** Rows whose target is gone (an unpublished note, a gone row): the old path is gone too (410). */
    readonly goneTarget: number
}

/** The answers that a target can be: a page, or a file of the site (the Markdown of a note). */
const LIVE: readonly Resolution['kind'][] = ['page', 'file']

/** How many steps a target can take through the list before the build calls it a loop. */
const STEPS = 8

/** Where a target leads, as the build follows it. */
type Followed =
    { kind: 'location'; location: string } | { kind: 'gone' } | { kind: 'dead' } | { kind: 'loop' }

/** The origin of the site, in the form that `URL` gives: no slash, small letters, no default port. */
const SITE = new URL(SITE_ORIGIN).origin

/** The path and the query of a target on the site, or `undefined` for an address of another host. */
function onSite(to: string): { path: string; query: string } | undefined {
    if (!to.startsWith('/')) {
        const url = new URL(to)
        return url.origin === SITE ? { path: url.pathname, query: url.search } : undefined
    }
    const at = to.indexOf('?')
    return at < 0 ? { path: to, query: '' } : { path: to.slice(0, at), query: to.slice(at) }
}

/** The folded forms of a requested path, as the resolver reads them: every reading, without a slash at the end or `.md`. */
function foldedFormsOf(path: string): string[] {
    const forms = new Set<string>()
    for (const reading of readingsOf(path)) {
        let text = reading
        forms.add(foldedForm(text))
        if (text.endsWith('/')) {
            text = text.slice(0, -1)
            forms.add(foldedForm(text))
        }
        if (text.toLowerCase().endsWith('.md')) {
            forms.add(foldedForm(text.slice(0, -'.md'.length)))
        }
    }
    return [...forms]
}

/** The rows of the list, by the folded form of their old paths, for the build to follow a target. */
interface Rows {
    readonly redirects: ReadonlyMap<string, string>
    readonly gone: ReadonlySet<string>
    /** The prefix rules, the longest first. */
    readonly prefixes: readonly (readonly [string, string])[]
}

/**
 * Where a target leads (URL-05: a target never redirects). The build
 * follows it as a reader would: the resolver of the release first (a page or
 * a file is the end, a redirect is followed), then a row of the list with
 * that old path, then a gone address (of the list, or of an unpublished
 * note), then a prefix rule, as the resolver orders them. An `https://`
 * address of the site is a path of the site; an address of another host is
 * the end.
 */
function follow(to: string, map: ResolverMap, rows: Rows): Followed {
    const seen = new Set<string>()
    let next = to
    for (let step = 0; step < STEPS; step++) {
        const target = onSite(next)
        if (target === undefined) {
            return { kind: 'location', location: next }
        }
        const { path, query } = target
        const forms = foldedFormsOf(path)
        // The path as written: a redirect of the release leads from a
        // variant to its canonical form, which is no loop. A loop through
        // two forms of one old path ends with the limit of the steps.
        const visit = path + query
        if (seen.has(visit)) {
            return { kind: 'loop' }
        }
        seen.add(visit)
        const answer = resolve(path, map, query)
        if (LIVE.includes(answer.kind)) {
            return { kind: 'location', location: path + query }
        }
        if (answer.kind === 'redirect') {
            next = answer.location
            continue
        }
        const row = forms.map((form) => rows.redirects.get(form)).find((one) => one !== undefined)
        if (row !== undefined) {
            next = withQueryOf(row, query)
            continue
        }
        if (answer.kind === 'gone' || forms.some((form) => rows.gone.has(form))) {
            return { kind: 'gone' }
        }
        const prefix = rows.prefixes.find(([folder]) =>
            forms.some((form) => form.length > folder.length && form.startsWith(folder))
        )
        if (prefix === undefined) {
            return { kind: 'dead' }
        }
        next = withQueryOf(prefix[1], query)
    }
    return { kind: 'loop' }
}

/** A location with a query after its own one. */
function withQueryOf(location: string, query: string): string {
    if (query === '') {
        return location
    }
    return location.includes('?') ? `${location}&${query.slice(1)}` : location + query
}

/** A record of keys, sorted, so the map has one form for one list. */
function sortedRecord<T>(entries: Iterable<[string, T]>): Record<string, T> {
    return Object.fromEntries([...entries].sort(([one], [two]) => compareCodePoints(one, two)))
}

/**
 * The resolver map with the redirect list (issue 44). A redirect and a
 * prefix rule go into `redirects`, by the key of their folded old path
 * (`goneKey()`), with their target as text: the map holds no old path, so a
 * release that leaks it shows no title (as the gone part, decision R64). A
 * gone row, and a row whose target is gone, go into the gone part, as keys.
 * The build follows each target through the release and through the list
 * (a chain of rows, a prefix rule), and keeps the canonical location where
 * it ends. It counts the rows that it drops and the rows that it keeps with
 * a warning, and names none of them: the warning of the build never shows
 * an old path.
 */
export function applyRedirectList(
    map: ResolverMap,
    list: RedirectList
): { map: ResolverMap; dropped: DroppedRows; kept: KeptRows } {
    const own = (record: Readonly<Record<string, unknown>> | undefined, key: string): boolean =>
        record !== undefined && Object.hasOwn(record, key)
    const taken = (folded: string): boolean =>
        own(map.folded, folded) || own(map.former?.folded, folded)
    const rows: Rows = {
        redirects: new Map(list.redirects.map((row) => [foldedForm(row.from), row.to])),
        gone: new Set(list.gone.map(foldedForm)),
        prefixes: list.prefixes
            .map((row): [string, string] => [foldedForm(row.from), row.to])
            .sort(([one], [two]) => two.length - one.length || compareCodePoints(one, two))
    }
    const dropped = { shadowed: 0, deadTarget: 0, loop: 0 }
    const kept = { hidesNameOrAlias: 0, prefixOnLiveFolder: 0, goneTarget: 0 }
    let longest = 0
    const folded = new Map<string, string>()
    const goneTexts: string[] = []
    for (const row of list.redirects) {
        const key = foldedForm(row.from)
        if (taken(key)) {
            dropped.shadowed++
            continue
        }
        const end = follow(row.to, map, rows)
        if (end.kind === 'dead' || end.kind === 'loop') {
            dropped[end.kind === 'dead' ? 'deadTarget' : 'loop']++
            continue
        }
        if ((!key.includes('/') && own(map.names, key)) || own(map.aliases, key)) {
            kept.hidesNameOrAlias++
        }
        if (end.kind === 'gone') {
            kept.goneTarget++
            goneTexts.push(key)
            continue
        }
        folded.set(goneKey(key), end.location)
        longest = Math.max(longest, key.length)
    }
    for (const path of list.gone) {
        const key = foldedForm(path)
        if (taken(key)) {
            dropped.shadowed++
        } else {
            goneTexts.push(key)
        }
    }
    const prefixes = new Map<string, string>()
    const lengths = new Set<number>()
    for (const [key, to] of rows.prefixes) {
        const end = follow(to, map, rows)
        if (end.kind !== 'location') {
            // A prefix rule that leads to no page leads nowhere: a gone
            // target is no answer for every path under a folder.
            dropped[end.kind === 'loop' ? 'loop' : 'deadTarget']++
            continue
        }
        if (taken(key.slice(0, -1))) {
            kept.prefixOnLiveFolder++
        }
        prefixes.set(goneKey(key), end.location)
        lengths.add(key.length)
        longest = Math.max(longest, key.length)
    }
    const redirects: RedirectMap = {
        longest,
        folded: sortedRecord(folded),
        prefixes: sortedRecord(prefixes),
        prefixLengths: [...lengths].sort((one, two) => two - one)
    }
    const gone = map.gone ?? { longest: 0, paths: {}, folded: {}, names: {}, aliases: {} }
    const result: ResolverMap =
        goneTexts.length === 0
            ? { ...map, redirects }
            : {
                  ...map,
                  redirects,
                  gone: {
                      ...gone,
                      longest: Math.max(gone.longest, ...goneTexts.map((text) => text.length)),
                      folded: sortedRecord(
                          [
                              ...new Set([...Object.keys(gone.folded), ...goneTexts.map(goneKey)])
                          ].map((key): [string, true] => [key, true])
                      )
                  }
              }
    return { map: result, dropped, kept }
}
