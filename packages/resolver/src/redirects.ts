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
    /**
     * Rows whose target leads to no page, with no prefix rule over their old
     * path: an unpublish or a takedown never blocks a build (business rule 16).
     */
    readonly deadTarget: number
    /** Rows whose target uses one row or one prefix rule of the list twice. */
    readonly loop: number
}

/** The rows that the build keeps and counts, for the warning of the build and the parity run. */
export interface KeptRows {
    /** Rows that hide a file name or an alias of a live note: the row wins. */
    readonly hidesNameOrAlias: number
    /**
     * Prefix rules of a folder that is live again: the rule is kept, and it
     * only leads a path under the folder that no exact address has.
     */
    readonly prefixOnLiveFolder: number
    /** Rows whose target is gone, with no prefix rule over their old path: the old path is gone too (410). */
    readonly goneTarget: number
    /**
     * Prefix rules whose target is gone or leads nowhere: they lead where the
     * next shorter prefix rule leads, else to the hub of their parent folder,
     * else to the home page (every old URL keeps working, R79).
     */
    readonly prefixFallback: number
}

/** The answers that a target can be: a page, or a file of the site (the Markdown of a note). */
const LIVE: readonly Resolution['kind'][] = ['page', 'file']

/** Where a target leads, as the build follows it. */
type Followed =
    | { kind: 'location'; location: string; temporary: boolean }
    | { kind: 'gone' }
    | { kind: 'dead' }
    | { kind: 'loop' }

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
    /** The prefix rules, the longest first, by their folded folder with its slash. */
    readonly prefixes: readonly (readonly [string, string])[]
}

/** The longest prefix rule over a folded old path: its folder is a part of the path, with something after it. */
function prefixOver(
    forms: readonly string[],
    prefixes: readonly (readonly [string, string])[]
): readonly [string, string] | undefined {
    return prefixes.find(([folder]) =>
        forms.some((form) => form.length > folder.length && form.startsWith(folder))
    )
}

/**
 * Where a target leads (URL-05: a target never redirects). The build
 * follows it as a request would be answered, in the order of the resolver:
 * a current note or folder or a former path of the release (the end, or one
 * redirect of the release), then a row of the list, then a file name, an
 * alias or a former file name of the release, then a gone address (of the
 * list, or of an unpublished note), then a prefix rule. A redirect of the
 * release is no step. A loop is one row or one prefix rule used twice, and
 * a chain uses at most every row and prefix rule of the list one time, plus
 * two. An `https://` address of the site is a path of the site; an address
 * of another host is the end. A chain that went through an alias keeps the
 * answer of an alias.
 *
 * @param ends the ends of the prefix rules, when the build knows them: a
 * chain that reaches a prefix rule ends where that rule ends
 */
function follow(
    to: string,
    map: ResolverMap,
    rows: Rows,
    ends?: ReadonlyMap<string, Followed>
): Followed {
    const limit = rows.redirects.size + rows.prefixes.length + 2
    const used = new Set<string>()
    let temporary = false
    let next = to
    // A redirect of the release leads to a page (URL-05): the hops are
    // bounded by the steps of the list.
    for (let hops = 0; hops <= 2 * limit + 2; hops++) {
        const target = onSite(next)
        if (target === undefined) {
            return { kind: 'location', location: next, temporary }
        }
        const { path, query } = target
        const forms = foldedFormsOf(path)
        const own = (record: Readonly<Record<string, unknown>> | undefined): boolean =>
            record !== undefined && forms.some((form) => Object.hasOwn(record, form))
        const row = forms.find((form) => rows.redirects.has(form))
        if (row !== undefined && !own(map.folded) && !own(map.former?.folded)) {
            if (used.has(`row ${row}`) || used.size >= limit) {
                return { kind: 'loop' }
            }
            used.add(`row ${row}`)
            next = withQueryOf(rows.redirects.get(row) ?? '', query)
            continue
        }
        const answer = resolve(path, map, query)
        if (LIVE.includes(answer.kind)) {
            return { kind: 'location', location: path + query, temporary }
        }
        if (answer.kind === 'redirect') {
            temporary ||= answer.status === 302
            next = answer.location
            continue
        }
        if (answer.kind === 'gone' || forms.some((form) => rows.gone.has(form))) {
            return { kind: 'gone' }
        }
        const prefix = prefixOver(forms, rows.prefixes)
        if (prefix === undefined) {
            return { kind: 'dead' }
        }
        const [folder, location] = prefix
        if (used.has(`prefix ${folder}`) || used.size >= limit) {
            return { kind: 'loop' }
        }
        used.add(`prefix ${folder}`)
        const end = ends?.get(folder)
        if (end !== undefined) {
            return end.kind === 'location'
                ? {
                      ...end,
                      location: withQueryOf(end.location, query),
                      temporary: temporary || end.temporary
                  }
                : end
        }
        next = withQueryOf(location, query)
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
 * The ends of the prefix rules. A rule whose target is gone, leads nowhere
 * or loops is never dropped: it leads where the next shorter prefix rule
 * over its folder leads, else to the hub of its parent folder when that
 * folder is live, else to the home page.
 */
function prefixEnds(
    map: ResolverMap,
    rows: Rows
): { ends: Map<string, Followed & { kind: 'location' }>; fallback: number } {
    const ends = new Map<string, Followed & { kind: 'location' }>()
    let fallback = 0
    // The shortest first, so the end of a shorter rule is known.
    for (const [folder, to] of [...rows.prefixes].reverse()) {
        const end = follow(to, map, rows)
        if (end.kind === 'location') {
            ends.set(folder, end)
            continue
        }
        fallback++
        const shorter = rows.prefixes.find(
            ([other]) => other.length < folder.length && folder.startsWith(other)
        )
        const parent = folder.slice(0, -1).split('/').slice(0, -1).join('/')
        const hub =
            parent !== '' && map.folded !== undefined && Object.hasOwn(map.folded, parent)
                ? map.folded[parent]
                : undefined
        const kept = shorter === undefined ? undefined : ends.get(shorter[0])
        ends.set(folder, kept ?? { kind: 'location', location: hub ?? '/', temporary: false })
    }
    return { ends, fallback }
}

/**
 * The resolver map with the redirect list (issue 44). A redirect and a
 * prefix rule go into `redirects`, by the key of their folded old path
 * (`goneKey()`), with their target as text: the map holds no old path, so a
 * release that leaks it shows no title (as the gone part, decision R64). A
 * gone row, and a row whose target is gone with no prefix rule over it, go
 * into the gone part, as keys. The build reads every row first, then
 * follows each target through the release and through the list, and keeps
 * the canonical location where it ends. It counts what it drops and what it
 * keeps with a warning, and names no row: the warning of the build and the
 * counts of the map never show an old path.
 */
export function applyRedirectList(
    map: ResolverMap,
    list: RedirectList
): { map: ResolverMap; dropped: DroppedRows; kept: KeptRows } {
    const own = (record: Readonly<Record<string, unknown>> | undefined, key: string): boolean =>
        record !== undefined && Object.hasOwn(record, key)
    const taken = (folded: string): boolean =>
        own(map.folded, folded) || own(map.former?.folded, folded)
    // A row whose old path a live address has is no row: the live address wins.
    let shadowed = 0
    const live = list.redirects.filter((row) => {
        const free = !taken(foldedForm(row.from))
        shadowed += free ? 0 : 1
        return free
    })
    const rows: Rows = {
        redirects: new Map(live.map((row) => [foldedForm(row.from), row.to])),
        gone: new Set(list.gone.map(foldedForm)),
        prefixes: list.prefixes
            .map((row): [string, string] => [foldedForm(row.from), row.to])
            .sort(([one], [two]) => two.length - one.length || compareCodePoints(one, two))
    }
    const { ends, fallback } = prefixEnds(map, rows)
    const dropped = { shadowed, deadTarget: 0, loop: 0 }
    const kept = {
        hidesNameOrAlias: 0,
        prefixOnLiveFolder: 0,
        goneTarget: 0,
        prefixFallback: fallback
    }
    let longest = 0
    const folded = new Map<string, string>()
    const temporary = new Set<string>()
    const goneTexts: string[] = []
    for (const row of live) {
        const key = foldedForm(row.from)
        let end = follow(row.to, map, rows, ends)
        if (end.kind === 'gone' || end.kind === 'dead') {
            // Every old URL keeps working: the prefix rule over the old path of the row.
            const over = prefixOver([key], rows.prefixes)
            end = (over === undefined ? undefined : ends.get(over[0])) ?? end
        }
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
        if (end.temporary) {
            temporary.add(goneKey(key))
        }
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
    for (const [key] of rows.prefixes) {
        const end = ends.get(key)
        if (end === undefined) {
            continue
        }
        if (taken(key.slice(0, -1))) {
            kept.prefixOnLiveFolder++
        }
        prefixes.set(goneKey(key), end.location)
        if (end.temporary) {
            temporary.add(goneKey(key))
        }
        lengths.add(key.length)
        longest = Math.max(longest, key.length)
    }
    const counts = sortedRecord<number>(Object.entries({ ...dropped, ...kept }))
    const redirects: RedirectMap = {
        longest,
        folded: sortedRecord(folded),
        prefixes: sortedRecord(prefixes),
        prefixLengths: [...lengths].sort((one, two) => two - one),
        temporary: sortedRecord([...temporary].map((key): [string, true] => [key, true])),
        counts
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
