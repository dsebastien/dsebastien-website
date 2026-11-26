import {
    foldedForm,
    goneKey,
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
        return refuse(`the key "${unknown}" is not known`)
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

/** The rows that the build drops: they would hide a live address, or lead to no live page. */
export interface DroppedRows {
    /**
     * Rows whose old path a published note, a folder or a former path has,
     * and prefix rules of a live folder: the live address wins (business
     * rule 1).
     */
    readonly shadowed: number
    /** Rows whose target is no page of the release: an unpublish or a takedown never blocks a build (business rule 16). */
    readonly deadTarget: number
}

/** The answers that a target can be: a page, or a file of the site (the Markdown of a note). */
const LIVE: readonly Resolution['kind'][] = ['page', 'file']

/**
 * The location that a row leads to, as the resolver of the release answers
 * its target (URL-05: a target never redirects): the target when it is a
 * page, the location of its redirect when that redirect leads to a page,
 * else `undefined` (a dead target). An `https://` address of the site is a
 * path of the site; an address of another host is kept as it is.
 */
function locationOf(to: string, map: ResolverMap): string | undefined {
    const origin = `${SITE_ORIGIN}/`
    if (to.startsWith('https://') && !to.startsWith(origin)) {
        return to
    }
    const own = to.startsWith(origin) ? to.slice(origin.length - 1) : to
    const at = own.indexOf('?')
    const path = at < 0 ? own : own.slice(0, at)
    const query = at < 0 ? '' : own.slice(at)
    const answer = resolve(path, map, query)
    if (LIVE.includes(answer.kind)) {
        return own
    }
    if (answer.kind !== 'redirect') {
        return undefined
    }
    const next = answer.location.indexOf('?')
    const page = resolve(next < 0 ? answer.location : answer.location.slice(0, next), map)
    return LIVE.includes(page.kind) ? answer.location : undefined
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
 * gone row goes into the gone part, as a key. Each target is resolved on the
 * map of the release: the map keeps its canonical location. The build counts
 * the rows that it drops and the rows that hide a file name or an alias of a
 * live note, and names none of them: the warning of the build never shows an
 * old path.
 */
export function applyRedirectList(
    map: ResolverMap,
    list: RedirectList
): { map: ResolverMap; dropped: DroppedRows; hidesNameOrAlias: number } {
    const own = (record: Readonly<Record<string, unknown>> | undefined, key: string): boolean =>
        record !== undefined && Object.hasOwn(record, key)
    const taken = (folded: string): boolean =>
        own(map.folded, folded) || own(map.former?.folded, folded)
    let shadowed = 0
    let deadTarget = 0
    let hidesNameOrAlias = 0
    let longest = 0
    const folded = new Map<string, string>()
    for (const row of list.redirects) {
        const key = foldedForm(row.from)
        const location = locationOf(row.to, map)
        if (taken(key)) {
            shadowed++
        } else if (location === undefined) {
            deadTarget++
        } else {
            if ((!key.includes('/') && own(map.names, key)) || own(map.aliases, key)) {
                hidesNameOrAlias++
            }
            folded.set(goneKey(key), location)
            longest = Math.max(longest, key.length)
        }
    }
    const goneTexts: string[] = []
    for (const path of list.gone) {
        const key = foldedForm(path)
        if (taken(key)) {
            shadowed++
        } else {
            goneTexts.push(key)
        }
    }
    const prefixes = new Map<string, string>()
    for (const row of list.prefixes) {
        const key = foldedForm(row.from)
        const location = locationOf(row.to, map)
        if (taken(key.slice(0, -1))) {
            shadowed++
        } else if (location === undefined) {
            deadTarget++
        } else {
            prefixes.set(goneKey(key), location)
            longest = Math.max(longest, key.length)
        }
    }
    const redirects: RedirectMap = {
        longest,
        folded: sortedRecord(folded),
        prefixes: sortedRecord(prefixes)
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
    return { map: result, dropped: { shadowed, deadTarget }, hidesNameOrAlias }
}
