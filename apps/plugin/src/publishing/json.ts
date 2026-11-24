// Reading of JSON files of the content store and of the device. The Rust twin
// is `cli/src/json.rs`, and both must accept and refuse the same texts. The
// shared cases are the list `json` of `fixtures/canonical/cases.json`.

/** The most levels that data has (rule 10 of the data in the canonical form). */
const MAX_LEVELS = 64

/** The white space of JSON. */
const WHITE_SPACE = new Set([' ', '\t', '\n', '\r'])

/** An object or a list that the check of the structure is inside. */
interface Open {
    /** The keys of an object so far. `undefined` for a list. */
    readonly keys: Set<string> | undefined
    /** True when the next text of an object is a key. */
    expectsKey: boolean
}

/**
 * Checks what the reader of JavaScript does not: a key that is two times in
 * one object (a second key can hide a value that the Rust reader refuses), and
 * more than 64 levels. A value alone is level 1, and each list or object adds
 * one. The text is valid JSON.
 */
function checkStructure(text: string): void {
    const open: Open[] = []
    const tooDeep = (): Error => new Error(`the data has more than ${String(MAX_LEVELS)} levels`)
    let at = 0
    while (at < text.length) {
        const character = text[at] ?? ''
        if (character === '"') {
            let end = at + 1
            while (end < text.length && text[end] !== '"') {
                end += text[end] === '\\' ? 2 : 1
            }
            const inside = open.at(-1)
            if (inside?.keys !== undefined && inside.expectsKey) {
                // The text is valid JSON, so the key is one text of JSON.
                const key = JSON.parse(text.slice(at, end + 1)) as string
                if (inside.keys.has(key)) {
                    throw new Error(`the key "${key}" is two times in one object`)
                }
                inside.keys.add(key)
                inside.expectsKey = false
            } else if (open.length >= MAX_LEVELS) {
                throw tooDeep()
            }
            at = end + 1
            continue
        }
        if (character === '{' || character === '[') {
            if (open.length >= MAX_LEVELS) {
                throw tooDeep()
            }
            open.push({
                keys: character === '{' ? new Set() : undefined,
                expectsKey: character === '{'
            })
        } else if (character === '}' || character === ']') {
            open.pop()
        } else if (character === ',') {
            const inside = open.at(-1)
            if (inside?.keys !== undefined) {
                inside.expectsKey = true
            }
        } else if (character !== ':' && !WHITE_SPACE.has(character) && open.length >= MAX_LEVELS) {
            // The start of a number, or of `true`, `false` or `null`.
            throw tooDeep()
        }
        at += 1
    }
}

/**
 * Reads a JSON text. It throws for a text that is not JSON, and for forms that
 * the two readers would read in other ways: a text with half of a surrogate
 * pair, a number too large to hold, a key that is two times in one object, and
 * more than 64 levels.
 */
export function parseJson(text: string): unknown {
    const value: unknown = JSON.parse(text, (key, item: unknown) => {
        if (!key.isWellFormed() || (typeof item === 'string' && !item.isWellFormed())) {
            throw new Error('a text is not valid Unicode')
        }
        if (typeof item === 'number' && !Number.isFinite(item)) {
            throw new Error('a number is too large')
        }
        return item
    })
    checkStructure(text)
    return value
}

/** The largest whole number that both implementations hold exactly (rule 6 of the data). */
const LARGEST = 9_007_199_254_740_991n

/**
 * The first number of the JSON text that both implementations cannot write
 * again with the same bytes, or `undefined`: a fraction or an exponent
 * (`1.0`, `1e3`), a negative zero (`-0`), or a whole number outside
 * ±9,007,199,254,740,991. TypeScript reads `1.0` as `1` and `-0` as `0`, and
 * the Rust reader keeps them apart. The text is valid JSON.
 */
export function inexactNumberOf(text: string): string | undefined {
    let at = 0
    while (at < text.length) {
        const character = text[at] ?? ''
        if (character === '"') {
            let end = at + 1
            while (end < text.length && text[end] !== '"') {
                end += text[end] === '\\' ? 2 : 1
            }
            at = end + 1
            continue
        }
        if (character === '-' || (character >= '0' && character <= '9')) {
            let end = at + 1
            while (end < text.length && /[0-9.eE+-]/u.test(text[end] ?? '')) {
                end += 1
            }
            const number = text.slice(at, end)
            const whole = /^-?[0-9]+$/u.test(number)
            if (
                !whole ||
                /^-0+$/u.test(number) ||
                BigInt(number) > LARGEST ||
                BigInt(number) < -LARGEST
            ) {
                return number
            }
            at = end
            continue
        }
        at += 1
    }
    return undefined
}
