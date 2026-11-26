import { resolverMapFrom } from './map.ts'
import { resolve, type Resolution, type ResolverMap } from './resolver.ts'

// The resolver map in parts (issue 121, decision R94). The whole map of the
// published notes is tens of megabytes, and a new instance of the Worker that
// reads and parses it at its first request is slow. So the build cuts the map
// by a hash of each key into parts of a few kilobytes, and writes a small
// head with what is not a key (the lengths, the lists, the files of the error
// pages). A host reads the head one time, and a part only when a request
// looks for a key of it: the first request of an instance reads one part or
// a few, and the memory of an instance does not grow with the site. The parts
// are files of the release, so they switch and revert with it.
//
// The resolver is the same function as for the whole map (`resolve()`): it
// runs on a view of the parts that a request read so far, and notes each key
// whose part it lacks; the parts that it lacked are read, and it runs again.
// A request of a canonical path reads one part.

/** The folder of the map in parts in the output of the build. */
export const MAP_PARTS_FOLDER = '-/resolver-map'

/** The head of the map in parts. */
export const MAP_HEAD_FILE = `${MAP_PARTS_FOLDER}/head.json`

/** The file of a part of the map. */
export function mapPartFile(index: number): string {
    return `${MAP_PARTS_FOLDER}/${String(index)}.json`
}

/** The size of a part that the build aims at, in bytes of JSON. */
export const PART_BYTES = 32_000

/**
 * The records of the map that the resolver reads by a key: the parts hold
 * them. A record of a part of the map is named with a dot (`gone.paths`).
 */
const RECORDS = [
    'pages',
    'files',
    'attachments',
    'folded',
    'names',
    'aliases',
    'choices',
    'gone.paths',
    'gone.folded',
    'gone.names',
    'gone.aliases',
    'former.folded',
    'former.names',
    'former.markdown',
    'former.folders',
    'redirects.folded',
    'redirects.prefixes',
    'redirects.temporary'
] as const

/** The name of a record that the parts hold. */
export type RecordName = (typeof RECORDS)[number]

/** A part of the map: the entries of each record whose key is in this part. */
export type MapPart = Readonly<Partial<Record<RecordName, Readonly<Record<string, unknown>>>>>

/** The head of the map in parts. */
export interface MapHead {
    readonly version: 1
    /** The count of the parts: a power of two. */
    readonly parts: number
    /** The records that the map has. A record that it lacks stays out of the view. */
    readonly records: readonly RecordName[]
    /** The map without the records of the parts: the lengths, the lists, the files of the error pages. */
    readonly map: Readonly<Record<string, unknown>>
}

/**
 * The part of a key: FNV-1a (32 bits) of its UTF-16 units, modulo the count
 * of the parts. The build and every host compute it the same way.
 */
export function partOfKey(key: string, parts: number): number {
    let hash = 0x811c9dc5
    for (let index = 0; index < key.length; index += 1) {
        hash ^= key.charCodeAt(index)
        hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return hash % parts
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The record of a map by its name, or `undefined` when the map lacks it. */
function recordOf(map: Readonly<Record<string, unknown>>, name: RecordName): unknown {
    const [first, second] = name.split('.')
    const value = map[first ?? '']
    if (second === undefined) {
        return value
    }
    return isRecord(value) ? value[second] : undefined
}

/** A copy of the map without the records of the parts. */
function skeletonOf(map: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const parted = new Set<string>(RECORDS)
    const without = (value: Readonly<Record<string, unknown>>, prefix: string) =>
        Object.fromEntries(Object.entries(value).filter(([key]) => !parted.has(prefix + key)))
    return Object.fromEntries(
        Object.entries(without(map, '')).map(([key, value]) => [
            key,
            isRecord(value) ? without(value, `${key}.`) : value
        ])
    )
}

/** Sets the record of a name in a copy of a skeleton. */
function withRecord(
    map: Record<string, unknown>,
    name: RecordName,
    record: Readonly<Record<string, unknown>>
): void {
    const [first = '', second] = name.split('.')
    if (second === undefined) {
        map[first] = record
        return
    }
    const inner = map[first]
    map[first] = { ...(isRecord(inner) ? inner : {}), [second]: record }
}

/**
 * The map in parts: its head and its parts. The count of the parts is the
 * smallest power of two that keeps a part at `bytes` or less on average.
 */
export function mapPartsOf(
    map: ResolverMap,
    bytes = PART_BYTES
): { head: MapHead; parts: MapPart[] } {
    const plain = JSON.parse(JSON.stringify(map)) as Record<string, unknown>
    const whole = JSON.stringify(plain).length
    let count = 1
    while (count < whole / bytes) {
        count *= 2
    }
    const parts: Partial<Record<RecordName, Record<string, unknown>>>[] = Array.from(
        { length: count },
        () => ({})
    )
    const records: RecordName[] = []
    for (const name of RECORDS) {
        const record = recordOf(plain, name)
        if (!isRecord(record)) {
            continue
        }
        records.push(name)
        for (const [key, value] of Object.entries(record)) {
            const part = parts[partOfKey(key, count)]
            if (part !== undefined) {
                const entries = (part[name] ??= {})
                entries[key] = value
            }
        }
    }
    return { head: { version: 1, parts: count, records, map: skeletonOf(plain) }, parts }
}

/** The whole map of a head and of its parts. */
export function mapOfParts(head: MapHead, parts: readonly MapPart[]): ResolverMap {
    const map = JSON.parse(JSON.stringify(head.map)) as Record<string, unknown>
    for (const name of head.records) {
        const record: Record<string, unknown> = {}
        for (const part of parts) {
            Object.assign(record, part[name] ?? {})
        }
        withRecord(map, name, record)
    }
    // Built from the parts of one map: the shape is the one of that map.
    return map as unknown as ResolverMap
}

/**
 * The head of the map in parts that a value read from a release is.
 *
 * @throws when the value is not a head
 */
export function mapHeadFrom(value: unknown): MapHead {
    const refuse = (): never => {
        throw new Error(`${MAP_HEAD_FILE} is not the head of a resolver map in parts`)
    }
    if (
        !isRecord(value) ||
        value['version'] !== 1 ||
        typeof value['parts'] !== 'number' ||
        !Number.isInteger(value['parts']) ||
        value['parts'] < 1 ||
        Math.log2(value['parts']) % 1 !== 0 ||
        !Array.isArray(value['records']) ||
        !value['records'].every((name: unknown) => RECORDS.some((known) => known === name)) ||
        !isRecord(value['map'])
    ) {
        return refuse()
    }
    // Checked above, member by member.
    const head = value as unknown as MapHead
    try {
        resolverMapFrom(mapOfParts(head, []))
    } catch {
        return refuse()
    }
    return head
}

/**
 * The part of the map at `index` that a value read from a release is.
 *
 * @throws when the value is not that part: a record that the head does not
 * name, a value that a resolver map cannot hold, or a key of another part
 */
export function mapPartFrom(value: unknown, head: MapHead, index: number): MapPart {
    const refuse = (): never => {
        throw new Error(`${mapPartFile(index)} is not a part of the resolver map`)
    }
    if (!isRecord(value)) {
        return refuse()
    }
    for (const [name, record] of Object.entries(value)) {
        if (!head.records.some((known) => known === name) || !isRecord(record)) {
            return refuse()
        }
        for (const key of Object.keys(record)) {
            if (partOfKey(key, head.parts) !== index) {
                return refuse()
            }
        }
    }
    // Checked as a map with only this part.
    const part = value as MapPart
    try {
        resolverMapFrom(mapOfParts(head, [part]))
    } catch {
        return refuse()
    }
    return part
}

/** The stop of a run of the resolver at the first key whose part it lacks. */
class MissingPart extends Error {}

/**
 * A record of the view of a request: it answers a key from the parts that
 * the request read, and notes the part of a key that it lacks. With `stop`,
 * the run stops at that key.
 */
function recordView(
    name: RecordName,
    count: number,
    read: ReadonlyMap<number, MapPart>,
    missing: Set<number>,
    stop: boolean
): Record<string, unknown> {
    const valueOf = (key: string | symbol): { found: boolean; value?: unknown } => {
        if (typeof key !== 'string') {
            return { found: false }
        }
        const index = partOfKey(key, count)
        const part = read.get(index)
        if (part === undefined) {
            missing.add(index)
            if (stop) {
                throw new MissingPart()
            }
            return { found: false }
        }
        const record = part[name]
        return record !== undefined && Object.hasOwn(record, key)
            ? { found: true, value: record[key] }
            : { found: false }
    }
    return new Proxy<Record<string, unknown>>(
        {},
        {
            get: (_target, key) => valueOf(key).value,
            has: (_target, key) => valueOf(key).found,
            getOwnPropertyDescriptor(_target, key) {
                const { found, value } = valueOf(key)
                return found
                    ? { value, writable: false, enumerable: true, configurable: true }
                    : undefined
            },
            ownKeys() {
                throw new Error('a record of a map in parts has no list of its keys')
            }
        }
    )
}

/** The map that a request sees: the head, with a view of each record. */
function viewOf(
    head: MapHead,
    read: ReadonlyMap<number, MapPart>,
    missing: Set<number>,
    stop: boolean
): ResolverMap {
    const map = JSON.parse(JSON.stringify(head.map)) as Record<string, unknown>
    for (const name of head.records) {
        withRecord(map, name, recordView(name, head.parts, read, missing, stop))
    }
    // The view has the shape of the map: the head was checked as one.
    return map as unknown as ResolverMap
}

/** What a resolver of a map in parts takes. */
export interface PartedResolverOptions {
    /** The most parts that it keeps between requests. 128 by default. */
    readonly keep?: number
}

/**
 * The resolver of a map in parts: `resolve()` of the whole map, with the
 * parts that each request needs, read by `load`. A part that is read is kept
 * for the next requests, up to `keep` parts (the least recently used goes
 * first). A part that fails to load fails the request, and is not kept.
 */
export function partedResolver(
    head: MapHead,
    load: (index: number) => Promise<MapPart>,
    options: PartedResolverOptions = {}
): (path: string, query: string) => Promise<Resolution> {
    const keep = options.keep ?? 128
    const kept = new Map<number, Promise<MapPart>>()
    function part(index: number): Promise<MapPart> {
        const known = kept.get(index)
        if (known !== undefined) {
            // The most recently used is the last one.
            kept.delete(index)
            kept.set(index, known)
            return known
        }
        const read = load(index)
        kept.set(index, read)
        read.catch(() => {
            if (kept.get(index) === read) {
                kept.delete(index)
            }
        })
        for (const oldest of kept.keys()) {
            if (kept.size <= keep) {
                break
            }
            kept.delete(oldest)
        }
        return read
    }
    return async (path, query) => {
        const read = new Map<number, MapPart>()
        // Each run reads at least one part more, so the runs end.
        for (let run = 0; run <= head.parts; run += 1) {
            const missing = new Set<number>()
            // The first run stops at the first part that it lacks: a canonical
            // path then reads one part. The next runs go on past each part that
            // they lack, and read all of them at once.
            let answer: Resolution | undefined
            try {
                answer = resolve(path, viewOf(head, read, missing, run === 0), query)
            } catch (error) {
                if (!(error instanceof MissingPart)) {
                    throw error
                }
            }
            if (missing.size === 0 && answer !== undefined) {
                return answer
            }
            const parts = await Promise.all(
                [...missing].map(async (index) => [index, await part(index)] as const)
            )
            for (const [index, value] of parts) {
                read.set(index, value)
            }
        }
        throw new Error('the resolver asked for more parts than the map has')
    }
}
