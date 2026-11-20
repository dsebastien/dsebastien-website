import { foldedForm, type ResolverMap } from './resolver.ts'
import { canonicalPath, folderPath, markdownPath } from './url.ts'

// What the site has, from its published notes: the folders, the names, the
// aliases, and the resolver map. The build uses it, so the resolver map and
// the pages of the build come from one place.

/** A published note, as the manifest names it. */
export interface SiteNote {
    /** The vault path of the note. */
    readonly path: string
    /** The aliases of the note that get a URL. */
    readonly aliases: readonly string[]
}

/** A folder of the site: a folder of the vault path of a published note. */
export interface SiteFolder {
    /** The vault path of the folder. */
    readonly path: string
    /** The vault path of its folder note (`Folder/Folder.md`), when that note is published. */
    readonly note?: string
    /** The vault paths of the published notes directly inside it, sorted. */
    readonly notes: readonly string[]
    /** The vault paths of the folders directly inside it, sorted. */
    readonly folders: readonly string[]
}

/** The files of the build, by what they are. */
export interface SiteFiles {
    readonly home: string
    readonly notFound: string
    readonly robots: string
    /** The file of the page of a note, from its vault path. */
    page(path: string): string
    /** The file of the Markdown of a note, from its vault path. */
    markdown(path: string): string
    /** The file of the generated list of a folder without a folder note, from the vault path of the folder. */
    folder(path: string): string
    /** The file of the "not found" page that names several notes, from their vault paths. */
    choice(paths: readonly string[]): string
}

/**
 * The order of the code points, as the publishing tool sorts
 * (`apps/plugin/src/publishing/order.ts`): never the default order of texts,
 * which compares UTF-16 units.
 */
function compareCodePoints(one: string, two: string): number {
    const first = one[Symbol.iterator]()
    const second = two[Symbol.iterator]()
    for (;;) {
        const left = first.next()
        const right = second.next()
        if (left.done === true || right.done === true) {
            // The text that ends first comes first.
            return (left.done === true ? 0 : 1) - (right.done === true ? 0 : 1)
        }
        const difference = (left.value.codePointAt(0) ?? 0) - (right.value.codePointAt(0) ?? 0)
        if (difference !== 0) {
            return difference
        }
    }
}

function sorted(texts: Iterable<string>): string[] {
    return [...new Set(texts)].sort(compareCodePoints)
}

function parentOf(path: string): string | undefined {
    const slash = path.lastIndexOf('/')
    return slash < 0 ? undefined : path.slice(0, slash)
}

function nameOf(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1)
}

/** The folders of the published notes, sorted by path, each with its folder note when it is published (URL-16). */
export function foldersOf(notes: readonly SiteNote[]): SiteFolder[] {
    const published = new Set(notes.map((note) => note.path))
    const inside = new Map<string, { notes: string[]; folders: Set<string> }>()
    const at = (folder: string): { notes: string[]; folders: Set<string> } => {
        let entry = inside.get(folder)
        if (entry === undefined) {
            entry = { notes: [], folders: new Set() }
            inside.set(folder, entry)
        }
        return entry
    }
    for (const note of notes) {
        let folder = parentOf(note.path)
        if (folder !== undefined) {
            at(folder).notes.push(note.path)
        }
        while (folder !== undefined) {
            const parent = parentOf(folder)
            if (parent !== undefined) {
                at(parent).folders.add(folder)
            }
            at(folder)
            folder = parent
        }
    }
    return sorted(inside.keys()).map((path) => {
        const entry = at(path)
        const note = `${path}/${nameOf(path)}.md`
        return {
            path,
            ...(published.has(note) ? { note } : {}),
            notes: sorted(entry.notes),
            folders: sorted(entry.folders)
        }
    })
}

/** Groups vault paths by a folded key. */
function byFolded(entries: Iterable<[string, string]>): Map<string, string[]> {
    const groups = new Map<string, string[]>()
    for (const [key, path] of entries) {
        const folded = foldedForm(key)
        groups.set(folded, [...(groups.get(folded) ?? []), path])
    }
    return new Map([...groups].map(([key, paths]) => [key, sorted(paths)]))
}

/** The file names and the aliases of the notes, each with the vault paths of its notes. */
function namesAndAliases(notes: readonly SiteNote[]): {
    names: Map<string, string[]>
    aliases: Map<string, string[]>
} {
    return {
        names: byFolded(
            notes.map((note): [string, string] => [
                nameOf(note.path).slice(0, -'.md'.length),
                note.path
            ])
        ),
        aliases: byFolded(
            notes.flatMap((note) =>
                note.aliases.map((alias): [string, string] => [alias, note.path])
            )
        )
    }
}

/** Each list of more than one note that a file name or an alias names: each one gets a "not found" page with its notes. */
export function choicesOf(notes: readonly SiteNote[]): string[][] {
    const { names, aliases } = namesAndAliases(notes)
    const lists = new Map<string, string[]>()
    for (const paths of [...names.values(), ...aliases.values()]) {
        if (paths.length > 1) {
            lists.set(paths.join('\n'), paths)
        }
    }
    return [...lists.values()]
}

/** The prefix of the generated pages and files (URL-08). No note has a path under it. */
const GENERATED = '/-/'

/**
 * The resolver map of the site of these notes.
 *
 * @param attachments the key of each hashed path of an attachment that a page uses
 * @param generated the file of each other generated page of the build, by its
 * path under `/-/` (the page with every backlink of a note)
 */
export function resolverMapOf(
    notes: readonly SiteNote[],
    files: SiteFiles,
    attachments: Readonly<Record<string, string>> = {},
    generated: Readonly<Record<string, string>> = {}
): ResolverMap {
    const ordered = [...notes].sort((one, two) => compareCodePoints(one.path, two.path))
    const pages: Record<string, string> = { '/': files.home }
    for (const [path, file] of Object.entries(generated)) {
        if (!path.startsWith(GENERATED)) {
            throw new Error(`"${path}" is not the path of a generated page`)
        }
        pages[path] = file
    }
    const siteFiles: Record<string, { file: string; type: 'markdown' | 'text' }> = {
        '/robots.txt': { file: files.robots, type: 'text' }
    }
    // A map, not an object: a text such as "constructor" or "__proto__" is a
    // key like any other.
    const folded = new Map<string, string>()
    const fold = (text: string, path: string): void => {
        const key = foldedForm(text)
        if (!folded.has(key)) {
            folded.set(key, path)
        }
    }
    for (const note of ordered) {
        const path = canonicalPath(note.path)
        pages[path] = files.page(note.path)
        siteFiles[markdownPath(note.path)] = { file: files.markdown(note.path), type: 'markdown' }
        fold(note.path.slice(0, -'.md'.length), path)
    }
    // A note and a folder with the same text: the note wins (URL-16).
    for (const folder of foldersOf(ordered)) {
        const target =
            folder.note === undefined ? folderPath(folder.path) : canonicalPath(folder.note)
        if (folder.note === undefined) {
            pages[target] ??= files.folder(folder.path)
        }
        fold(folder.path, target)
    }
    const { names, aliases } = namesAndAliases(ordered)
    const urls = (map: Map<string, string[]>): Record<string, string[]> =>
        Object.fromEntries([...map].map(([key, paths]) => [key, paths.map(canonicalPath)]))
    const choices: Record<string, string> = {}
    for (const paths of choicesOf(ordered)) {
        choices[paths.map(canonicalPath).join('\n')] = files.choice(paths)
    }
    return {
        pages,
        files: siteFiles,
        attachments,
        folded: Object.fromEntries(folded),
        names: urls(names),
        aliases: urls(aliases),
        choices,
        notFound: files.notFound
    }
}
