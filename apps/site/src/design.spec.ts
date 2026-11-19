import { describe, expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// The guards of the design base (issue 46): tokens only (DES-02, DES-12), and
// the contrast of the theme in both modes (DES-05, DES-11, the gate of DES-04).
const SOURCE = fileURLToPath(new URL('.', import.meta.url))
const THEME = join(SOURCE, 'styles', 'themes', 'knowii.css')

/** The files of the site that hold markup or styles, except the theme files, which hold the values. */
async function componentFiles(): Promise<string[]> {
    const files = await readdir(SOURCE, { recursive: true })
    return files
        .filter((file) => /\.(astro|css|ts)$/u.test(file))
        .filter((file) => !file.startsWith(join('styles', 'themes')))
        .filter((file) => !file.endsWith('.spec.ts'))
        .map((file) => join(SOURCE, file))
}

const PALETTE =
    'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'

/** Raw values that a component must not hold: each gets a name for the message. */
const RAW = [
    ['a hex color', /(?<![&\w])#[0-9a-fA-F]{3,8}\b(?![\w-])/u],
    ['a color function', /\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color-mix)\(/u],
    [
        'a color of the Tailwind palette',
        new RegExp(
            `\\b(?:bg|text|border|from|to|via|fill|stroke|ring|outline|decoration|divide|shadow|accent|caret|placeholder)-(?:white|black|(?:${PALETTE})-\\d{2,3})\\b`,
            'u'
        )
    ],
    ['a font family', /font-family\s*:/u],
    ['a radius', /border-radius\s*:|\brounded-(?:xs|sm|md|lg|xl|2xl|3xl|4xl|none|full)\b/u]
] as const

describe('tokens only', () => {
    test('no component holds a raw color, font or radius', async () => {
        const found: string[] = []
        for (const file of await componentFiles()) {
            const lines = (await readFile(file, 'utf8')).split('\n')
            for (const [index, line] of lines.entries()) {
                for (const [name, pattern] of RAW) {
                    if (pattern.test(line)) {
                        found.push(`${relative(SOURCE, file)}:${String(index + 1)}: ${name}`)
                    }
                }
            }
        }
        expect(found).toEqual([])
    })

    // The guard must see what it looks for.
    test.each([
        ['#37404c', 'a hex color'],
        ["class='bg-[#fff]'", 'a hex color'],
        ['color: rgb(0 0 0)', 'a color function'],
        ["class='text-gray-500'", 'a color of the Tailwind palette'],
        ["class='bg-white'", 'a color of the Tailwind palette'],
        ['font-family: Arial', 'a font family'],
        ["class='rounded-lg'", 'a radius']
    ])('sees %s', (line, name) => {
        expect(
            RAW.filter(([, pattern]) => pattern.test(line)).map(([raw]): string => raw)
        ).toContain(name)
    })

    test.each([["href='#content'"], ["class='rounded-card bg-surface text-primary'"], ['#{id}']])(
        'lets %s pass',
        (line) => {
            expect(RAW.filter(([, pattern]) => pattern.test(line))).toEqual([])
        }
    )
})

/** The values of the theme in one mode, from the block whose selector is given. */
async function themeValues(selector: string): Promise<Map<string, string>> {
    const css = await readFile(THEME, 'utf8')
    const start = css.indexOf(`${selector} {`)
    expect(start).toBeGreaterThanOrEqual(0)
    const block = css.slice(start, css.indexOf('}', start))
    return new Map(
        [...block.matchAll(/--theme-([a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/gu)].map(
            ([, name = '', value = '']) => [name, value]
        )
    )
}

/** The relative luminance of a color (WCAG 2.2). */
function luminance(hex: string): number {
    const [r = 0, g = 0, b = 0] = [1, 3, 5].map((at) => {
        const channel = Number.parseInt(hex.slice(at, at + 2), 16) / 255
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(one: string, two: string): number {
    const [light, dark] = [luminance(one), luminance(two)].sort((a, b) => b - a)
    return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05)
}

const SURFACES = ['background', 'surface', 'surface-elevated', 'well']

/** Each pair that must pass, with its minimum: normal text 4.5, a focus ring 3 (WCAG 1.4.3, 1.4.11). */
const PAIRS = [
    ...['primary', 'muted', 'link'].flatMap((text) =>
        SURFACES.map((surface) => [text, surface, 4.5] as const)
    ),
    ...SURFACES.map((surface) => ['focus', surface, 3] as const),
    ['on-secondary', 'secondary', 4.5] as const
]

describe('contrast of the theme knowii', () => {
    test.each([
        ['dark', ":root,\n[data-theme='dark']"],
        ['light', "[data-theme='light']"]
    ])('every pair passes WCAG AA in the %s mode', async (_mode, selector) => {
        const values = await themeValues(selector)
        const failing = PAIRS.flatMap(([text, surface, minimum]) => {
            const one = values.get(text)
            const two = values.get(surface)
            if (one === undefined || two === undefined) {
                return [`${text} on ${surface}: a value is missing`]
            }
            const ratio = contrast(one, two)
            return ratio < minimum ? [`${text} on ${surface}: ${ratio.toFixed(2)}`] : []
        })
        expect(failing).toEqual([])
    })

    test('measures a known pair', () => {
        expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 5)
        expect(contrast('#ffffff', '#37404c')).toBeCloseTo(10.5, 1)
    })
})
