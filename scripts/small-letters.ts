// Writes the table of small letters of the canonical form (issue 73,
// `documentation/Canonical Form.md`, "Small letters"): for each code point
// alone, its small letters as `toLowerCase` of JavaScript gives them, when
// they differ from the code point. Both implementations of the publishing
// logic and the resolver read this one table, so a new version of Bun or of
// Rust changes no small letter.
//
//     bun scripts/small-letters.ts
//
// Run it again only on purpose: a change of the table changes the link rule,
// the folded form of a URL and the guard by file name. Raise `MARKUP_VERSION`
// of the site and add shared cases when it changes.

import { fileURLToPath } from 'node:url'

export const SMALL_LETTERS_FILE = fileURLToPath(
    new URL('../packages/resolver/src/small-letters.json', import.meta.url)
)

/** The table: a code point in hexadecimal, in capitals, and its small letters. */
export function smallLetterTable(): Record<string, string> {
    const table: Record<string, string> = {}
    for (let code = 0; code <= 0x10ffff; code += 1) {
        if (code >= 0xd800 && code <= 0xdfff) continue
        const letter = String.fromCodePoint(code)
        const small = letter.toLowerCase()
        if (small !== letter) {
            table[code.toString(16).toUpperCase().padStart(4, '0')] = small
        }
    }
    return table
}

/**
 * The small letters that a newer Unicode gives and the table does not: the 20
 * code points where `to_lowercase` of Rust 1.100.0 (Unicode 17) differs from
 * the table. Only the guard by file name reads them, so that it fails closed
 * on such a name (issue 73, R54).
 */
export const NEWER: Readonly<Record<string, string>> = {
    'A7DD': '\u0277',
    'A7E2': '\u027C',
    'AB6C': '\uAB4B',
    'AB6D': '\uAB4C',
    '1DF40': '\u{1DF41}',
    '1DF48': '\u{1DF49}',
    '1DF4A': '\u{1DF4B}',
    '1DF4D': '\u{1DF4E}',
    '1DF51': '\u{1DF52}',
    '1DF68': '\u{1DF69}',
    '1DF6A': '\u{1DF6B}',
    '1DF6C': '\u{1DF6D}',
    '1DF6E': '\u{1DF6F}',
    '1DF72': '\u{1DF73}',
    '1DF74': '\u{1DF75}',
    '1DF76': '\u{1DF77}',
    '1DF78': '\u{1DF79}',
    '1DF7A': '\u{1DF7B}',
    '1DF7C': '\u{1DF7D}',
    '1DF7E': '\u{1DF7F}'
}

/** The code points of a property of Unicode, as ranges of code points (first and last). */
export function rangesOf(property: RegExp): [number, number][] {
    const ranges: [number, number][] = []
    for (let code = 0; code <= 0x10ffff; code += 1) {
        if (code >= 0xd800 && code <= 0xdfff) continue
        if (!property.test(String.fromCodePoint(code))) continue
        const last = ranges.at(-1)
        if (last !== undefined && last[1] === code - 1) {
            last[1] = code
        } else {
            ranges.push([code, code])
        }
    }
    return ranges
}

if (import.meta.main) {
    const table = smallLetterTable()
    const about =
        'The small letters of each code point alone, from toLowerCase of JavaScript (Bun 1.4.4), the small letters of a newer Unicode for the guard by file name (newer), and the code points that are cased and case-ignorable (the rule of the final sigma). Read by both implementations and the resolver. Made by scripts/small-letters.ts. See documentation/Canonical Form.md, "Small letters".'
    await Bun.write(
        SMALL_LETTERS_FILE,
        `${JSON.stringify(
            {
                about,
                table,
                newer: NEWER,
                cased: rangesOf(/^\p{Cased}$/u),
                caseIgnorable: rangesOf(/^\p{Case_Ignorable}$/u)
            },
            null,
            4
        )}\n`
    )
    process.stdout.write(`${String(Object.keys(table).length)} code points\n`)
}
