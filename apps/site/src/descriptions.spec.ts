import { describe, expect, test } from 'bun:test'
import {
    DESCRIPTION_LENGTH,
    noteDescription,
    plainTextOf,
    uniqueDescriptions
} from './descriptions.ts'

/** The characters of a text as a reader counts them. */
function graphemes(text: string): number {
    return [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)].length
}

const MOVIE = {
    title: 'Inception',
    typeLabel: 'Movie',
    properties: {
        release_date: '2010-07-16',
        directors: ['[[Christopher Nolan]]'],
        rating: 8,
        status: 'Watched'
    },
    html: '<p>A thief who steals secrets through dreams.</p>'
}

describe('the description of a note', () => {
    test('is its description property', () => {
        expect(
            noteDescription({ ...MOVIE, properties: { description: '  A heist  in dreams. ' } })
        ).toBe('A heist in dreams.')
    })

    test('is its description property with the text of its links, not their Markdown', () => {
        expect(
            noteDescription({
                ...MOVIE,
                properties: {
                    description:
                        'On [[Compost basics|compost]], [[Mulch]] and [[Soil#Layers]], from [the guide](https://example.invalid/g).'
                }
            })
        ).toBe('On compost, Mulch and Soil, from the guide.')
    })

    // Issue 98: the property is read with the parser of the notes.
    test.each([
        [
            'without an embed',
            '![[cover.jpg]] A heist ![a frame](frame.png) in dreams.',
            'A heist in dreams.'
        ],
        [
            'with the heading of a link into the note',
            'See [[#Layers]] and [[#Layers|the layers]].',
            'See Layers and the layers.'
        ],
        ['with the text of code as written', 'Use `[[Soil]]` here.', 'Use [[Soil]] here.'],
        ['with the alias of a name in brackets', 'A [[Note [draft]|draft]] note.', 'A draft note.'],
        [
            'with an address that holds brackets',
            'Read [a](https://x.example/f_(b)) first.',
            'Read a first.'
        ],
        ['without a comment', 'A %%secret%% note.', 'A note.'],
        [
            'without Meta Bind and Dataview inline code',
            'A `INPUT[text:x]` mint `= this.y` leaf.',
            'A mint leaf.'
        ],
        ['with a space between its blocks', 'One.\n\n- a\n- b', 'One. a b'],
        ['without a footnote', 'A[^1] text.\n\n[^1]: the foot', 'A text.'],
        ['with a space after the title of a callout', '> [!tip] Hint\n> Body', 'Hint Body'],
        ['without a block id', 'Para. ^block-id\n\nNext.', 'Para. Next.'],
        ['with the text of math', 'A $x^2$ formula.', 'A x^2 formula.'],
        [
            'with the text of raw HTML',
            'A <b>bold</b> #herb and ==bright== mint.',
            'A bold #herb and bright mint.'
        ]
    ])('is its description property %s', (_name, description, expected) => {
        expect(noteDescription({ ...MOVIE, properties: { description } })).toBe(expected)
    })

    test('is the facts alone for a media note: its text is often a copied synopsis (IDX-06)', () => {
        expect(noteDescription({ ...MOVIE, media: true })).toBe(
            'Movie, 2010, by Christopher Nolan, rated 8 by Sébastien, watched.'
        )
    })

    test('starts with the type and the data of the author, then the text', () => {
        expect(noteDescription(MOVIE)).toBe(
            'Movie, 2010, by Christopher Nolan, rated 8 by Sébastien, watched. A thief who steals secrets through dreams.'
        )
    })

    test('names two creators, or two and others', () => {
        expect(
            noteDescription({
                ...MOVIE,
                properties: { authors: ['[[Ada Quillfeather|Ada]]', 'Bo Lind'] },
                html: ''
            })
        ).toBe('Movie, by Ada and Bo Lind.')
        expect(
            noteDescription({
                ...MOVIE,
                properties: { authors: ['A', 'B', 'C'] },
                html: ''
            })
        ).toBe('Movie, by A, B and others.')
    })

    test('is the text alone for a note with no type and no such property', () => {
        expect(
            noteDescription({
                title: 'Compost',
                properties: { status: '' },
                html: '<h2>Notes</h2><p>Brown and green layers.</p><pre><code>x = 1</code></pre>'
            })
        ).toBe('Brown and green layers.')
    })

    test('is cut at a word end with an end mark', () => {
        const long = noteDescription({
            ...MOVIE,
            properties: {},
            html: `<p>${'grow '.repeat(60)}</p>`
        })
        expect(long.length).toBeLessThanOrEqual(DESCRIPTION_LENGTH)
        expect(long.endsWith('grow…')).toBe(true)
    })

    test.each([
        ['an emoji of one code point', '🌱'],
        ['a family of joined emoji', '👨‍👩‍👧'],
        ['a flag', '🇧🇪'],
        ['a letter with a combining accent', 'e\u0301']
    ])('is cut on whole characters, never inside %s', (_name, character) => {
        const cut = noteDescription({
            title: 'Seeds',
            properties: {},
            html: `<p>${character.repeat(200)}</p>`
        })
        expect(cut).toBe(`${character.repeat(DESCRIPTION_LENGTH - 1)}…`)
    })

    // Issue 95: the property follows the same rule as a written description.
    test('is its description property cut at a word end with an end mark', () => {
        const cut = noteDescription({ ...MOVIE, properties: { description: 'grow '.repeat(60) } })
        expect(cut).toBe(`${'grow '.repeat(31).trim()}…`)
        expect(graphemes(cut)).toBeLessThanOrEqual(DESCRIPTION_LENGTH)
    })

    test('is its description property in full at exactly the limit', () => {
        const exact = `${'grow '.repeat(30)}mint.`
        expect(graphemes(exact)).toBe(DESCRIPTION_LENGTH)
        expect(noteDescription({ ...MOVIE, properties: { description: exact } })).toBe(exact)
    })

    test('is cut one character past the limit', () => {
        const over = `${'grow '.repeat(30)}mints.`
        expect(graphemes(over)).toBe(DESCRIPTION_LENGTH + 1)
        expect(noteDescription({ ...MOVIE, properties: { description: over } })).toBe(
            `${'grow '.repeat(30).trim()}…`
        )
    })

    test('keeps the last word when a space follows it at the limit', () => {
        const text = 'abcd '.repeat(40)
        expect(noteDescription({ ...MOVIE, properties: { description: text } })).toBe(
            `${'abcd '.repeat(31).trim()}…`
        )
    })

    test('cuts a word longer than the limit on whole characters', () => {
        expect(noteDescription({ ...MOVIE, properties: { description: 'a'.repeat(200) } })).toBe(
            `${'a'.repeat(DESCRIPTION_LENGTH - 1)}…`
        )
        expect(
            noteDescription({ ...MOVIE, properties: { description: `Hi ${'a'.repeat(200)}` } })
        ).toBe(`Hi ${'a'.repeat(DESCRIPTION_LENGTH - 4)}…`)
    })

    test('cuts a text with no spaces (Chinese, Japanese) at a word end', () => {
        const japanese = `あ${'東京'.repeat(100)}`
        expect(noteDescription({ ...MOVIE, properties: { description: japanese } })).toBe(
            `あ${'東京'.repeat(76)}…`
        )
        const sentence = '中文文本没有空格分词。'
        expect(
            noteDescription({ ...MOVIE, properties: { description: `X ${sentence.repeat(20)}` } })
        ).toBe(`X ${sentence.repeat(13)}中文文本没有空格…`)
    })

    test('cuts emoji between words on whole characters', () => {
        const text = 'mint 🌱 '.repeat(40)
        const cut = noteDescription({ ...MOVIE, properties: { description: text } })
        expect(graphemes(cut)).toBeLessThanOrEqual(DESCRIPTION_LENGTH)
        expect(cut).toMatch(/(?:mint|🌱)…$/u)
        expect(cut.isWellFormed()).toBe(true)
        expect(text.startsWith(cut.slice(0, -1))).toBe(true)
    })

    test('cuts the shown text of a property with Markdown, never its markup', () => {
        const markdown = '**Grow** [[Mint|mint]] in [beds](https://example.invalid/b). '.repeat(10)
        const cut = noteDescription({ ...MOVIE, properties: { description: markdown } })
        expect(cut).toBe(`${'Grow mint in beds. '.repeat(8).trim().slice(0, -1)}…`)
    })

    test('cuts a property with HTML and entities on its decoded text, never inside an entity', () => {
        const html = '<b>Tom</b> &amp; Jerry &#127793; '.repeat(20)
        const cut = noteDescription({ ...MOVIE, properties: { description: html } })
        expect(cut).not.toContain('<')
        expect(cut).not.toContain('&amp')
        expect(cut).not.toContain('&#')
        expect(cut.startsWith('Tom & Jerry 🌱 Tom & Jerry')).toBe(true)
        expect(cut).toMatch(/(?:Tom|Jerry|&|🌱)…$/u)
        expect(graphemes(cut)).toBeLessThanOrEqual(DESCRIPTION_LENGTH)
    })

    // Issue 98: the type alone (`Movie.`) is a thin description.
    test('names the title and the type when the note has nothing more', () => {
        expect(noteDescription({ ...MOVIE, properties: {}, media: true })).toBe(
            'Inception: Movie, a note of Sébastien’s Notes.'
        )
        expect(
            noteDescription({ ...MOVIE, typeLabel: 'Permanent note', properties: {}, html: '' })
        ).toBe('Inception: Permanent note, a note of Sébastien’s Notes.')
    })

    test('is never empty', () => {
        expect(noteDescription({ title: 'Mint', properties: {}, html: '' })).toBe(
            'Mint, a note of Sébastien’s Notes.'
        )
    })
})

describe('the text of a body', () => {
    test('is its paragraphs and list items, without code, diagrams and math', () => {
        expect(
            plainTextOf(
                '<p>One  <a href="/x">two</a>.</p><ul><li>three</li></ul><svg><text>no</text></svg><math><mi>y</mi></math>'
            )
        ).toBe('One two. three')
    })
})

describe('the descriptions of the notes', () => {
    test('get the title in front when two pages share one', () => {
        const descriptions = uniqueDescriptions([
            { key: '1.md', title: 'Letter 1', description: 'A garden letter.' },
            { key: '2.md', title: 'Letter 2', description: 'A garden letter.' },
            { key: '3.md', title: 'Mint', description: 'A herb.' }
        ])
        expect(descriptions.get('1.md')).toBe('Letter 1: A garden letter.')
        expect(descriptions.get('2.md')).toBe('Letter 2: A garden letter.')
        expect(descriptions.get('3.md')).toBe('A herb.')
    })

    test('stay within the length limit with the title in front', () => {
        const long = `${'A long garden letter about the beds '.repeat(4).trim()} ending here.`
        const descriptions = uniqueDescriptions([
            { key: '1.md', title: 'Garden letter 1', description: long },
            { key: '2.md', title: 'Garden letter 2', description: long }
        ])
        const first = descriptions.get('1.md') ?? ''
        const second = descriptions.get('2.md') ?? ''
        expect(first.length).toBeLessThanOrEqual(DESCRIPTION_LENGTH)
        expect(first.startsWith('Garden letter 1: A long garden letter')).toBe(true)
        expect(first.endsWith('…')).toBe(true)
        expect(second.startsWith('Garden letter 2: A long garden letter')).toBe(true)
        expect(second).not.toBe(first)
    })

    // Issue 98: the cut must not join two descriptions again.
    test('keep the whole title in front when the cut would make two the same', () => {
        const start = 'A long letter about the beds of the garden, '.repeat(4)
        const descriptions = uniqueDescriptions([
            { key: '1.md', title: `${start}part 1`, description: 'A garden letter.' },
            { key: '2.md', title: `${start}part 2`, description: 'A garden letter.' },
            { key: '3.md', title: 'Short', description: 'A garden letter.' }
        ])
        expect(descriptions.get('1.md')).toBe(`${start}part 1: A garden letter.`)
        expect(descriptions.get('2.md')).toBe(`${start}part 2: A garden letter.`)
        expect(descriptions.get('3.md')).toBe('Short: A garden letter.')
    })

    test('stop the build when two pages still share one', () => {
        expect(() =>
            uniqueDescriptions([
                { key: 'a.md', title: 'Mint', description: 'A herb.' },
                { key: 'b.md', title: 'Mint', description: 'A herb.' }
            ])
        ).toThrow('two pages share the description')
    })
})
