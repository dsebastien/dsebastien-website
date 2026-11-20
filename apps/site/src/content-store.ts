import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { attachmentPath, canonicalPath } from '@dsebastien-website/resolver'

// The content store as the build reads it (BUILD-01 of the spec). The build
// never reads the vault: the content store holds the cleaned notes and the
// manifest, and nothing else is published.
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

/** The form of a time of the manifest: UTC, to the second (canonical form, rule 9). */
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

/** True when the value is a time of the manifest. */
function isTime(value: unknown): value is string {
    return typeof value === 'string' && TIME.test(value)
}

/** The form of the identity of a note. It becomes the name of a file of the site. */
const NOTE_ID = /^[0-9a-f]{16}$/

/**
 * Reads the published notes from the manifest, in the order of their paths.
 *
 * It throws, and so stops the build, when the content store cannot be
 * trusted: the folder that the variable names does not exist, a file of the
 * manifest is not an entry, or two entries have the same path.
 */
export async function readPublishedNotes(): Promise<PublishedNote[]> {
    const store = contentStoreFolder()
    if (store === undefined) {
        return []
    }
    try {
        if (!(await stat(store)).isDirectory()) {
            throw new Error('not a folder')
        }
    } catch {
        throw new Error(`CONTENT_STORE is not a folder: "${store}"`)
    }
    let files: string[]
    try {
        files = await readdir(join(store, 'manifest'))
    } catch {
        // A content store with no publication yet has no manifest.
        return []
    }
    const notes = new Map<string, PublishedNote>()
    for (const file of files.filter((name) => name.endsWith('.json')).sort()) {
        const entry: unknown = JSON.parse(await readFile(join(store, 'manifest', file), 'utf8'))
        if (
            !isRecord(entry) ||
            typeof entry['id'] !== 'string' ||
            !NOTE_ID.test(entry['id']) ||
            typeof entry['path'] !== 'string' ||
            !isLinkList(entry['links']) ||
            !isTextList(entry['aliases']) ||
            !isTime(entry['firstPublished']) ||
            !isTime(entry['lastPublished']) ||
            !isAttachmentList(entry['attachments'])
        ) {
            throw new Error(`manifest/${file} is not a manifest entry`)
        }
        if (entry['state'] !== 'published') {
            continue
        }
        const vaultPath = entry['path']
        if (notes.has(vaultPath)) {
            throw new Error(`two entries of the manifest have the path "${vaultPath}"`)
        }
        notes.set(vaultPath, {
            id: entry['id'],
            vaultPath,
            path: canonicalPath(vaultPath),
            file: `-/note/${entry['id']}.html`,
            markdownFile: `-/md/${entry['id']}.md`,
            aliases: [...entry['aliases']],
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
            }))
        })
    }
    // In the order of the paths, so that two builds of one content store give
    // the same files.
    return [...notes.values()].sort((one, two) =>
        one.vaultPath < two.vaultPath ? -1 : one.vaultPath > two.vaultPath ? 1 : 0
    )
}

/** The text of the cleaned note of a published note, as the content store holds it. */
export async function readCleanedNote(vaultPath: string): Promise<string> {
    return await readFile(join(notesFolder(), vaultPath), 'utf8')
}
