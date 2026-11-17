// The canonical form of data (documentation/Canonical Form.md).
//
// The parity rule compares the output of this implementation with the output
// of the Rust implementation (`cli/src/canonical.rs`) byte by byte, so every
// rule here exists there too. Change both in the same commit.

/** Data that has a canonical form: text, whole numbers, booleans, lists and objects of them. */
export type CanonicalValue =
    | string
    | number
    | boolean
    | readonly CanonicalValue[]
    | { readonly [key: string]: CanonicalValue }

const INDENT = '  '

/** Keys are plain ASCII, so that both implementations sort them in the same order. */
const KEY = /^[\x20-\x7e]*$/

function writeText(text: string, where: string): string {
    if (!text.isWellFormed()) {
        throw new Error(`${where}: the text holds half of a surrogate pair`)
    }
    // JSON.stringify escapes the quote, the backslash and the control
    // characters below U+0020, and nothing else in a well-formed text.
    return JSON.stringify(text)
}

function writeNumber(value: number, where: string): string {
    if (!Number.isSafeInteger(value)) {
        throw new Error(`${where}: ${String(value)} is not a whole number that is exact`)
    }
    // -0 is written as 0.
    return String(value === 0 ? 0 : value)
}

function write(value: unknown, indent: string, where: string): string {
    if (typeof value === 'string') {
        return writeText(value, where)
    }
    if (typeof value === 'number') {
        return writeNumber(value, where)
    }
    if (typeof value === 'boolean') {
        return value ? 'true' : 'false'
    }
    const inner = indent + INDENT
    if (Array.isArray(value)) {
        if (value.length === 0) {
            return '[]'
        }
        const items = value.map(
            (item, index) => inner + write(item, inner, `${where}[${String(index)}]`)
        )
        return `[\n${items.join(',\n')}\n${indent}]`
    }
    if (
        typeof value === 'object' &&
        value !== null &&
        Object.getPrototypeOf(value) === Object.prototype
    ) {
        // The default sort compares UTF-16 code units. For ASCII keys that is
        // the order of the code points, which is the order of the bytes in Rust.
        const keys = Object.keys(value).sort()
        if (keys.length === 0) {
            return '{}'
        }
        const members = keys.map((key) => {
            if (!KEY.test(key)) {
                throw new Error(`${where}: the key ${JSON.stringify(key)} is not plain ASCII`)
            }
            const member: unknown = (value as Record<string, unknown>)[key]
            return `${inner}${JSON.stringify(key)}: ${write(member, inner, `${where}.${key}`)}`
        })
        return `{\n${members.join(',\n')}\n${indent}}`
    }
    throw new Error(`${where}: a value of this kind has no canonical form`)
}

/**
 * Writes data in the canonical form: JSON with two spaces per level, the keys
 * of each object sorted, and one line end at the end.
 *
 * It throws for a value that has no canonical form: `null`, `undefined`, a
 * number with a fraction or too large to be exact, a key outside ASCII, a
 * text with half of a surrogate pair, and anything that is not plain data.
 */
export function toCanonicalJson(value: CanonicalValue): string {
    return `${write(value, '', 'value')}\n`
}
