import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { canonicalPath } from '@dsebastien-website/resolver'

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
    /** The title of the page. A first version: the file name of the note. */
    title: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads the published notes from the manifest, in the order of their paths. */
export async function readPublishedNotes(): Promise<PublishedNote[]> {
    const store = contentStoreFolder()
    if (store === undefined) {
        return []
    }
    let files: string[]
    try {
        files = await readdir(join(store, 'manifest'))
    } catch {
        return []
    }
    const notes: PublishedNote[] = []
    for (const file of files.filter((name) => name.endsWith('.json'))) {
        const entry: unknown = JSON.parse(await readFile(join(store, 'manifest', file), 'utf8'))
        if (
            !isRecord(entry) ||
            typeof entry['id'] !== 'string' ||
            typeof entry['path'] !== 'string'
        ) {
            throw new Error(`manifest/${file} is not a manifest entry`)
        }
        if (entry['state'] !== 'published') {
            continue
        }
        const vaultPath = entry['path']
        notes.push({
            id: entry['id'],
            vaultPath,
            path: canonicalPath(vaultPath),
            file: `-/note/${entry['id']}.html`,
            title: (vaultPath.split('/').at(-1) ?? vaultPath).replace(/\.md$/, '')
        })
    }
    return notes.sort((one, two) => (one.vaultPath < two.vaultPath ? -1 : 1))
}
