import { createHash } from 'node:crypto'
import {
    backlinksPath,
    canonicalPath,
    choicesOf,
    folderPath,
    foldersOf,
    LIBRARY_PATH,
    resolverMapOf,
    SEARCH_PATH,
    type ResolverMap,
    type SiteFiles,
    type SiteFolder
} from '@dsebastien-website/resolver'
import type { PublishedNote } from './content-store.ts'
import type { NoteList } from './generated-pages.ts'

// The files of the build, by what they are, and the resolver map that leads
// each path of the site to one of them. A generated file lives under `-/`
// (URL-08), with a name that is plain ASCII on every system and every host.

/** 16 hexadecimal digits of the SHA-256 of a text: the name of a generated file. */
function shortHash(text: string): string {
    return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/** The id of the page of a folder, from its vault path. */
export function folderId(path: string): string {
    return shortHash(path)
}

/** The id of the "not found" page that names several notes, from their vault paths. */
export function choiceId(paths: readonly string[]): string {
    return shortHash(paths.join('\n'))
}

/** The files of the build for these published notes. */
export function siteFilesOf(notes: readonly PublishedNote[]): SiteFiles {
    const byPath = new Map(notes.map((note) => [note.vaultPath, note]))
    const noteOf = (path: string): PublishedNote => {
        const note = byPath.get(path)
        if (note === undefined) {
            throw new Error(`"${path}" is not a published note`)
        }
        return note
    }
    return {
        home: 'index.html',
        notFound: '404.html',
        robots: 'robots.txt',
        page: (path) => noteOf(path).file,
        markdown: (path) => noteOf(path).markdownFile,
        folder: (path) => `-/folder/${folderId(path)}.html`,
        choice: (paths) => `-/choice/${choiceId(paths)}.html`
    }
}

/** The site notes of the resolver: the vault path and the aliases of each published note. */
function siteNotesOf(notes: readonly PublishedNote[]): { path: string; aliases: string[] }[] {
    return notes.map((note) => ({ path: note.vaultPath, aliases: note.aliases }))
}

/** The file of the page with every backlink of a note, from the identity of the note. */
export function backlinksFile(id: string): string {
    return `-/backlinks/${id}.html`
}

/**
 * The name of the file of a page of a list, without `.html`: the canonical
 * name of a note type (`movies`), a hash of a tag, which can hold any
 * letter, or a recent list (`added`, `added.movies`: a type name starts with
 * a letter); then the number of a later page after a dot (`movies.2`).
 */
export function listPageId(list: Pick<NoteList, 'kind' | 'key'>, page: number): string {
    const name = list.kind === 'tag' ? shortHash(list.key) : list.key.replace('/', '.')
    return page === 1 ? name : `${name}.${String(page)}`
}

/** The file of a page of a list, relative to the output of the build. */
export function listPageFile(list: Pick<NoteList, 'kind' | 'key'>, page: number): string {
    const folder = { type: 'types', tag: 'tags', other: 'other', recent: 'recent' }[list.kind]
    return `-/${folder}/${listPageId(list, page)}.html`
}

/** The file of the library. */
export const LIBRARY_FILE = '-/library.html'

/** The file of the search page. */
export const SEARCH_FILE = '-/search.html'

/**
 * The resolver map of the site of these published notes.
 *
 * @param withBacklinksPage the notes that have a page with every backlink
 * @param lists the type hubs and the tag pages
 */
export function resolverMapFor(
    notes: readonly PublishedNote[],
    withBacklinksPage: readonly PublishedNote[] = [],
    lists: readonly NoteList[] = []
): ResolverMap {
    const attachments: Record<string, string> = {}
    for (const note of notes) {
        for (const file of note.attachments) {
            attachments[file.url] = file.key
        }
    }
    const generated: Record<string, string> = {}
    for (const note of withBacklinksPage) {
        generated[backlinksPath(note.id)] = backlinksFile(note.id)
    }
    generated[LIBRARY_PATH] = LIBRARY_FILE
    generated[SEARCH_PATH] = SEARCH_FILE
    for (const list of lists) {
        for (const page of list.pages) {
            generated[page.path] = listPageFile(list, page.number)
        }
    }
    return resolverMapOf(siteNotesOf(notes), siteFilesOf(notes), attachments, generated)
}

/** The folders that get a generated list: the folders without a published folder note (URL-16). */
export function listedFoldersOf(notes: readonly PublishedNote[]): SiteFolder[] {
    return foldersOf(siteNotesOf(notes)).filter((folder) => folder.note === undefined)
}

/** The lists of several notes that one file name or one alias names. */
export function choiceListsOf(notes: readonly PublishedNote[]): string[][] {
    return choicesOf(siteNotesOf(notes))
}

/** The link of a folder in a list: its folder note when it has one, else its own list. */
export function folderLinkOf(folder: SiteFolder): string {
    return folder.note === undefined ? folderPath(folder.path) : canonicalPath(folder.note)
}
