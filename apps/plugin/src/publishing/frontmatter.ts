// The properties of a note, read and written as text.
//
// The publishing logic exists two times, and two YAML libraries never agree
// on every byte. So both implementations work on lines, with the rules of
// `documentation/Canonical Form.md`. The Rust twin is `cli/src/frontmatter.rs`.

/** A note cut in three: the lines of its properties, the text after them, and its line end. */
interface Parts {
    /** The lines between the two `---` lines, without their line end. */
    properties: string[]
    /** Everything after the closing `---` line. */
    body: string
    /** The line end of the opening line: the block keeps it. */
    lineEnd: '\n' | '\r\n'
}

function withoutReturn(line: string): string {
    return line.endsWith('\r') ? line.slice(0, -1) : line
}

/** Cuts a note at its properties block. `undefined` when the note has none. */
function split(text: string): Parts | undefined {
    const lines = text.split('\n')
    if (withoutReturn(lines[0] ?? '') !== '---' || lines.length < 2) {
        return undefined
    }
    const close = lines.findIndex((line, index) => index > 0 && withoutReturn(line) === '---')
    if (close < 0) {
        return undefined
    }
    return {
        properties: lines.slice(1, close).map(withoutReturn),
        body: lines.slice(close + 1).join('\n'),
        lineEnd: (lines[0] ?? '').endsWith('\r') ? '\r\n' : '\n'
    }
}

function join(parts: Parts): string {
    const block = ['---', ...parts.properties, '---'].join(parts.lineEnd)
    return `${block}\n${parts.body}`
}

/** True when the line starts the property: the key at the start of the line, then a colon. */
function starts(line: string, key: string): boolean {
    return line.startsWith(`${key}:`)
}

/** True when the line belongs to the property above it: it is indented, or it is a list item. */
function continues(line: string): boolean {
    return line.startsWith(' ') || line.startsWith('\t') || line.startsWith('-')
}

/** The text after the colon of a property, without the spaces around it. `undefined` when the note has no such property. */
export function propertyValue(text: string, key: string): string | undefined {
    const line = split(text)?.properties.find((candidate) => starts(candidate, key))
    return line?.slice(key.length + 1).trim()
}

/** The note without the property. The same text when the note has no such property. */
export function removeProperty(text: string, key: string): string {
    const parts = split(text)
    const start = parts?.properties.findIndex((line) => starts(line, key)) ?? -1
    if (parts === undefined || start < 0) {
        return text
    }
    let end = start + 1
    while (end < parts.properties.length && continues(parts.properties[end] ?? '')) {
        end += 1
    }
    return join({
        ...parts,
        properties: [...parts.properties.slice(0, start), ...parts.properties.slice(end)]
    })
}

/**
 * The note with the property set to the value. An existing property keeps its
 * place. A new one is the last line of the properties, where Obsidian adds a
 * property. A note without properties gets a block with this one property.
 */
export function setProperty(text: string, key: string, value: string): string {
    const line = `${key}: ${value}`
    const parts = split(text)
    if (parts === undefined) {
        return `---\n${line}\n---\n${text}`
    }
    const without = split(removeProperty(text, key))
    const start = parts.properties.findIndex((candidate) => starts(candidate, key))
    if (without === undefined) {
        return text
    }
    const at = start < 0 ? without.properties.length : start
    return join({
        ...without,
        properties: [...without.properties.slice(0, at), line, ...without.properties.slice(at)]
    })
}
