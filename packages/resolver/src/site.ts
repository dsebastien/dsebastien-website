import {
    foldedForm,
    goneKey,
    type FormerMap,
    type GoneMap,
    type ResolverMap,
    type SiteFile
} from './resolver.ts'
import { canonicalPath, folderPath, markdownPath } from './url.ts'

// What the site has, from its published notes: the folders, the names, the
// aliases, and the resolver map. The build uses it, so the resolver map and
// the pages of the build come from one place.

/**
 * A path that a note had before a move, as the manifest holds it: with the
 * time of the move that left it (decision of the author R82), or a text alone,
 * which a content store written before R82 holds, with no time.
 */
export type FormerPath = string | { readonly path: string; readonly time: string }

/** The vault path of a former path. */
export function formerPathOf(former: FormerPath): string {
    return typeof former === 'string' ? former : former.path
}

/** A published note, as the manifest names it. */
export interface SiteNote {
    /** The vault path of the note. */
    readonly path: string
    /** The aliases of the note that get a URL. */
    readonly aliases: readonly string[]
    /** The vault paths that the note had before it moved (decision R66), with the time of each move (R82). */
    readonly formerPaths?: readonly FormerPath[]
}

/** The vault paths of the former paths of a note. */
function formerPathsOf(note: SiteNote): string[] {
    return (note.formerPaths ?? []).map(formerPathOf)
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
    /** The gone page (410). */
    readonly gone: string
    readonly robots: string
    /** The icon of the site at `/favicon.ico`, for a client that asks for it without a link (issue 133). */
    readonly icon: string
    /**
     * The other files at the root of the site, by their paths (issue 54): the
     * sitemap index, the sitemap files and the IndexNow key file. Each path
     * is one reserved root name (URL-09).
     */
    readonly root?: Readonly<Record<string, SiteFile>>
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
export function compareCodePoints(one: string, two: string): number {
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

/**
 * The note that held a former text last (decision of the author R82): the
 * note whose former path with that text has the latest time. A former path
 * with no time loses to one with a time. `undefined` when no former path has a
 * time, or when two notes have the latest time.
 */
function lastOwnerOf(
    holders: readonly { path: string; time: string | undefined }[]
): string | undefined {
    // The latest time of each note. A time is ASCII in one form, so its text
    // order is its time order.
    const latest = new Map<string, string>()
    let top: string | undefined
    for (const { path, time } of holders) {
        if (time === undefined) {
            continue
        }
        const before = latest.get(path)
        if (before === undefined || time > before) {
            latest.set(path, time)
        }
        if (top === undefined || time > top) {
            top = time
        }
    }
    const owners = [...latest].filter(([, time]) => time === top)
    return owners.length === 1 ? owners[0]?.[0] : undefined
}

/**
 * The former texts (the old vault paths without `.md`) and the former file
 * names of the notes, with the vault paths of their notes. A former text of
 * several notes names only the note that held it last, when there is one
 * (R82); a former file name names every note.
 */
function formersOf(notes: readonly SiteNote[]): {
    texts: Map<string, string[]>
    names: Map<string, string[]>
} {
    const pairs = notes.flatMap((note) =>
        formerPathsOf(note).map((former): [string, string] => [former, note.path])
    )
    const unique = (map: Map<string, string[]>): Map<string, string[]> =>
        new Map([...map].map(([key, paths]) => [key, sorted(paths)]))
    const holders = new Map<string, { path: string; time: string | undefined }[]>()
    for (const note of notes) {
        for (const former of note.formerPaths ?? []) {
            const key = foldedForm(formerPathOf(former).slice(0, -'.md'.length))
            holders.set(key, [
                ...(holders.get(key) ?? []),
                { path: note.path, time: typeof former === 'string' ? undefined : former.time }
            ])
        }
    }
    const texts = unique(
        byFolded(
            pairs.map(([former, path]): [string, string] => [former.slice(0, -'.md'.length), path])
        )
    )
    for (const [key, paths] of texts) {
        const owner = paths.length > 1 ? lastOwnerOf(holders.get(key) ?? []) : undefined
        if (owner !== undefined) {
            texts.set(key, [owner])
        }
    }
    return {
        texts,
        names: unique(
            byFolded(
                pairs.map(([former, path]): [string, string] => [
                    nameOf(former).slice(0, -'.md'.length),
                    path
                ])
            )
        )
    }
}

/** Each list of more than one note that a file name, an alias or a former path names: each one gets a "not found" page with its notes. */
export function choicesOf(notes: readonly SiteNote[]): string[][] {
    const { names, aliases } = namesAndAliases(notes)
    const formers = formersOf(notes)
    const lists = new Map<string, string[]>()
    for (const paths of [
        ...names.values(),
        ...aliases.values(),
        ...formers.texts.values(),
        ...formers.names.values()
    ]) {
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
 * @param removed the notes that the author unpublished: their addresses are
 * gone (410), unless a published note, folder or page has them (decision R64)
 */
export function resolverMapOf(
    notes: readonly SiteNote[],
    files: SiteFiles,
    attachments: Readonly<Record<string, string>> = {},
    generated: Readonly<Record<string, string>> = {},
    removed: readonly SiteNote[] = []
): ResolverMap {
    const ordered = [...notes].sort((one, two) => compareCodePoints(one.path, two.path))
    const pages: Record<string, string> = { '/': files.home }
    for (const [path, file] of Object.entries(generated)) {
        if (!path.startsWith(GENERATED)) {
            throw new Error(`"${path}" is not the path of a generated page`)
        }
        pages[path] = file
    }
    const siteFiles: Record<string, SiteFile> = {
        '/robots.txt': { file: files.robots, type: 'text' },
        '/favicon.ico': { file: files.icon, type: 'icon' }
    }
    for (const [path, file] of Object.entries(files.root ?? {})) {
        if (!/^\/[^/]+$/u.test(path) || path in siteFiles) {
            throw new Error(`"${path}" is not the path of another file at the root of the site`)
        }
        siteFiles[path] = file
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
        notFound: files.notFound,
        gone: goneMapOf(removed, files.gone),
        former: formerMapOf(ordered, removed, folded)
    }
}

/**
 * The former folders whose notes all moved to one folder (decision of the
 * author R82): for each folder of a former path of a published note, by its
 * folded form, the address of the one folder where those notes are now, as
 * the map gives it (its folder note or its folder page). A folder whose text
 * is the text of a current note or folder keeps that address, a folder whose
 * text is the text of an unpublished note stays gone (business rule 1), and a
 * folder whose notes moved to more than one folder, or to the root, is no
 * address. A former folder wins over a file name, an alias and a former file
 * name of another note: the resolver looks for it right after the former
 * paths and the rows of the redirect list.
 *
 * @param taken the folded texts of the unpublished notes
 */
function formerFoldersOf(
    notes: readonly SiteNote[],
    folded: ReadonlyMap<string, string>,
    taken: ReadonlySet<string>
): Record<string, string> {
    const targets = new Map<string, Set<string>>()
    for (const note of notes) {
        const now = parentOf(note.path)
        for (const former of formerPathsOf(note)) {
            const before = parentOf(former)
            if (before === undefined) {
                continue
            }
            const key = foldedForm(before)
            const set = targets.get(key) ?? new Set<string>()
            set.add(now === undefined ? '' : foldedForm(now))
            targets.set(key, set)
        }
    }
    // No prototype: a former folder `__proto__` is a key like any other (issue 121).
    const folders = Object.create(null) as Record<string, string>
    for (const key of [...targets.keys()].sort(compareCodePoints)) {
        const [now, ...others] = [...(targets.get(key) ?? [])]
        const target = now === undefined || now === '' ? undefined : folded.get(now)
        if (
            others.length === 0 &&
            now !== key &&
            !folded.has(key) &&
            !taken.has(key) &&
            target !== undefined
        ) {
            folders[key] = target
        }
    }
    return folders
}

/**
 * The former paths of the published notes (URL-06, URL-21, decision R66). The
 * last owner of an address wins (business rule 1): a former path that is now
 * the path of an unpublished note is gone, not a redirect.
 */
function formerMapOf(
    notes: readonly SiteNote[],
    removed: readonly SiteNote[],
    folded: ReadonlyMap<string, string>
): FormerMap {
    const taken = new Set(removed.map((note) => foldedForm(note.path.slice(0, -'.md'.length))))
    const takenMarkdown = new Set(removed.map((note) => markdownPath(note.path)))
    const { names } = formersOf(notes)
    const texts = new Map([...formersOf(notes).texts].filter(([text]) => !taken.has(text)))
    const urls = (map: Map<string, string[]>): Record<string, string[]> =>
        Object.fromEntries([...map].map(([key, paths]) => [key, paths.map(canonicalPath)]))
    // A former Markdown path, as it is written, leads to its one note, or
    // to the note that held it last (R82); else it names none.
    const markdown = new Map<string, { path: string; time: string | undefined }[]>()
    for (const note of notes) {
        for (const former of note.formerPaths ?? []) {
            const path = markdownPath(formerPathOf(former))
            if (takenMarkdown.has(path)) {
                continue
            }
            markdown.set(path, [
                ...(markdown.get(path) ?? []),
                {
                    path: markdownPath(note.path),
                    time: typeof former === 'string' ? undefined : former.time
                }
            ])
        }
    }
    const folders = formerFoldersOf(notes, folded, taken)
    return {
        folded: urls(texts),
        names: urls(names),
        ...(Object.keys(folders).length === 0 ? {} : { folders }),
        markdown: Object.fromEntries(
            [...markdown].flatMap(([path, holders]) => {
                const targets = new Set(holders.map((holder) => holder.path))
                const [only] = targets
                const target = targets.size === 1 ? only : lastOwnerOf(holders)
                return target === undefined ? [] : [[path, target]]
            })
        )
    }
}

/** The addresses of the unpublished notes (URL-27, decision R64). */
function goneMapOf(removed: readonly SiteNote[], file: string): GoneMap {
    const ordered = [...removed].sort((one, two) => compareCodePoints(one.path, two.path))
    // Keys, never texts: the map holds no title and no alias of these notes.
    const set = (texts: Iterable<string>): Record<string, true> =>
        Object.fromEntries(
            sorted([...texts].map(goneKey)).map((key): [string, true] => [key, true])
        )
    const { names, aliases } = namesAndAliases(ordered)
    // The former paths of an unpublished note are gone too (R64, R66).
    const formers = formersOf(ordered)
    const every = ordered.flatMap((note) => [note.path, ...formerPathsOf(note)])
    const paths = every.flatMap((path) => [canonicalPath(path), markdownPath(path)])
    const folded = [
        ...ordered.map((note) => foldedForm(note.path.slice(0, -'.md'.length))),
        ...formers.texts.keys()
    ]
    const goneNames = [...names.keys(), ...formers.names.keys()]
    const texts = [...paths, ...folded, ...goneNames, ...aliases.keys()]
    return {
        file,
        longest: Math.max(0, ...texts.map((text) => text.length)),
        paths: set(paths),
        folded: set(folded),
        names: set(goneNames),
        aliases: set(aliases.keys())
    }
}
