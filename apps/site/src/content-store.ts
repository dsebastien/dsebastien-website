import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
    attachmentPath,
    canonicalPath,
    REDIRECT_LIST_FILE,
    redirectListFrom,
    type FormerPath,
    type RedirectList
} from '@dsebastien-website/resolver'
import {
    CONFIGURATION_FILE,
    parseConfiguration
} from '../../plugin/src/publishing/configuration.ts'
import { isNoteType, type NoteType } from '../../plugin/src/publishing/note-types.ts'
import { comparisonForm, MAIN_SITE_ORIGIN } from '../../plugin/src/publishing/originals.ts'

// The content store as the build reads it (BUILD-01 of the spec). The build
// never reads the vault: the content store holds the cleaned notes and the
// manifest, and nothing else is published. It also holds the redirect list
// (`redirects.json`, issue 44), which only the resolver map uses, and the
// configuration of the publishing tool, of which the build reads only the
// noindex folders (`noindexFolders`, R103).
//
// The variable CONTENT_STORE names the folder of a copy of the content store.
// Without it the site has no note, which is the state of the public CI: the
// content store is private (BUILD-11).

/** The folder of the content store, or `undefined` when the build has none. */
export function contentStoreFolder(): string | undefined {
    const folder = process.env['CONTENT_STORE']
    return folder === undefined || folder === '' ? undefined : resolve(folder)
}

/** The folder of the cleaned notes in a content store. */
export function notesFolder(): string {
    const store = contentStoreFolder()
    if (store === undefined) {
        throw new Error('the build has no content store')
    }
    return join(store, 'notes')
}

/** A published note, as the manifest names it. */
export interface PublishedNote {
    /** The identity of the note in the manifest. */
    id: string
    /** The vault path of the note. */
    vaultPath: string
    /** The path part of the canonical URL of the note. */
    path: string
    /** The file of the page of the note, relative to the output of the build. */
    file: string
    /** The file of the Markdown of the note, relative to the output of the build (URL-10). */
    markdownFile: string
    /** The aliases of the note that get a URL. */
    aliases: string[]
    /** The vault paths that the note had before it moved: each answers 301 to the note (URL-21, R66), with the time of its move (R82). */
    formerPaths: FormerPath[]
    /** The title of the page. A first version: the file name of the note. */
    title: string
    /** The time of the first publication of the note, in UTC (`2031-03-14T07:30:00Z`). */
    firstPublished: string
    /** The time of the last publication that changed the note, in UTC. */
    lastPublished: string
    /** The links of the note that lead to a note: the link path as the note writes it, and the vault path of its target. */
    links: { link: string; path: string }[]
    /** The links of the note that lead to an attachment, with the hashed URL of the file and the size of an image. */
    attachments: PublishedAttachment[]
    /** The note type of the note, as the Starter Kit gave it at the publication (decision R61). */
    noteType?: NoteType
    /**
     * The post on the main site that the tool verified as the original of
     * the note at its last publication (PUB-100, IDX-12).
     */
    original?: string
}

/** A link of a published note to an attachment. */
export interface PublishedAttachment {
    /** The link path as the note writes it. */
    link: string
    /** The key of the file in the attachment storage. */
    key: string
    /** The hashed URL of the file. */
    url: string
    /** The name of the file. */
    name: string
    width?: number
    height?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True when the value is a list of texts. */
function isTextList(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** True when the value is the list `links` of a manifest entry. */
function isLinkList(value: unknown): value is { link: string; path: string }[] {
    return (
        Array.isArray(value) &&
        value.every(
            (item) =>
                isRecord(item) &&
                typeof item['link'] === 'string' &&
                typeof item['path'] === 'string'
        )
    )
}

/** True when the value is the list `attachments` of a manifest entry, as the build reads it. */
function isAttachmentList(
    value: unknown
): value is { link: string; path: string; hash: string; width?: number; height?: number }[] {
    const isSize = (size: unknown): boolean =>
        size === undefined || (typeof size === 'number' && Number.isSafeInteger(size) && size > 0)
    return (
        Array.isArray(value) &&
        value.every(
            (item) =>
                isRecord(item) &&
                typeof item['link'] === 'string' &&
                typeof item['path'] === 'string' &&
                typeof item['hash'] === 'string' &&
                ATTACHMENT_HASH.test(item['hash']) &&
                isSize(item['width']) &&
                isSize(item['height'])
        )
    )
}

/** The form of the hash of an attachment. Its digits name a file of the attachment storage. */
const ATTACHMENT_HASH = /^sha256:[0-9a-f]{64}$/

/**
 * True when the value is the `original` of an entry, as the build reads it:
 * a time of the check and a post URL of the main site in its comparison form.
 * The canonical link of the page names that URL, so a URL of another host
 * stops the build.
 */
function isOriginal(value: unknown): value is { checked: string; url: string } {
    return (
        isRecord(value) &&
        isTime(value['checked']) &&
        typeof value['url'] === 'string' &&
        value['url'].startsWith(`${MAIN_SITE_ORIGIN}/`) &&
        comparisonForm(value['url']) === value['url']
    )
}

/** The form of a time of the manifest: UTC, to the second (canonical form, rule 9). */
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

/** True when the value is a time of the manifest. */
function isTime(value: unknown): value is string {
    return typeof value === 'string' && TIME.test(value)
}

/**
 * True when the value is a former path of the manifest: a vault path of a note
 * with the time of its move (R82), or a text alone, with no time (an entry
 * written before R82).
 */
function isFormerPath(value: unknown): value is FormerPath {
    if (typeof value === 'string') {
        return isFormerPathText(value)
    }
    return (
        isRecord(value) &&
        Object.keys(value).length === 2 &&
        typeof value['path'] === 'string' &&
        isFormerPathText(value['path']) &&
        isTime(value['time'])
    )
}

/** A copy of a list of former paths. */
function formerPathsCopy(formers: readonly FormerPath[]): FormerPath[] {
    return formers.map((former) =>
        typeof former === 'string' ? former : { path: former.path, time: former.time }
    )
}

/**
 * True when the text is the vault path of a note: relative, with `/`, no empty
 * part, no `.` and no `..` part, and the end `.md`. A former path becomes an
 * address of the site.
 */
function isFormerPathText(value: string): boolean {
    const parts = value.split('/')
    return (
        value.endsWith('.md') &&
        !value.includes('\\') &&
        parts.every((part) => part !== '' && part !== '.' && part !== '..')
    )
}

/** The form of the identity of a note. It becomes the name of a file of the site. */
const NOTE_ID = /^[0-9a-f]{16}$/

/**
 * Reads the published notes from the manifest, in the order of their paths.
 *
 * It throws, and so stops the build, when the content store cannot be
 * trusted: the folder that the variable names does not exist, a file of the
 * manifest is not an entry, or two entries have the same path.
 *
 * @param store the folder of the copy of the content store: by default the
 * one that the variable names. The deployment gives its own.
 */
export async function readPublishedNotes(
    store: string | undefined = contentStoreFolder()
): Promise<PublishedNote[]> {
    return (await readManifest(store)).notes
}

/** A note that the author unpublished: its entry stays, and its addresses answer 410 (URL-27, decision R64). */
export interface RemovedNote {
    /** The vault path of the note. */
    readonly vaultPath: string
    /** The aliases of the note that had a URL. */
    readonly aliases: readonly string[]
    /** The vault paths that the note had before it moved: they are gone too (R64, R66). */
    readonly formerPaths: readonly FormerPath[]
}

/**
 * The run of the first publication of the content store (decision R62): the
 * earliest `firstPublished` of every entry of the manifest, also of an entry
 * that is no longer published. The notes of that run keep the `created` and
 * `updated` properties of the vault in the recent lists. `undefined` without
 * a publication. A forced removal deletes an entry (R64): when every entry
 * of the first run leaves, the import run moves to a later run.
 */
export async function readImportRun(): Promise<string | undefined> {
    return (await readPublication()).importRun
}

/** The published notes and the import run, from one read of the manifest. */
export async function readPublication(): Promise<{
    notes: PublishedNote[]
    removed: RemovedNote[]
    importRun: string | undefined
}> {
    const { notes, removed, firstRuns } = await readManifest()
    // A time of the manifest is ASCII in one form, so its text order is its time order.
    return {
        notes,
        removed,
        importRun: [...firstRuns].sort((one, two) => (one < two ? -1 : 1))[0]
    }
}

/** The published notes, the unpublished notes and the first publication of every entry of the manifest. */
async function readManifest(store: string | undefined = contentStoreFolder()): Promise<{
    notes: PublishedNote[]
    removed: RemovedNote[]
    firstRuns: Set<string>
}> {
    const firstRuns = new Set<string>()
    if (store === undefined) {
        return { notes: [], removed: [], firstRuns }
    }
    try {
        if (!(await stat(store)).isDirectory()) {
            throw new Error('not a folder')
        }
    } catch {
        throw new Error(`the content store is not a folder: "${store}"`)
    }
    let files: string[]
    try {
        files = await readdir(join(store, 'manifest'))
    } catch {
        // A content store with no publication yet has no manifest.
        return { notes: [], removed: [], firstRuns }
    }
    const texts: { file: string; text: string }[] = []
    for (const file of files.filter((name) => name.endsWith('.json')).sort()) {
        texts.push({ file, text: await readFile(join(store, 'manifest', file), 'utf8') })
    }
    return manifestOf(texts)
}

/**
 * The published notes of a manifest whose files have these names and texts:
 * the reader of the build. A deployment reads the manifest of an older
 * revision with it too (issue 120). It throws as `readPublishedNotes()`.
 */
export function publishedNotesOf(
    files: readonly { readonly file: string; readonly text: string }[]
): PublishedNote[] {
    return manifestOf(files).notes
}

/** The entries of the manifest files with these names (`<id>.json`) and texts. */
function manifestOf(files: readonly { readonly file: string; readonly text: string }[]): {
    notes: PublishedNote[]
    removed: RemovedNote[]
    firstRuns: Set<string>
} {
    const firstRuns = new Set<string>()
    const notes = new Map<string, PublishedNote>()
    const removed = new Map<string, RemovedNote>()
    const ordered = files
        .filter(({ file }) => file.endsWith('.json'))
        .sort((one, two) => (one.file < two.file ? -1 : one.file > two.file ? 1 : 0))
    for (const { file, text } of ordered) {
        const entry: unknown = JSON.parse(text)
        if (
            !isRecord(entry) ||
            typeof entry['id'] !== 'string' ||
            !NOTE_ID.test(entry['id']) ||
            typeof entry['path'] !== 'string' ||
            !isLinkList(entry['links']) ||
            !isTextList(entry['aliases']) ||
            !Array.isArray(entry['formerPaths']) ||
            !entry['formerPaths'].every(isFormerPath) ||
            !isTime(entry['firstPublished']) ||
            !isTime(entry['lastPublished']) ||
            !isAttachmentList(entry['attachments']) ||
            (entry['noteType'] !== undefined && !isNoteType(entry['noteType'])) ||
            (entry['original'] !== undefined && !isOriginal(entry['original'])) ||
            (entry['state'] !== 'published' && entry['state'] !== 'unpublished')
        ) {
            throw new Error(`manifest/${file} is not a manifest entry`)
        }
        firstRuns.add(entry['firstPublished'])
        const vaultPath = entry['path']
        if (notes.has(vaultPath) || removed.has(vaultPath)) {
            throw new Error(`two entries of the manifest have the path "${vaultPath}"`)
        }
        if (entry['state'] === 'unpublished') {
            removed.set(vaultPath, {
                vaultPath,
                aliases: [...entry['aliases']],
                formerPaths: formerPathsCopy(entry['formerPaths'])
            })
            continue
        }
        const noteType = entry['noteType']
        const original = entry['original']
        notes.set(vaultPath, {
            id: entry['id'],
            vaultPath,
            path: canonicalPath(vaultPath),
            file: `-/note/${entry['id']}.html`,
            markdownFile: `-/md/${entry['id']}.md`,
            aliases: [...entry['aliases']],
            formerPaths: formerPathsCopy(entry['formerPaths']),
            title: (vaultPath.split('/').at(-1) ?? vaultPath).replace(/\.md$/, ''),
            firstPublished: entry['firstPublished'],
            lastPublished: entry['lastPublished'],
            links: entry['links'].map((item) => ({ link: item.link, path: item.path })),
            attachments: entry['attachments'].map((item) => ({
                link: item.link,
                key: item.hash.slice('sha256:'.length),
                url: attachmentPath(item.hash, item.path),
                name: item.path.slice(item.path.lastIndexOf('/') + 1),
                ...(item.width === undefined || item.height === undefined
                    ? {}
                    : { width: item.width, height: item.height })
            })),
            ...(isNoteType(noteType) ? { noteType } : {}),
            ...(isOriginal(original) ? { original: original.url } : {})
        })
    }
    // In the order of the paths, so that two builds of one content store give
    // the same files.
    const byPath = (one: { vaultPath: string }, two: { vaultPath: string }): number =>
        one.vaultPath < two.vaultPath ? -1 : one.vaultPath > two.vaultPath ? 1 : 0
    return {
        notes: [...notes.values()].sort(byPath),
        removed: [...removed.values()].sort(byPath),
        firstRuns
    }
}

/** The text of the cleaned note of a published note, as the content store holds it. */
export async function readCleanedNote(vaultPath: string): Promise<string> {
    return await readFile(join(notesFolder(), vaultPath), 'utf8')
}

/**
 * The redirect list of the content store (`redirects.json`, issue 44): an
 * empty list when the build has no content store or the store has no list.
 *
 * @throws when the file cannot be read as a redirect list: the build stops
 */
export async function readRedirectList(
    store: string | undefined = contentStoreFolder()
): Promise<RedirectList> {
    const empty: RedirectList = { redirects: [], gone: [], prefixes: [] }
    if (store === undefined) {
        return empty
    }
    // The build runs in Node: no API of Bun here.
    let text: string
    try {
        text = await readFile(join(store, REDIRECT_LIST_FILE), 'utf8')
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            return empty
        }
        throw new Error(`${REDIRECT_LIST_FILE} of the content store cannot be read`, {
            cause: error
        })
    }
    let value: unknown
    try {
        value = JSON.parse(text)
    } catch {
        // The message of the parser can quote the file: it names only the file.
        throw new Error(`${REDIRECT_LIST_FILE} of the content store is not JSON`)
    }
    return redirectListFrom(value)
}

/**
 * The noindex folders of the configuration of the content store (R103): an
 * empty list when the build has no content store, or the store has no
 * `configuration.json` or no list. The reader of the publishing tool checks
 * the file, so the build accepts and refuses what the tool does.
 *
 * @throws when the file cannot be read as a configuration: the build stops
 */
export async function readNoindexFolders(
    store: string | undefined = contentStoreFolder()
): Promise<readonly string[]> {
    if (store === undefined) {
        return []
    }
    let text: string
    try {
        text = await readFile(join(store, CONFIGURATION_FILE), 'utf8')
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            return []
        }
        throw new Error(`${CONFIGURATION_FILE} of the content store cannot be read`, {
            cause: error
        })
    }
    return parseConfiguration(text).noindexFolders
}
