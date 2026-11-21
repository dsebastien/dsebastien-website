// The note type of a note (decision R61, issue 49): the type that the
// Obsidian Starter Kit plugin of the vault gives it. The rules are in
// `documentation/Canonical Form.md`, section "The note type of a note". The
// Rust twin is `cli/src/note_types.rs`. Change both in the same commit.

// A type alias, not an interface: the canonical form takes any object of data.
/** The note type of a note, as the manifest entry and the record of a plan hold it. */
export type NoteType = {
    /** The canonical name of the type: `movies`, `permanent-notes`. */
    readonly name: string
    /** The display name of the type in the Starter Kit: `Movies`. */
    readonly displayName: string
    /** The prefix of the file names of the type, as the Starter Kit gives it, when it has one. */
    readonly prefix?: string
    /** The suffix of the file names of the type, as the Starter Kit gives it, when it has one. */
    readonly suffix?: string
}

/** The message of every answer that the tool refuses. */
const REFUSED = 'the Obsidian Starter Kit gave an answer that the tool cannot read'

/** A canonical name of a note type: a small letter, then small letters, digits, `-` and `_`, 64 characters at most. */
const CANONICAL_NAME = /^[a-z][a-z0-9_-]{0,63}$/

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The note type of each path of a question, from the answer of the Starter
 * Kit. A path with no type is not in the result. It throws when the answer
 * is not the document of the Starter Kit for exactly this question.
 */
export function readNoteTypes(question: readonly string[], answer: unknown): Map<string, NoteType> {
    const refuse = (why: string): never => {
        throw new Error(`${REFUSED}: ${why}`)
    }
    if (!isRecord(answer)) {
        return refuse('it is not an object')
    }
    const { noteTypes, notes } = answer
    if (!Array.isArray(noteTypes) || !Array.isArray(notes)) {
        return refuse('it has no list "noteTypes" or no list "notes"')
    }
    const definitions = new Map<string, NoteType>()
    for (const item of noteTypes) {
        if (!isRecord(item)) {
            return refuse('a type is not an object')
        }
        const { name, displayName, prefix, suffix } = item
        if (typeof name !== 'string' || !CANONICAL_NAME.test(name)) {
            return refuse(`a type has the name ${JSON.stringify(name)}`)
        }
        if (typeof displayName !== 'string' || displayName === '') {
            return refuse(`the type "${name}" has no display name`)
        }
        if (typeof prefix !== 'string' || typeof suffix !== 'string') {
            return refuse(`the type "${name}" has no text "prefix" or "suffix"`)
        }
        if (definitions.has(name)) {
            return refuse(`the type "${name}" is there two times`)
        }
        definitions.set(name, {
            displayName,
            name,
            ...(prefix === '' ? {} : { prefix }),
            ...(suffix === '' ? {} : { suffix })
        })
    }
    if (notes.length !== question.length) {
        return refuse(
            `it names ${String(notes.length)} note(s) for a question of ${String(question.length)}`
        )
    }
    const types = new Map<string, NoteType>()
    for (const [index, item] of notes.entries()) {
        const path = question[index]
        if (path === undefined || !isRecord(item) || item['path'] !== path) {
            return refuse(`its note ${String(index + 1)} is not "${String(path)}"`)
        }
        const noteType: unknown = item['noteType']
        if (noteType === null) {
            continue
        }
        if (typeof noteType !== 'string') {
            return refuse(`the type of "${path}" is not a text`)
        }
        const definition = definitions.get(noteType)
        if (definition === undefined) {
            return refuse(`the type "${noteType}" of "${path}" is not in its list of types`)
        }
        types.set(path, definition)
    }
    return types
}

/** True when the value is the `noteType` of a manifest entry. */
export function isNoteType(value: unknown): value is NoteType {
    if (!isRecord(value)) {
        return false
    }
    const { name, displayName, prefix, suffix, ...others } = value
    return (
        Object.keys(others).length === 0 &&
        typeof name === 'string' &&
        CANONICAL_NAME.test(name) &&
        typeof displayName === 'string' &&
        displayName !== '' &&
        (prefix === undefined || (typeof prefix === 'string' && prefix !== '')) &&
        (suffix === undefined || (typeof suffix === 'string' && suffix !== ''))
    )
}

/** True when both are no type, or the same type with the same display name, prefix and suffix. */
export function sameNoteType(one: NoteType | undefined, two: NoteType | undefined): boolean {
    if (one === undefined || two === undefined) {
        return one === two
    }
    return (
        one.name === two.name &&
        one.displayName === two.displayName &&
        one.prefix === two.prefix &&
        one.suffix === two.suffix
    )
}
