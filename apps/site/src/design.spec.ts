import { describe, expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BAR_COLORS } from './styles/themes/aurora-bar.ts'

// The guards of the design base (issue 46): tokens only (DES-02, DES-12), and
// the contrast of the theme in both modes (DES-05, DES-11, the gate of DES-04).
const SOURCE = fileURLToPath(new URL('.', import.meta.url))
const THEMES_FOLDER = join(SOURCE, 'styles', 'themes')
/** The default theme (R107). */
const THEME = join(THEMES_FOLDER, 'aurora.css')
const SYSTEM_MODE = join(THEMES_FOLDER, 'aurora-system.css')

/** Each theme, with the selectors of its dark and its light block: the default theme first (R107). */
const THEMES = [
    { name: 'aurora', dark: ":root,\n[data-theme='dark']", light: "[data-theme='light']" },
    {
        name: 'signal',
        dark: ":root[data-design='signal']",
        light: ":root[data-design='signal'][data-theme='light']"
    }
]

/** The files of the site that hold markup or styles, except the theme files, which hold the values, and the contract. */
async function componentFiles(): Promise<string[]> {
    const files = await readdir(SOURCE, { recursive: true })
    return (
        files
            .filter((file) => /\.(astro|css|ts)$/u.test(file))
            .filter((file) => !file.startsWith(join('styles', 'themes')))
            // The contract maps each token to the variable of a theme.
            .filter((file) => file !== join('styles', 'tokens.css'))
            .filter((file) => !file.endsWith('.spec.ts'))
            .map((file) => join(SOURCE, file))
    )
}

const PALETTE =
    'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'

const NAMED_COLORS = `white|black|${PALETTE}`

/** Raw values that a component must not hold: each gets a name for the message. */
const RAW = [
    ['a hex color', /(?<![&\w])#[0-9a-fA-F]{3,8}\b(?![\w-])/u],
    ['a color function', /\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color-mix)\(/u],
    [
        'a color of the Tailwind palette',
        new RegExp(
            `\\b(?:bg|text|border(?:-[trblxyse])?|from|to|via|fill|stroke|ring(?:-offset)?|outline|decoration|divide|shadow|accent|caret|placeholder)-(?:white|black|(?:${PALETTE})-\\d{2,3})\\b`,
            'u'
        )
    ],
    [
        'a named color in an attribute or a style',
        new RegExp(
            `(?:\\b(?:fill|stroke|color)\\s*=\\s*['"]|(?:color|background(?:-color)?|fill|stroke|border(?:-color)?)\\s*:\\s*)(?:${NAMED_COLORS})\\b`,
            'iu'
        )
    ],
    [
        // A length such as `decoration-[3px]` is no color: only a radius must be a token.
        'an arbitrary value of a token utility',
        /\b(?:(?:bg|text|border(?:-[trblxyse])?|ring(?:-offset)?|fill|stroke|outline|decoration|divide|shadow|accent|caret|font|ease|duration)-(?:\[(?![\d.]+(?:px|rem|em|ch|%)?\])|\()|rounded(?:-[trblse]{1,2})?-[[(])/u
    ],
    ['a variable of a theme outside the theme', /var\(--theme-|--theme-[a-z-]+\)/u],
    ['a font family', /font-family\s*:|\bfont\s*:/u],
    [
        'a radius',
        /border-radius\s*:|\brounded(?:-(?:t|r|b|l|s|e|tl|tr|br|bl|ss|se|ee|es))?(?:-(?:xs|sm|md|lg|xl|2xl|3xl|4xl|full))?(?=[\s'"`]|$)/u
    ],
    ['a motion value', /\b(?:duration-\d+|ease-(?:linear|in|out|in-out))\b/u]
] as const

/**
 * The raw values that a file of the music may hold, as no theme gives them:
 * the style text of alphaTab names its music font (the page policy hashes the
 * text as alphaTab writes it), and the tabs read a computed color through a
 * canvas, which needs a start color and gives `rgba()` numbers.
 */
const MUSIC_RAW: Record<string, readonly string[]> = {
    [join('music', 'tab-style.ts')]: ['a font family'],
    [join('music', 'tabs.ts')]: ['a hex color', 'a color function']
}

describe('tokens only', () => {
    test('no component holds a raw color, font or radius', async () => {
        const found: string[] = []
        for (const file of await componentFiles()) {
            const lines = (await readFile(file, 'utf8')).split('\n')
            const allowed = MUSIC_RAW[relative(SOURCE, file)] ?? []
            for (const [index, line] of lines.entries()) {
                for (const [name, pattern] of RAW) {
                    if (pattern.test(line) && !allowed.includes(name)) {
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
        ["class='rounded-lg'", 'a radius'],
        ["class='rounded'", 'a radius'],
        ["class='rounded-t-lg'", 'a radius'],
        ["style='color: white'", 'a named color in an attribute or a style'],
        ["fill='white'", 'a named color in an attribute or a style'],
        ["class='text-[red]'", 'an arbitrary value of a token utility'],
        ["class='rounded-[6px]'", 'an arbitrary value of a token utility'],
        ['class="font-[\'Inter\']"', 'an arbitrary value of a token utility'],
        ["class='bg-(--theme-secondary)'", 'an arbitrary value of a token utility'],
        ["class='border-t-red-500'", 'a color of the Tailwind palette'],
        ["class='ring-offset-white'", 'a color of the Tailwind palette'],
        ["style='font: 12px Arial'", 'a font family'],
        ["class='duration-300 ease-in-out'", 'a motion value']
    ])('sees %s', (line, name) => {
        expect(
            RAW.filter(([, pattern]) => pattern.test(line)).map(([raw]): string => raw)
        ).toContain(name)
    })

    test.each([
        ["href='#content'"],
        ["class='rounded-card bg-surface text-primary'"],
        ["class='rounded-control rounded-pill decoration-[3px] max-w-[72ch]'"],
        ['#{id}'],
        // No radius at all is no value of a theme (the poster of a link card).
        ["class='rounded-none bg-transparent'"],
        ["class='font-semibold text-muted'"]
    ])('lets %s pass', (line) => {
        expect(RAW.filter(([, pattern]) => pattern.test(line))).toEqual([])
    })
})

/** The text of the block whose selector is given. */
async function themeBlock(selector: string, file: string): Promise<string> {
    const css = await readFile(file, 'utf8')
    const start = css.indexOf(`${selector} {`)
    expect(start).toBeGreaterThanOrEqual(0)
    return css.slice(start, css.indexOf('}', start))
}

/** The colors of one mode of a theme (a hex color or `transparent`), from the block of the selector. */
async function themeValues(selector: string, file = THEME): Promise<Map<string, string>> {
    const block = await themeBlock(selector, file)
    return new Map(
        [...block.matchAll(/--theme-([a-z-]+):\s*(#[0-9a-fA-F]{6}|transparent)\s*;/gu)].map(
            ([, name = '', value = '']) => [name, value]
        )
    )
}

/** The names of the variables of a theme in one block. */
async function themeNames(selector: string, file: string): Promise<string[]> {
    const block = await themeBlock(selector, file)
    return [...block.matchAll(/--theme-([a-z-]+):/gu)].map(([, name = '']) => name)
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

// The glow is the color of the decoration of a band and of the page: text lies on it.
const SURFACES = ['background', 'surface', 'surface-elevated', 'well', 'glow']

/** Each pair that must pass, with its minimum: normal text 4.5, a focus ring 3 (WCAG 1.4.3, 1.4.11). */
const PAIRS = [
    ...['primary', 'muted', 'link', 'link-hover', 'nav-hover', 'eyebrow'].flatMap((text) =>
        SURFACES.map((surface) => [text, surface, 4.5] as const)
    ),
    ...SURFACES.map((surface) => ['focus', surface, 3] as const),
    // The line under a link marks it: a part of the interface, 3:1 (WCAG 1.4.11).
    ...['link-decoration', 'link-decoration-end'].flatMap((line) =>
        SURFACES.map((surface) => [line, surface, 3] as const)
    ),
    ['on-secondary', 'secondary', 4.5] as const,
    ['on-secondary', 'secondary-hover', 4.5] as const,
    // A badge with no fill (`transparent`) shows the surface under it.
    ['on-badge', 'badge', 4.5] as const,
    ['on-badge', 'badge-hover', 4.5] as const
]

/** The pairs that fail in one mode of a theme, with their ratio. */
function failingPairs(values: ReadonlyMap<string, string>): string[] {
    return PAIRS.flatMap(([text, fill, minimum]) => {
        const one = values.get(text)
        const two = values.get(fill)
        if (one === undefined || two === undefined) {
            return [`${text} on ${fill}: a value is missing`]
        }
        const under = two === 'transparent' ? SURFACES.map((name) => values.get(name)) : [two]
        return under.flatMap((color) => {
            const ratio = color === undefined ? 0 : contrast(one, color)
            return ratio < minimum ? [`${text} on ${fill}: ${ratio.toFixed(2)}`] : []
        })
    })
}

describe('token contract', () => {
    // Tailwind writes only the variables that the markup uses, so the built
    // CSS cannot show a missing reset: the contract must hold it.
    test('switches off the default palette, fonts, radii and shadows of Tailwind', async () => {
        const tokens = await readFile(join(SOURCE, 'styles', 'tokens.css'), 'utf8')
        for (const reset of [
            '--color-*: initial',
            '--font-*: initial',
            '--radius-*: initial',
            '--shadow-*: initial'
        ]) {
            expect(tokens).toContain(reset)
        }
    })
})

describe('contrast of the themes', () => {
    test.each(
        THEMES.flatMap((theme) =>
            (['dark', 'light'] as const).map((mode) => [theme.name, mode, theme[mode]] as const)
        )
    )('every pair of %s passes WCAG AA in the %s mode', async (name, _mode, selector) => {
        const values = await themeValues(selector, join(THEMES_FOLDER, `${name}.css`))
        expect(failingPairs(values)).toEqual([])
    })

    // A second theme gives every value of the contract, in each mode (DES-02):
    // its dark block the dark and the shared values of the default theme, its
    // light block the light values.
    test.each(THEMES.slice(1).map((theme) => [theme.name, theme] as const))(
        'the theme %s gives every variable of the default theme',
        async (_name, theme) => {
            const file = join(THEMES_FOLDER, `${theme.name}.css`)
            const shared = await themeNames(':root', THEME)
            const dark = await themeNames(":root,\n[data-theme='dark']", THEME)
            expect((await themeNames(theme.dark, file)).sort()).toEqual([...dark, ...shared].sort())
            expect((await themeNames(theme.light, file)).sort()).toEqual(
                (await themeNames("[data-theme='light']", THEME)).sort()
            )
        }
    )

    // The server error page has no script, so it follows the mode of the
    // system (decision R64): its light block is the light mode, value by value.
    test('gives the mode of the system the values of the light mode', async () => {
        const light = await themeValues("[data-theme='light']")
        const system = await themeValues("    [data-theme='system']", SYSTEM_MODE)
        expect(light.size).toBeGreaterThan(10)
        expect([...system]).toEqual([...light])
        const theme = await readFile(THEME, 'utf8')
        const systemMode = await readFile(SYSTEM_MODE, 'utf8')
        const block = (css: string, selector: string): string => {
            const start = css.indexOf(`${selector} {`)
            return css
                .slice(css.indexOf('{', start) + 1, css.indexOf('}', start))
                .replace(/\s+/gu, ' ')
        }
        expect(block(systemMode, "    [data-theme='system']")).toBe(
            block(theme, "[data-theme='light']")
        )
        expect(systemMode).toContain(
            "@media (prefers-color-scheme: light) {\n    [data-theme='system'] {"
        )
    })

    // Issue 133: the bar of the browser and the header are one band.
    test.each([
        ['dark', ":root,\n[data-theme='dark']"],
        ['light', "[data-theme='light']"]
    ] as const)(
        'gives the bar of the browser the surface of the %s mode',
        async (mode, selector) => {
            const values = await themeValues(selector)
            expect(BAR_COLORS[mode]).toBe(values.get('surface') ?? '')
        }
    )

    test('measures a known pair', () => {
        expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 5)
        expect(contrast('#ffffff', '#37404c')).toBeCloseTo(10.5, 1)
    })
})
