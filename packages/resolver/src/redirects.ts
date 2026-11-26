import { foldedForm, goneKey, type RedirectMap, type ResolverMap } from './resolver.ts'
import { compareCodePoints } from './site.ts'

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

function refuse(reason: string): never {
    throw new Error(`${REDIRECT_LIST_FILE} is not a redirect list: ${reason}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The old path of a row, checked: decoded, relative, with no empty part, never under `/-/`. */
function oldPath(value: unknown, prefix: boolean): string {
    if (typeof value !== 'string' || value === '') {
        return refuse('an old path is not a text')
    }
    const text = prefix ? value.slice(0, -1) : value
    if (prefix !== value.endsWith('/')) {
        return refuse(
            prefix
                ? `the prefix "${value}" does not end with a slash`
                : `the old path "${value}" ends with a slash`
        )
    }
    const parts = text.split('/')
    if (parts.some((part) => part === '') || parts[0] === '-') {
        return refuse(`the old path "${value}" is not a path of a note`)
    }
    return value
}

/** The target of a row, checked: a path of the site, or an `https://` address, with no fragment. */
function target(value: unknown): string {
    if (typeof value !== 'string' || value.includes('#')) {
        return refuse('a target is not a path of the site or an https address')
    }
    if (value.startsWith('/') && !value.startsWith('//')) {
        return value
    }
    if (URL.canParse(value) && new URL(value).protocol === 'https:') {
        return value
    }
    return refuse(`the target "${value}" is not a path of the site or an https address`)
}

function rowsOf(value: unknown, prefix: boolean): RedirectRow[] {
    if (value === undefined) {
        return []
    }
    if (!Array.isArray(value)) {
        return refuse('a part is not a list')
    }
    return value.map((row: unknown) => {
        if (!isRecord(row) || Object.keys(row).some((key) => key !== 'from' && key !== 'to')) {
            return refuse('a row is not an object with "from" and "to"')
        }
        return { from: oldPath(row['from'], prefix), to: target(row['to']) }
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
        return refuse('a part is not a list')
    }
    const list: RedirectList = {
        redirects: rowsOf(value['redirects'], false),
        gone: gone.map((path: unknown) => oldPath(path, false)),
        prefixes: rowsOf(value['prefixes'], true)
    }
    const seen = new Set<string>()
    for (const path of [...list.redirects.map((row) => row.from), ...list.gone]) {
        const key = foldedForm(path)
        if (seen.has(key)) {
            return refuse(`two rows have the old path "${path}"`)
        }
        seen.add(key)
    }
    const prefixes = new Set<string>()
    for (const { from } of list.prefixes) {
        const key = foldedForm(from)
        if (prefixes.has(key)) {
            return refuse(`two prefix rules have the prefix "${from}"`)
        }
        prefixes.add(key)
    }
    return list
}

/** The rows that the build drops: they would hide a live address, or lead to no live page. */
export interface DroppedRows {
    /** Rows whose old path a published note, a folder or a former path has: the live address wins (business rule 1). */
    readonly shadowed: number
    /** Rows whose target is no page of the release: an unpublish or a takedown never blocks a build (business rule 16). */
    readonly deadTarget: number
}

/**
 * The resolver map with the redirect list (issue 44). A redirect and a
 * prefix rule go into `redirects`, as texts: an old path was a public URL,
 * and a target is a live page. A gone row goes into the gone part, as a key
 * only (decision R64). The build counts the rows that it drops, and names
 * none of them: the warning of the build never shows an old path.
 */
export function applyRedirectList(
    map: ResolverMap,
    list: RedirectList
): { map: ResolverMap; dropped: DroppedRows } {
    const own = (record: Readonly<Record<string, unknown>> | undefined, key: string): boolean =>
        record !== undefined && Object.hasOwn(record, key)
    const live = (to: string): boolean =>
        to.startsWith('https://') || own(map.pages, to.split('?')[0] ?? '')
    const taken = (from: string): boolean =>
        own(map.folded, foldedForm(from)) || own(map.former?.folded, foldedForm(from))
    let shadowed = 0
    let deadTarget = 0
    const folded: Record<string, string> = {}
    for (const row of list.redirects) {
        if (taken(row.from)) {
            shadowed++
        } else if (!live(row.to)) {
            deadTarget++
        } else {
            folded[foldedForm(row.from)] = row.to
        }
    }
    const goneTexts: string[] = []
    for (const path of list.gone) {
        if (taken(path)) {
            shadowed++
        } else {
            goneTexts.push(foldedForm(path))
        }
    }
    const prefixes: [string, string][] = []
    for (const row of list.prefixes) {
        if (live(row.to)) {
            prefixes.push([foldedForm(row.from), row.to])
        } else {
            deadTarget++
        }
    }
    // The longest prefix first: the most precise rule wins.
    prefixes.sort(([one], [two]) => two.length - one.length || compareCodePoints(one, two))
    const redirects: RedirectMap = {
        folded: Object.fromEntries(
            Object.entries(folded).sort(([one], [two]) => compareCodePoints(one, two))
        ),
        prefixes
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
                      folded: Object.fromEntries(
                          [...new Set([...Object.keys(gone.folded), ...goneTexts.map(goneKey)])]
                              .sort(compareCodePoints)
                              .map((key): [string, true] => [key, true])
                      )
                  }
              }
    return { map: result, dropped: { shadowed, deadTarget } }
}
