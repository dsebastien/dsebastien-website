// The properties of a note, read and written as text.
//
// The publishing logic exists two times, and two YAML libraries never agree
// on every byte. So both implementations work on lines, with the rules of
// `documentation/Canonical Form.md` (section "Notes and their properties").
// The Rust twin is `cli/src/frontmatter.rs`. Change both in the same commit.

/** The byte order mark. It is not part of the first line of a note. */
const MARK = String.fromCharCode(0xfeff)

/** One line of a note: its text, and its line end (`\n`, `\r\n`, or nothing for a last line without one). */
interface Line {
    text: string
    end: string
}

/** A note cut in lines. */
interface Note {
    /** The byte order mark, or nothing. */
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

/** True when the line opens or closes the properties: `---`, then spaces and tabs only. */
function isFence(line: string): boolean {
    return line.startsWith('---') && trim(line.slice(3)) === ''
}

function read(text: string): Note {
    const mark = text.startsWith(MARK) ? MARK : ''
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
    const opened = lines[0] !== undefined && isFence(lines[0].text)
    const close = opened ? lines.findIndex((line, index) => index > 0 && isFence(line.text)) : -1
    return { mark, lines, close: close < 0 ? undefined : close, opened }
}

function write(note: Note): string {
    return note.mark + note.lines.map((line) => line.text + line.end).join('')
}

function equalsKey(text: string, key: string, anyCase: boolean): boolean {
    return anyCase ? text.toLowerCase() === key.toLowerCase() : text === key
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

/**
 * True when the properties of the note name the key with a value that is not
 * exactly `false`. It is the reading of a guard, so it fails closed: the key
 * counts in any letter case, in quotes, below another key, and with any value.
 * When the properties are never closed, every line of the note is read.
 */
export function namesInProperties(text: string, key: string): boolean {
    const note = read(text)
    if (!note.opened) {
        return false
    }
    const values = note.lines
        .slice(1, note.close ?? note.lines.length)
        .map((line) => valueOf(line.text, key, true, true))
        .filter((value) => value !== undefined)
    return values.some((value) => value !== 'false')
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

/** Removes the two lines of the properties when no line is between them. */
function dropEmptyProperties(note: Note): boolean {
    if (note.close !== 1) {
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

/** The note without properties that hold no line. The same text when it has none. */
export function withoutEmptyProperties(text: string): string {
    const note = read(text)
    return dropEmptyProperties(note) ? write(note) : text
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
