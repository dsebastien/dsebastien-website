import { samplePng } from '@dsebastien-website/testing'
import type { EditAction } from '../../apps/plugin/src/publishing/edits.ts'
import type { Selection } from '../../apps/plugin/src/publishing/plan.ts'

// The cases of the random parity test (issue 112): a small vault, its deny
// list, and steps that an author, a plugin and another device take. A case
// comes from a seed alone, so the same seed gives the same case again. The
// steps have the shape of the steps of the shared queue scenarios
// (`fixtures/canonical/queue.json`), without what they state: the run of
// both implementations states it.

/** A file of the vault: a text, or bytes in hexadecimal. */
export type FileContent = string | { bytes: string }

/** One step of a case, in the shape of a step of the shared queue scenarios. */
export type Action =
    | { do: 'write'; why: string; files: Record<string, FileContent> }
    | { do: 'delete'; why: string; paths: string[] }
    | { do: 'store'; why: string; files: Record<string, string> }
    | { do: 'status'; why: string }
    | { do: 'plan'; why: string; selection: Selection }
    | { do: 'publish'; why: string; selection: Selection; time: string }
    | { do: 'unpublish'; why: string; paths: string[]; time: string; accept?: string[] }
    | { do: 'takedown'; why: string; paths: string[]; time: string }
    | { do: 'edit'; why: string; action: EditAction; path: string; time: string }
    | { do: 'guards'; why: string }

export interface Case {
    seed: number
    denyList: string[]
    vault: Record<string, FileContent>
    steps: Action[]
}

/**
 * A small generator of numbers from a seed (mulberry32). It is written here,
 * so that a seed gives the same case on every machine and with every version
 * of Bun.
 */
export class Random {
    private state: number

    constructor(seed: number) {
        this.state = seed >>> 0
    }

    /** A number from 0 (included) to 1 (excluded). */
    next(): number {
        this.state = (this.state + 0x6d2b79f5) >>> 0
        let value = this.state
        value = Math.imul(value ^ (value >>> 15), value | 1)
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296
    }

    /** True with the chance `chance`. */
    chance(chance: number): boolean {
        return this.next() < chance
    }

    /** A whole number from `low` to `high`, both included. */
    between(low: number, high: number): number {
        return low + Math.floor(this.next() * (high - low + 1))
    }

    /** One item of a list that is not empty. */
    pick<T>(items: readonly T[]): T {
        const item = items[Math.floor(this.next() * items.length)]
        if (item === undefined) {
            throw new Error('there is nothing to pick')
        }
        return item
    }

    /** Each item of the list with the chance `chance`, in the order of the list. */
    some<T>(items: readonly T[], chance: number): T[] {
        return items.filter(() => this.chance(chance))
    }
}

/** The folder of the deny list that always has a note, so that the list names a folder of the vault. */
const SHED = 'Shed'
/** A note that no step moves or deletes: it keeps the folder of the deny list in the vault. */
const INVENTORY = `${SHED}/Inventory.md`
/** Folders where notes live. The empty text is the root of the vault. */
const FOLDERS = ['', 'Garden', 'Garden/Herbs', 'Écrits', SHED]
/** The folders that an edit of the guards can name. */
const GUARD_FOLDERS = FOLDERS.filter((folder) => folder !== '')
/**
 * Names of notes: two of them are outside ASCII, and two have an order that
 * differs between the code points and the UTF-16 units. No two of them differ
 * only in their letter case, which a file system of Windows or macOS cannot
 * hold in one folder.
 */
const NAMES = ['Alpha', 'Beta', 'Crème brûlée', 'Mint', 'Zeta', '🌱 Sprout', '～ Pond']
/** The folder renames that a step can make, to a folder that does not exist yet. */
const FOLDER_MOVES: readonly (readonly [string, string])[] = [
    ['Garden/Herbs', 'Garden/Plants'],
    ['Garden', 'Yard'],
    ['Écrits', 'Writing']
]
/** An image that notes can use, and an image in the folder of the deny list. */
const IMAGE = 'Attachments/pic.png'
const LOCKED_IMAGE = `${SHED}/key.png`
/** The folder of the rename journals, and the journals of two devices. */
const JOURNALS = '.obsidian/plugins/dsebastien-vault-publish/renames'
const DEVICES = ['00000000000000aa', '00000000000000bb']
/** The time of the first step. Each step comes one hour after the step before it. */
const START = Date.parse('2031-04-01T08:00:00Z')
const IGNORED = /^publish_ignore: (true|yes)\r?$/mu

function pathOf(folder: string, name: string): string {
    return folder === '' ? `${name}.md` : `${folder}/${name}.md`
}

function under(path: string, folder: string): boolean {
    return path.startsWith(`${folder}/`)
}

/** The bytes of a small image, the same for a seed, in hexadecimal. */
function imageBytes(seed: number): FileContent {
    return { bytes: samplePng(2, 2, 120, seed).toHex() }
}

/** A move of notes or of a folder: the paths that go, and the files that come. */
interface Move {
    do: 'move'
    why: string
    from: string[]
    files: Record<string, FileContent>
}

/**
 * What the generator knows of the vault while it writes the steps. Its view
 * of the site is a guess: it makes most steps ones that the tool accepts, and
 * the run of the implementations says what really happens.
 */
class Model {
    readonly files = new Map<string, FileContent>()
    /** Every note path that the vault had: a step can name a path that is gone. */
    readonly seen = new Set<string>()
    /** The notes that the generator thinks are on the site. */
    readonly published = new Set<string>()
    /** The old paths of published notes that a journal moved into a guard. */
    readonly intoGuard = new Set<string>()
    readonly journals = new Map<string, string>()
    private version = 0

    constructor(
        private readonly random: Random,
        public denyList: string[]
    ) {}

    notes(): string[] {
        return [...this.files.keys()].filter((path) => path.endsWith('.md')).sort()
    }

    /**
     * The notes that a step may move or delete: not the last note of a
     * folder of the deny list, since a deny list that names no folder of the
     * vault refuses every run.
     */
    movable(): string[] {
        const notes = this.notes()
        return notes.filter(
            (path) =>
                path !== INVENTORY &&
                !this.denyList.some(
                    (folder) =>
                        under(path, folder) &&
                        notes.filter((note) => under(note, folder)).length === 1
                )
        )
    }

    /** True when a guard excludes the note: the deny list or the ignore property. */
    guarded(path: string): boolean {
        const content = this.files.get(path)
        return (
            this.denyList.some((folder) => under(path, folder)) ||
            (typeof content === 'string' && IGNORED.test(content))
        )
    }

    /** The notes that a publication may include. */
    candidates(): string[] {
        return this.notes().filter((path) => !this.guarded(path))
    }

    /**
     * A new text for a note: properties, a body with links, and sometimes an
     * image. `ignore` is the chance of the ignore property.
     */
    text(ignore = 0.15): string {
        const random = this.random
        this.version += 1
        const lines: string[] = []
        if (random.chance(0.6)) {
            lines.push('tags: a')
        }
        if (random.chance(ignore)) {
            lines.push(random.pick(['publish_ignore: true', 'publish_ignore: yes']))
        } else if (random.chance(0.05)) {
            lines.push('publish_ignore: false')
        }
        if (random.chance(0.1)) {
            lines.push('public_note: true')
        }
        if (random.chance(0.1)) {
            lines.push(`aliases: [${random.pick(NAMES)} again]`)
        }
        const links = random
            .some(NAMES, 0.25)
            .map((name) => (random.chance(0.3) ? `[[${name}|the ${name}]]` : `[[${name}]]`))
        if (random.chance(0.3)) {
            links.push(random.chance(0.7) ? '![[pic.png]]' : '![[key.png]]')
        }
        const body = [`Text ${String(this.version)}.`, ...links].join(' ')
        const text =
            lines.length > 0 || random.chance(0.3)
                ? ['---', ...lines, '---', body, ''].join('\n')
                : `${body}\n`
        return random.chance(0.1) ? text.replaceAll('\n', '\r\n') : text
    }

    /** A free note path, or undefined when the tries all hit a used path. */
    freePath(): string | undefined {
        for (let attempt = 0; attempt < 8; attempt++) {
            const path = pathOf(this.random.pick(FOLDERS), this.random.pick(NAMES))
            if (!this.files.has(path)) {
                return path
            }
        }
        return undefined
    }

    write(path: string, content: FileContent): void {
        this.files.set(path, content)
        if (path.endsWith('.md')) {
            this.seen.add(path)
        }
    }

    /**
     * Moves a file. A published note moves on the site when the journal has
     * the move; a move into a guard keeps the old path on the site, which the
     * next plan removes.
     */
    move(from: string, to: string, journaled: boolean): FileContent | undefined {
        const content = this.files.get(from)
        if (content === undefined) {
            return undefined
        }
        this.files.delete(from)
        this.write(to, content)
        if (journaled && this.published.has(from)) {
            if (this.guarded(to)) {
                this.intoGuard.add(from)
            } else {
                this.published.delete(from)
                this.published.add(to)
            }
        }
        return content
    }

    /** Adds a line to the rename journal of a device, as the plugin writes it, and gives the journal file. */
    journal(from: string, to: string, time: string, kind: 'note' | 'folder'): [string, string] {
        const file = `${JOURNALS}/${this.random.pick(DEVICES)}.jsonl`
        const text = `${this.journals.get(file) ?? ''}${JSON.stringify({ from, kind, time, to })}\n`
        this.journals.set(file, text)
        return [file, text]
    }

    /** The notes on the site that a guard excludes now: each plan removes them (forced removals). */
    lost(): string[] {
        return [...this.published]
            .filter(
                (path) => this.intoGuard.has(path) || (this.files.has(path) && this.guarded(path))
            )
            .sort()
    }

    /** The published notes that are still in the vault. */
    live(): string[] {
        return [...this.published].filter((path) => this.files.has(path)).sort()
    }

    /** Takes notes off the site, as far as the generator knows. */
    takeOff(paths: readonly string[]): void {
        for (const path of paths) {
            this.published.delete(path)
            this.intoGuard.delete(path)
        }
    }

    /** What a publication of the selection does to the site, as far as the generator knows. */
    publish(selection: Selection): void {
        this.takeOff(this.lost())
        this.takeOff(selection.remove ?? [])
        for (const pairing of selection.pair ?? []) {
            if (this.published.delete(pairing.from)) {
                this.published.add(pairing.to)
            }
        }
        for (const path of selection.include) {
            if (this.files.has(path) && !this.guarded(path)) {
                this.published.add(path)
            }
        }
    }
}

/** Some paths of a list, mostly a good one, and sometimes a path that the tool refuses. */
function pathsFrom(random: Random, model: Model, good: readonly string[]): string[] {
    const paths = random.some(good, 0.4)
    if (paths.length === 0 && good.length > 0) {
        paths.push(random.pick(good))
    }
    if (paths.length === 0 || random.chance(0.1)) {
        paths.push(random.pick([...model.seen]))
    }
    return [...new Set(paths)]
}

/** A selection of a publication: mostly one that the tool accepts, sometimes not. */
function selectionOf(random: Random, model: Model): Selection {
    const candidates = model.candidates()
    const published = model.live()
    const include = random.some(candidates, 0.6)
    // Sometimes a note under a guard, or a path that is gone: both refuse the plan.
    if (random.chance(0.06)) {
        include.push(random.pick([...model.seen]))
    }
    const taken = new Set(include)
    const hold = random.chance(0.2)
        ? random.some(
              published.filter((path) => !taken.has(path)),
              0.4
          )
        : []
    hold.forEach((path) => taken.add(path))
    const remove = random.chance(0.25)
        ? random.some([...model.published].filter((path) => !taken.has(path)).sort(), 0.4)
        : []
    const selection: { -readonly [Key in keyof Selection]: Selection[Key] } = { include }
    if (hold.length > 0) {
        selection.hold = hold
    }
    if (remove.length > 0) {
        selection.remove = remove
    }
    // A pairing: a published note that is gone, and a note that is there and not on the site.
    const gone = [...model.published]
        .filter((path) => !model.files.has(path) && !model.intoGuard.has(path))
        .sort()
    const fresh = candidates.filter((path) => !model.published.has(path))
    if (gone.length > 0 && fresh.length > 0 && random.chance(0.5)) {
        selection.pair = [{ from: random.pick(gone), to: random.pick(fresh) }]
    }
    // The command line names the forced removals that the author accepts (rule 10 of the edits of the guards).
    const lost = model.lost()
    if (lost.length > 0 && random.chance(0.8)) {
        selection.accept = lost
    }
    return selection
}

/** An edit of the guards: mostly one that the tool accepts. */
function guardEdit(random: Random, model: Model, time: string): Action {
    const action = random.pick(['deny', 'allow', 'ignore', 'unignore'] as const)
    const notes = model.movable()
    const fits = (path: string): boolean => {
        if (action === 'deny') {
            return !model.denyList.includes(path) && model.notes().some((note) => under(note, path))
        }
        if (action === 'allow') {
            return model.denyList.includes(path)
        }
        return (action === 'ignore') !== model.guarded(path)
    }
    const all = action === 'deny' || action === 'allow' ? GUARD_FOLDERS : notes
    const good = all.filter(fits)
    const path =
        good.length > 0 && random.chance(0.85)
            ? random.pick(good)
            : random.pick(all.length > 0 ? all : [INVENTORY])
    return { do: 'edit', why: `${action} ${path}`, action, path, time }
}

/** One step after the first, chosen with weights. Undefined when the chosen step cannot happen now. */
function nextAction(random: Random, model: Model, time: string): Action | Move | undefined {
    const roll = random.next()
    const movable = model.movable()
    if (roll < 0.24) {
        const selection = selectionOf(random, model)
        model.publish(selection)
        return { do: 'publish', why: 'a publication', selection, time }
    }
    if (roll < 0.29) {
        return { do: 'status', why: 'the queue' }
    }
    if (roll < 0.33) {
        return { do: 'plan', why: 'a plan', selection: selectionOf(random, model) }
    }
    if (roll < 0.43) {
        // An edit of a note, of a published one mostly. Its new text can have the ignore property.
        const published = movable.filter((path) => model.published.has(path))
        if (movable.length === 0) {
            return undefined
        }
        const path = random.pick(published.length > 0 && random.chance(0.7) ? published : movable)
        const text = model.text(0.25)
        model.write(path, text)
        return { do: 'write', why: `an edit of ${path}`, files: { [path]: text } }
    }
    if (roll < 0.49) {
        const path = model.freePath()
        if (path === undefined) {
            return undefined
        }
        const text = model.text()
        model.write(path, text)
        return { do: 'write', why: `a new note ${path}`, files: { [path]: text } }
    }
    if (roll < 0.53) {
        if (movable.length === 0) {
            return undefined
        }
        const path = random.pick(movable)
        model.files.delete(path)
        return { do: 'delete', why: `the author deletes ${path}`, paths: [path] }
    }
    if (roll < 0.67) {
        // A move of a note, of a published one mostly, into a guard sometimes,
        // with a line of the journal or without one (Obsidian was closed).
        const published = movable.filter((path) => model.published.has(path))
        if (movable.length === 0) {
            return undefined
        }
        const from = random.pick(published.length > 0 && random.chance(0.7) ? published : movable)
        const to = model.freePath()
        const journaled = random.chance(0.7)
        const content = to === undefined ? undefined : model.move(from, to, journaled)
        if (to === undefined || content === undefined) {
            return undefined
        }
        const files: Record<string, FileContent> = { [to]: content }
        if (journaled) {
            const [file, text] = model.journal(from, to, time, 'note')
            files[file] = text
        }
        return { do: 'move', why: `a move of ${from} to ${to}`, from: [from], files }
    }
    if (roll < 0.72) {
        const [from, to] = random.pick(FOLDER_MOVES)
        // A folder of the deny list stays: a deny list that names no folder refuses every run.
        if (model.denyList.some((folder) => folder === from || under(folder, from))) {
            return undefined
        }
        const paths = [...model.files.keys()]
        const moved = paths.filter((path) => under(path, from))
        if (moved.length === 0 || paths.some((path) => under(path, to))) {
            return undefined
        }
        const journaled = random.chance(0.8)
        const files: Record<string, FileContent> = {}
        for (const path of moved) {
            const target = `${to}${path.slice(from.length)}`
            const content = model.move(path, target, journaled)
            if (content !== undefined) {
                files[target] = content
            }
        }
        if (journaled) {
            const [file, text] = model.journal(from, to, time, 'folder')
            files[file] = text
        }
        return { do: 'move', why: `a rename of the folder ${from} to ${to}`, from: [from], files }
    }
    if (roll < 0.8) {
        if (model.seen.size === 0) {
            return undefined
        }
        const paths = pathsFrom(random, model, model.live())
        const lost = model.lost()
        model.takeOff([...paths, ...lost])
        return {
            do: 'unpublish',
            why: 'an unpublish',
            paths,
            time,
            ...(lost.length > 0 && random.chance(0.8) ? { accept: lost } : {})
        }
    }
    if (roll < 0.87) {
        if (model.seen.size === 0) {
            return undefined
        }
        const paths = pathsFrom(random, model, [...model.published].sort())
        model.takeOff(paths)
        return { do: 'takedown', why: 'a takedown', paths, time }
    }
    if (roll < 0.96) {
        const edit = guardEdit(random, model, time)
        // An edit of the deny list for a folder with nothing on the site applies at once.
        if (
            edit.do === 'edit' &&
            edit.action === 'deny' &&
            ![...model.published].some((path) => under(path, edit.path))
        ) {
            model.denyList = [...model.denyList, edit.path]
        }
        return edit
    }
    if (roll < 0.98) {
        return { do: 'guards', why: 'the guards' }
    }
    // Another device changes the deny list.
    const notes = model.notes()
    const folders = GUARD_FOLDERS.filter(
        (folder) => folder !== SHED && notes.some((path) => under(path, folder))
    )
    const denyList = [SHED, ...random.some(folders, 0.3)]
    if (JSON.stringify(denyList) === JSON.stringify(model.denyList)) {
        return undefined
    }
    model.denyList = denyList
    return {
        do: 'store',
        why: 'another device changes the deny list',
        files: { 'configuration.json': JSON.stringify({ denyList }) }
    }
}

/** The time of a step, one hour after the step before it. */
function timeOf(index: number): string {
    return new Date(START + index * 3_600_000).toISOString().replace('.000Z', 'Z')
}

/** Splits a move into the steps of the shared scenarios: a delete, then a write. */
function expand(action: Action | Move): Action[] {
    if (action.do !== 'move') {
        return [action]
    }
    return [
        { do: 'delete', why: action.why, paths: action.from },
        { do: 'write', why: action.why, files: action.files }
    ]
}

/** The case of a seed. The same seed always gives the same case. */
export function caseOf(seed: number): Case {
    const random = new Random(seed)
    const denyList = [SHED, ...(random.chance(0.2) ? ['Garden/Herbs'] : [])]
    const model = new Model(random, denyList)
    model.write(INVENTORY, '---\ntags: a\n---\nA rake and a spade.\n')
    // Each folder of the deny list has a note: a deny list that names no folder refuses every run.
    if (denyList.includes('Garden/Herbs')) {
        model.write('Garden/Herbs/Mint.md', model.text(0))
    }
    if (random.chance(0.6)) {
        model.write(IMAGE, imageBytes(seed))
    }
    if (random.chance(0.3)) {
        model.write(LOCKED_IMAGE, imageBytes(seed + 1))
    }
    const count = random.between(2, 5)
    for (let index = 0; index < count; index++) {
        const path = model.freePath()
        if (path !== undefined) {
            model.write(path, model.text())
        }
    }
    const vault = Object.fromEntries(model.files)
    // The first step publishes some notes, so that the later steps have a site to change.
    const first = { include: random.some(model.candidates(), 0.8) }
    model.publish(first)
    const steps: Action[] = [
        { do: 'publish', why: 'a first publication', selection: first, time: timeOf(0) }
    ]
    const length = random.between(1, 4)
    for (let index = 1; index <= length; index++) {
        const action = nextAction(random, model, timeOf(index))
        if (action !== undefined) {
            steps.push(...expand(action))
        }
    }
    // The last step publishes, so that the plan shows what the steps before it did to the site.
    const last = selectionOf(random, model)
    steps.push({
        do: 'publish',
        why: 'a last publication',
        selection: last,
        time: timeOf(length + 1)
    })
    return { seed, denyList: [...denyList], vault, steps }
}
