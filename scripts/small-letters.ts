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
        'The small letters of each code point alone, from toLowerCase of JavaScript (Bun 1.4.4), and the code points that are cased and case-ignorable (the rule of the final sigma). Read by both implementations and the resolver. Made by scripts/small-letters.ts. See documentation/Canonical Form.md, "Small letters".'
    await Bun.write(
        SMALL_LETTERS_FILE,
        `${JSON.stringify(
            {
                about,
                table,
                cased: rangesOf(/^\p{Cased}$/u),
                caseIgnorable: rangesOf(/^\p{Case_Ignorable}$/u)
            },
            null,
            4
        )}\n`
    )
    process.stdout.write(`${String(Object.keys(table).length)} code points\n`)
}
