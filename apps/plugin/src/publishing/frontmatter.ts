import { firstPart, isReservedRootName } from './names.ts'
import { sortByCodePoint } from './order.ts'

// The properties of a note, read and written as text.
//
// The publishing logic exists two times, and two YAML libraries never agree
// on every byte. So both implementations work on lines, with the rules of
// `documentation/Canonical Form.md` (section "Notes and their properties").
// The Rust twin is `cli/src/frontmatter.rs`. Change both in the same commit.

/** The byte order mark. The marks at the start of a note are not part of its first line. */
export const MARK = String.fromCharCode(0xfeff)

/** The byte order marks at the start of the text: none, one, or more. */
export function marksOf(text: string): string {
    let at = 0
    while (text.startsWith(MARK, at)) {
        at += MARK.length
    }
    return text.slice(0, at)
}

/** One line of a note: its text, and its line end (`\n`, `\r\n`, or nothing for a last line without one). */
interface Line {
    text: string
    end: string
}

/** A note cut in lines. */
interface Note {
    /** The byte order marks at the start of the note, or nothing. */
    mark: string
    lines: Line[]
    /** The index of the line that closes the properties. `undefined` when the note has no closed properties. */
    close: number | undefined
    /** True when the first line opens properties, closed or not. */
    opened: boolean
}

function isBlank(character: string | undefined): boolean {
    return character === ' ' || character === '\t'
}

/** The text without the spaces and the tabs around it. No other character is removed. */
function trim(text: string): string {
    let start = 0
    let end = text.length
    while (start < end && isBlank(text[start])) {
        start += 1
    }
    while (end > start && isBlank(text[end - 1])) {
        end -= 1
    }
    return text.slice(start, end)
}

/**
 * True when the line opens or closes the properties: `---`, then spaces and
 * tabs only.
 *
 * @param loose true to accept carriage returns after the hyphens too. Only the
 * guard reads in that way, as a second reading, so that it fails closed on a
 * line `---` with two carriage returns before its line feed.
 */
function isFence(line: string, loose = false): boolean {
    return line.startsWith('---') && (loose ? /^[ \t\r]*$/u : /^[ \t]*$/u).test(line.slice(3))
}

function read(text: string, loose = false): Note {
    const mark = marksOf(text)
    const pieces = text.slice(mark.length).split('\n')
    const lines: Line[] = []
    for (const [index, piece] of pieces.entries()) {
        if (index < pieces.length - 1) {
            lines.push(
                piece.endsWith('\r')
                    ? { text: piece.slice(0, -1), end: '\r\n' }
                    : { text: piece, end: '\n' }
            )
        } else if (piece !== '') {
            lines.push({ text: piece, end: '' })
        }
    }
    const opened = lines[0] !== undefined && isFence(lines[0].text, loose)
    const close = opened
        ? lines.findIndex((line, index) => index > 0 && isFence(line.text, loose))
        : -1
    return { mark, lines, close: close < 0 ? undefined : close, opened }
}

function write(note: Note): string {
    return note.mark + note.lines.map((line) => line.text + line.end).join('')
}

/** The text with its ASCII capital letters in small letters. No other character changes, as in Rust. */
function asciiLower(text: string): string {
    return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
}

function equalsKey(text: string, key: string, anyCase: boolean): boolean {
    return anyCase ? asciiLower(text) === asciiLower(key) : text === key
}

/**
 * The value of the line when the line names the key: an optional quote, the
 * key, an optional quote, optional spaces and tabs, a colon. `undefined` when
 * it does not.
 *
 * @param indented true to accept spaces and tabs before the key
 * @param anyCase true to compare the key without regard to the case of ASCII letters
 */
function valueOf(
    line: string,
    key: string,
    indented: boolean,
    anyCase: boolean
): string | undefined {
    let at = 0
    if (indented) {
        while (isBlank(line[at])) {
            at += 1
        }
    }
    if (line[at] === '"' || line[at] === "'") {
        at += 1
    }
    if (!equalsKey(line.slice(at, at + key.length), key, anyCase)) {
        return undefined
    }
    at += key.length
    if (line[at] === '"' || line[at] === "'") {
        at += 1
    }
    while (isBlank(line[at])) {
        at += 1
    }
    return line[at] === ':' ? trim(line.slice(at + 1)) : undefined
}

/** True when the line belongs to the property above it: it is indented, or it is a list item. */
function continues(line: string): boolean {
    return line.startsWith(' ') || line.startsWith('\t') || line.startsWith('-')
}

/** The lines of the properties: up to the closing line, or every line when the properties are never closed. */
function propertyLines(note: Note): readonly Line[] {
    return note.opened ? note.lines.slice(1, note.close ?? note.lines.length) : []
}

/**
 * True when a line of the properties holds the key, unless that line names the
 * key with the value exactly `false`. It is the reading of a guard, so it
 * fails closed: the key counts anywhere in a line (in one line of JSON, in a
 * complex key, inside another word), in any case of its ASCII letters, in
 * quotes, below another key, and with any value. When the properties are never
 * closed, every line of the note is read. The properties are read two times:
 * with the fence lines of the other readers, and with fence lines that also
 * end in carriage returns. The key in either reading excludes the note.
 */
export function namesInProperties(text: string, key: string): boolean {
    const wanted = asciiLower(key)
    return [read(text), read(text, true)].some((note) =>
        propertyLines(note).some(
            (line) =>
                asciiLower(line.text).includes(wanted) &&
                valueOf(line.text, key, true, true) !== 'false'
        )
    )
}

/**
 * True when closed properties are in the flow form of YAML: a line of them
 * starts with `{` or `[`, after optional spaces and tabs. A line that the tool
 * adds below such a line is not valid YAML, so the tool never writes into such
 * properties.
 */
export function hasFlowProperties(text: string): boolean {
    const note = read(text)
    if (note.close === undefined) {
        return false
    }
    return propertyLines(note).some((line) => {
        const start = trim(line.text)
        return start.startsWith('{') || start.startsWith('[')
    })
}

/**
 * Removes every property of the note itself that names the key, with its
 * lines. It gives the place of the first one, or `undefined` when there was
 * none.
 */
function remove(note: Note, key: string): number | undefined {
    if (note.close === undefined) {
        return undefined
    }
    let first: number | undefined
    let index = 1
    while (index < note.close) {
        if (valueOf(note.lines[index]?.text ?? '', key, false, false) === undefined) {
            index += 1
            continue
        }
        let end = index + 1
        while (end < note.close && continues(note.lines[end]?.text ?? '')) {
            end += 1
        }
        note.lines.splice(index, end - index)
        note.close -= end - index
        first ??= index
    }
    return first
}

/**
 * True when the lines from a place on would be read as closed properties: a
 * `---` line, and a later one. The byte order marks at the start of the first
 * line do not count: at the start of a note, they are not part of its first line.
 */
function hasClosedProperties(lines: readonly Line[], start: number): boolean {
    const first = lines[start]
    return (
        first !== undefined &&
        isFence(first.text.slice(marksOf(first.text).length)) &&
        lines.some((line, index) => index > start && isFence(line.text))
    )
}

/**
 * Removes the two lines of the properties when no line is between them. They
 * stay when the text below them would then be read as properties: a text of
 * the author must never become properties.
 */
function dropEmptyProperties(note: Note): boolean {
    if (note.close !== 1 || hasClosedProperties(note.lines, 2)) {
        return false
    }
    note.lines.splice(0, 2)
    note.close = undefined
    note.opened = false
    return true
}

/**
 * The note without the property. When the properties then hold no line, their
 * two lines go too, as when the last property is removed in Obsidian. The same
 * text when the note does not name the property.
 */
export function removeProperty(text: string, key: string): string {
    const note = read(text)
    if (remove(note, key) === undefined) {
        return text
    }
    dropEmptyProperties(note)
    return write(note)
}

/**
 * The note without the property, and without properties that hold no line,
 * also when the note did not name the property. It is the rule of the source
 * of a note: the result is the same before and after the property is set.
 */
export function withoutProperty(text: string, key: string): string {
    const note = read(text)
    const removed = remove(note, key) !== undefined
    return dropEmptyProperties(note) || removed ? write(note) : text
}

/**
 * The note with the property set to the value. An existing property keeps its
 * place. A new one is the last line of the properties, where Obsidian adds a
 * property. A note without closed properties gets a block with this one
 * property, after its byte order mark.
 *
 * The result is the same text when the note is already right.
 */
export function setProperty(text: string, key: string, value: string): string {
    const note = read(text)
    const end = note.lines[0]?.end === '\r\n' ? '\r\n' : '\n'
    const line = { text: `${key}: ${value}`, end }
    if (note.close === undefined) {
        const block = [{ text: '---', end }, line, { text: '---', end }]
        return write({ ...note, lines: [...block, ...note.lines] })
    }
    const first = remove(note, key)
    note.lines.splice(first ?? note.close, 0, line)
    return write(note)
}

/** The property of the aliases of a note. */
const ALIASES = 'aliases'

/** The aliases of a note: the ones that get a URL, and the reserved ones, which get none. */
export interface Aliases {
    /** Each alias that gets a URL, one time, in the order of the code points. */
    readonly aliases: string[]
    /** Each reserved alias, one time, in the order of the code points. */
    readonly reserved: string[]
}

/** The text of a list item of a property: after the hyphen. `undefined` when the line is no list item. */
function listItemOf(line: string): string | undefined {
    let at = 0
    while (isBlank(line[at])) {
        at += 1
    }
    if (line[at] !== '-') {
        return undefined
    }
    const next = line[at + 1]
    return next === undefined || isBlank(next) ? line.slice(at + 1) : undefined
}

/** The text between double quotes, with `\"` and `\\` read. `undefined` for another escape. */
function unescapeDouble(text: string): string | undefined {
    let result = ''
    for (let at = 0; at < text.length; at += 1) {
        const character = text[at]
        if (character !== '\\') {
            result += character ?? ''
            continue
        }
        const next = text[at + 1]
        if (next !== '"' && next !== '\\') {
            return undefined
        }
        result += next
        at += 1
    }
    return result
}

/** One alias from one item of the property. `undefined` when the item gives no alias. */
function aliasOfItem(item: string): string | undefined {
    const text = trim(item)
    let alias: string | undefined
    if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
        alias = unescapeDouble(text.slice(1, -1))
    } else if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
        alias = text.slice(1, -1).replaceAll("''", "'")
    } else if (text.startsWith('#')) {
        // A comment: YAML reads `- # c` as an empty item.
        alias = undefined
    } else {
        const comment = /[ \t]#/u.exec(text)
        alias = trim(comment === null ? text : text.slice(0, comment.index))
    }
    return alias === '' ? undefined : alias
}

/** The end of an item in quotes that starts at a place: the place after its closing quote, or the end of the text. */
function endOfQuoted(text: string, start: number): number {
    const quote = text[start]
    let at = start + 1
    while (at < text.length) {
        if (quote === '"' && text[at] === '\\') {
            at += 2
            continue
        }
        if (text[at] === quote) {
            if (quote === "'" && text[at + 1] === "'") {
                at += 2
                continue
            }
            return at + 1
        }
        at += 1
    }
    return text.length
}

/** The items of a list in the flow form, without its brackets: cut at each comma that is not inside an item in quotes. */
function flowItemsOf(text: string): string[] {
    const items: string[] = []
    let start = 0
    for (;;) {
        let at = start
        while (isBlank(text[at])) {
            at += 1
        }
        if (text[at] === '"' || text[at] === "'") {
            at = endOfQuoted(text, at)
        }
        const comma = text.indexOf(',', at)
        if (comma < 0) {
            items.push(text.slice(start))
            return items
        }
        items.push(text.slice(start, comma))
        start = comma + 1
    }
}

/**
 * The aliases of a note, from its source (`documentation/Canonical Form.md`,
 * section "The aliases of a note"). Only the property `aliases` of the note
 * itself in closed properties is read. A reserved alias gets no URL: the file
 * of the site wins.
 */
export function aliasesOf(source: string): Aliases {
    const note = read(source)
    if (note.close === undefined) {
        return { aliases: [], reserved: [] }
    }
    const lines = note.lines.slice(1, note.close).map((line) => line.text)
    const items: string[] = []
    for (const [index, line] of lines.entries()) {
        const value = valueOf(line, ALIASES, false, false)
        if (value === undefined) {
            continue
        }
        // A value that starts with `#` is a comment: the items follow.
        if (value === '' || value.startsWith('#')) {
            for (let next = index + 1; next < lines.length; next += 1) {
                const text = lines[next] ?? ''
                // A blank line or a comment line of YAML does not end the list.
                if (text === '' || text.startsWith('#')) {
                    continue
                }
                if (!continues(text)) {
                    break
                }
                const item = listItemOf(text)
                if (item !== undefined) {
                    items.push(item)
                }
            }
        } else if (value.startsWith('[') && value.endsWith(']')) {
            items.push(...flowItemsOf(value.slice(1, -1)))
        } else {
            items.push(value)
        }
    }
    const all = sortByCodePoint([
        ...new Set(items.map(aliasOfItem).filter((alias) => alias !== undefined))
    ])
    return {
        aliases: all.filter((alias) => !isReservedRootName(firstPart(alias))),
        reserved: all.filter((alias) => isReservedRootName(firstPart(alias)))
    }
}
