import { foldedForm } from './resolver.ts'

// The URL function (MOD-04 of the spec): the one place that knows the
// encoding of the canonical URL. Every output of the site uses it.

/** The canonical host of the site: the build names it in each canonical link, the plugin in its reports. */
export const SITE_ORIGIN = 'https://notes.dsebastien.net'

/**
 * The canonical path of a note, from its vault path: the path part of its
 * canonical URL, with a slash at the start and no slash at the end.
 *
 * Each segment of the vault path is percent-encoded, then `%20` is written as
 * `+`. So a space is `+`, and a literal `+` is `%2B` (URL-01).
 *
 * The research of 2026-11-17 measured this encoding on the site of today
 * (`documentation/research/2026-11-17-current-state.md`, section 1.6). The
 * slice of the first redirect list (issue 44) checks it against every URL
 * that the search engines know.
 */
export function canonicalPath(vaultPath: string): string {
    if (!vaultPath.endsWith('.md')) {
        throw new Error(`"${vaultPath}" is not the vault path of a note`)
    }
    return `/${encodedSegments(vaultPath.slice(0, -'.md'.length))}`
}

/** Each segment of a path percent-encoded, then `%20` written as `+`. */
function encodedSegments(path: string): string {
    return path
        .split('/')
        .map((segment) => encodeURIComponent(segment).replaceAll('%20', '+'))
        .join('/')
}

/**
 * The canonical path of a folder, from its vault path: the encoding of
 * `canonicalPath`. It shows the list of the folder, or leads to its folder
 * note (URL-16).
 */
export function folderPath(vaultPath: string): string {
    return `/${encodedSegments(vaultPath)}`
}

/** The path of the Markdown of a note (URL-10): `/-/md/`, its canonical path, and `.md`. */
export function markdownPath(vaultPath: string): string {
    return `/-/md${canonicalPath(vaultPath)}.md`
}

/** The form of the hash of an attachment in the manifest. */
const ATTACHMENT_HASH = /^sha256:([0-9a-f]{64})$/

/**
 * The content-hashed path of an attachment, which pages use (URL-15): the key
 * of the file in the attachment storage, then its name, percent-encoded. The
 * content of such a URL never changes, so it can be kept for a long time.
 *
 * @param hash the hash of the file in the manifest: `sha256:` and 64 hexadecimal digits
 * @param vaultPath the vault path of the file
 */
export function attachmentPath(hash: string, vaultPath: string): string {
    const key = ATTACHMENT_HASH.exec(hash)?.[1]
    if (key === undefined) {
        throw new Error(`"${hash}" is not the hash of an attachment`)
    }
    const name = vaultPath.slice(vaultPath.lastIndexOf('/') + 1)
    return `/-/attachments/${key}/${encodeURIComponent(name)}`
}

/**
 * The path of the page of a tag (NAV-04): `/-/tags/`, then the folded form of
 * the tag (composed, in small letters), one segment per level. A tag in the
 * text of a note and a tag in its properties lead to the same page, and so do
 * two Unicode forms of one tag.
 *
 * @param tag the tag without its `#`
 */
export function tagPath(tag: string): string {
    return `/-/tags/${foldedForm(tag).split('/').map(encodeURIComponent).join('/')}`
}

/** A canonical name of a note type (decision R61). */
const TYPE_NAME = /^[a-z][a-z0-9_-]{0,63}$/u

/** The part of the path of a page of a list: nothing for page 1, `/page/<number>` for a later one. */
function pageSuffix(page: number): string {
    if (!Number.isSafeInteger(page) || page < 1) {
        throw new Error(`${String(page)} is not the number of a page`)
    }
    return page === 1 ? '' : `/page/${String(page)}`
}

/**
 * The path of a page of the list of a tag (NAV-04, decision R61): the path of
 * the tag, and `/page/<number>` after page 1.
 *
 * @param tag the tag without its `#`
 * @param page the number of the page, from 1
 */
export function tagPagePath(tag: string, page: number): string {
    return `${tagPath(tag)}${pageSuffix(page)}`
}

/**
 * The path of a page of the type hub of a note type (NAV-03, decision R61):
 * `/-/types/<name>`, and `/page/<number>` after page 1.
 *
 * @param name the canonical name of the note type
 * @param page the number of the page, from 1
 */
export function typeHubPath(name: string, page: number): string {
    if (!TYPE_NAME.test(name)) {
        throw new Error(`"${name}" is not the canonical name of a note type`)
    }
    return `/-/types/${name}${pageSuffix(page)}`
}

/** The path of the library: the type hubs of the media types (NAV-03, decision R61). */
export const LIBRARY_PATH = '/-/library'

/**
 * The path of the search page (SRCH-01, decision R63). A query in its
 * address (`?q=compost`) starts a search; the files of its indexes are
 * under `/-/search/`.
 */
export const SEARCH_PATH = '/-/search'

/**
 * The path of a page of the list of the notes with no note type (decision
 * R61): `/-/other`, and `/page/<number>` after page 1. It is their crawl path.
 *
 * @param page the number of the page, from 1
 */
export function otherNotesPath(page: number): string {
    return `/-/other${pageSuffix(page)}`
}

/** The two recent lists (NAV-05, decision R62). */
export type RecentKind = 'added' | 'updated'

/**
 * The path of a page of a recent list (NAV-05, decision R62):
 * `/-/recent/added` or `/-/recent/updated`, and `/page/<number>` after page 1.
 *
 * @param kind the list: the notes most recently added or updated
 * @param page the number of the page, from 1
 */
export function recentPath(kind: RecentKind, page: number): string {
    return `/-/recent/${kind}${pageSuffix(page)}`
}

/**
 * The path of the filter of a note type of a recent list (decision R62):
 * one page with the newest notes of that type. A type named `page` has no
 * number after it, so it never takes the path of a page of the list.
 *
 * @param kind the list: the notes most recently added or updated
 * @param name the canonical name of the note type
 */
export function recentTypePath(kind: RecentKind, name: string): string {
    if (!TYPE_NAME.test(name)) {
        throw new Error(`"${name}" is not the canonical name of a note type`)
    }
    return `/-/recent/${kind}/${name}`
}

/** The form of the identity of a note. */
const NOTE_ID = /^[0-9a-f]{16}$/

/**
 * The path of the page with every backlink of a note (PAGE-03): a note page
 * holds a limited number of backlinks, and the rest are on this page.
 *
 * @param id the identity of the note in the manifest
 */
export function backlinksPath(id: string): string {
    if (!NOTE_ID.test(id)) {
        throw new Error(`"${id}" is not the identity of a note`)
    }
    return `/-/backlinks/${id}`
}
