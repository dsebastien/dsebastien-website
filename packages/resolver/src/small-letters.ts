import file from './small-letters.json'

// The small letters of the canonical form (`documentation/Canonical Form.md`,
// "Small letters", issue 73): one table that the TypeScript logic, the Rust
// logic and the resolver all read, so a new version of Bun or of Rust changes
// no small letter. Never use `toLowerCase` on a text that a rule compares with
// the letter case ignored: use `smallLetters`.

type Ranges = readonly (readonly [number, number])[]

function isRanges(value: unknown): value is Ranges {
    return (
        Array.isArray(value) &&
        value.every(
            (range) =>
                Array.isArray(range) &&
                range.length === 2 &&
                range.every((code) => Number.isInteger(code))
        )
    )
}

function lettersOf(value: unknown, name: string): Map<number, string> {
    if (typeof value !== 'object' || value === null) {
        throw new Error(`the ${name} of small letters is not valid`)
    }
    const letters = new Map<number, string>()
    for (const [code, small] of Object.entries(value)) {
        if (!/^[0-9A-F]{4,6}$/u.test(code) || typeof small !== 'string') {
            throw new Error(`the ${name} of small letters has a wrong item: ${code}`)
        }
        letters.set(Number.parseInt(code, 16), small)
    }
    return letters
}

function read(): {
    table: Map<number, string>
    newer: Map<number, string>
    cased: Ranges
    caseIgnorable: Ranges
} {
    const data: unknown = file
    if (typeof data !== 'object' || data === null) {
        throw new Error('the table of small letters is not valid')
    }
    const { table, newer, cased, caseIgnorable } = data as Record<string, unknown>
    if (!isRanges(cased) || !isRanges(caseIgnorable)) {
        throw new Error('the table of small letters is not valid')
    }
    return {
        table: lettersOf(table, 'table'),
        newer: lettersOf(newer, 'list of newer letters'),
        cased,
        caseIgnorable
    }
}

const { table: TABLE, newer: NEWER, cased: CASED, caseIgnorable: CASE_IGNORABLE } = read()

function inRanges(ranges: Ranges, code: number): boolean {
    let low = 0
    let high = ranges.length - 1
    while (low <= high) {
        const middle = (low + high) >> 1
        const [first = 0, last = 0] = ranges[middle] ?? []
        if (code < first) high = middle - 1
        else if (code > last) low = middle + 1
        else return true
    }
    return false
}

const CAPITAL_SIGMA = 0x3a3

/** True when a capital sigma at `index` is at the end of a word: the rule of the final sigma. */
function isFinalSigma(codes: readonly number[], index: number): boolean {
    let before = index - 1
    while (before >= 0 && inRanges(CASE_IGNORABLE, codes[before] ?? 0)) before -= 1
    if (before < 0 || !inRanges(CASED, codes[before] ?? 0)) return false
    let after = index + 1
    while (after < codes.length && inRanges(CASE_IGNORABLE, codes[after] ?? 0)) after += 1
    return after >= codes.length || !inRanges(CASED, codes[after] ?? 0)
}

/** A text in small letters, by the table of the canonical form. */
export function smallLetters(text: string): string {
    const codes = Array.from(text, (letter) => letter.codePointAt(0) ?? 0)
    let result = ''
    codes.forEach((code, index) => {
        if (code === CAPITAL_SIGMA) {
            result += isFinalSigma(codes, index) ? 'ς' : 'σ'
        } else {
            result += TABLE.get(code) ?? String.fromCodePoint(code)
        }
    })
    return result
}

/**
 * The name of a file as the guard by file name compares it: the composed
 * Unicode form, the small letters of the table, then the small letters that a
 * newer Unicode gives (canonical form, "Small letters", rule 4). This fold is
 * wider than the small letters alone, so the guard fails closed.
 */
export function guardName(name: string): string {
    return Array.from(
        smallLetters(name.normalize('NFC')),
        (letter) => NEWER.get(letter.codePointAt(0) ?? 0) ?? letter
    ).join('')
}
