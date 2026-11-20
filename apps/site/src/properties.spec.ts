import { describe, expect, test } from 'bun:test'
import { propertiesOf, propertyLinksOf, type LinkOf } from './properties.ts'

// The properties panel of a note page (issue 48, PAGE-02): the properties of
// a published note with the display rules of the site of today
// (`documentation/research/2026-11-17-current-state.md`, section 1.7).

/** The links of a test: `Rain barrel` is published, with a heading `Cleaning`. */
const linkOf: LinkOf = (linkPath, fragment) =>
    linkPath === 'Rain barrel'
        ? `/10+Garden/Rain+barrel${fragment === 'Cleaning' ? '#cleaning' : ''}`
        : undefined

/** The one property of a note with this value, as the panel shows it. */
function shown(value: unknown, key = 'status'): unknown {
    return propertiesOf({ [key]: value }, linkOf)[0]?.value
}

describe('the names of the properties', () => {
    test('a key in snake case, kebab case or camel case shows in title case', () => {
        const names = propertiesOf(
            {
                'date_of_birth': 'x',
                'release-date': 'x',
                'aiGenerated': 'x',
                'status': 'x',
                'URL': 'x'
            },
            linkOf
        ).map((property) => property.name)

        expect(names).toEqual(['Date Of Birth', 'Release Date', 'Ai Generated', 'Status', 'URL'])
    })

    test('the properties keep the order of the note', () => {
        const keys = propertiesOf({ zebra: 1, apple: 2, mango: 3 }, linkOf).map(
            (property) => property.key
        )

        expect(keys).toEqual(['zebra', 'apple', 'mango'])
    })
})

describe('the properties that the panel hides', () => {
    test('an empty value: nothing, a blank text, an empty list, an empty object', () => {
        expect(
            propertiesOf(
                { rating: null, note: '   ', directors: [], cast: {}, missing: undefined },
                linkOf
            )
        ).toEqual([])
    })

    test('a list with only empty items', () => {
        expect(propertiesOf({ directors: [null, '', '  ', []] }, linkOf)).toEqual([])
    })

    test('the internal key `position`', () => {
        expect(propertiesOf({ position: { start: 0 }, status: 'Seen' }, linkOf)).toHaveLength(1)
    })

    test('a date that the calendar does not have', () => {
        expect(propertiesOf({ due: '2031-02-30', at: '2031-03-07T25:00' }, linkOf)).toEqual([])
        expect(propertiesOf({ due: new Date(Number.NaN) }, linkOf)).toEqual([])
    })
})

describe('the value of a property', () => {
    test('a text shows as it is, without the white space around it', () => {
        expect(shown('  To watch ')).toEqual({
            kind: 'text',
            pieces: [{ kind: 'text', text: 'To watch' }]
        })
    })

    test('a truth value shows with a mark', () => {
        expect(shown(true)).toEqual({ kind: 'boolean', value: true, text: '✓ true' })
        expect(shown(false)).toEqual({ kind: 'boolean', value: false, text: '✗ false' })
    })

    test('a number shows as a number, zero too', () => {
        expect(shown(4.5)).toEqual({ kind: 'number', text: '4.5' })
        expect(shown(0)).toEqual({ kind: 'number', text: '0' })
    })

    test('an object shows as formatted JSON', () => {
        expect(shown({ plot: 2, beds: ['north', 'south'] })).toEqual({
            kind: 'json',
            text: '{\n  "plot": 2,\n  "beds": [\n    "north",\n    "south"\n  ]\n}'
        })
    })

    test('a web address is a link to another site', () => {
        expect(shown('https://quillfeather.example/films?year=2019')).toEqual({
            kind: 'text',
            pieces: [
                {
                    kind: 'external',
                    text: 'https://quillfeather.example/films?year=2019',
                    href: 'https://quillfeather.example/films?year=2019'
                }
            ]
        })
    })

    test('an address with another scheme, or with a text around it, stays a text', () => {
        expect(shown('javascript:alert(1)')).toEqual({
            kind: 'text',
            pieces: [{ kind: 'text', text: 'javascript:alert(1)' }]
        })
        expect(shown('see https://quillfeather.example')).toEqual({
            kind: 'text',
            pieces: [{ kind: 'text', text: 'see https://quillfeather.example' }]
        })
    })
})

describe('the dates of the properties', () => {
    test('a date alone stays as the vault writes it', () => {
        expect(shown('2019-10-04')).toEqual({
            kind: 'date',
            datetime: '2019-10-04',
            text: '2019-10-04'
        })
    })

    test('a date with a time shows the date, a comma and the time, with no change of time zone', () => {
        const expected = { kind: 'date', datetime: '2031-03-07T07:02', text: '2031-03-07, 07:02' }

        expect(shown('2031-03-07T07:02')).toEqual(expected)
        expect(shown('2031-03-07 07:02')).toEqual(expected)
        expect(shown('2031-03-07T07:02:59')).toEqual(expected)
        expect(shown('2031-03-07T07:02:59.120+02:00')).toEqual(expected)
    })

    // The build reads a date as a text (`note-properties.ts`). A date object
    // of another reader has no text of the vault: it shows in UTC.
    test('a date object shows its date and its time in UTC', () => {
        expect(shown(new Date('1961-04-12T00:00:00Z'))).toEqual({
            kind: 'date',
            datetime: '1961-04-12T00:00',
            text: '1961-04-12, 00:00'
        })
        expect(shown(new Date('2031-03-07T07:02:30Z'))).toEqual({
            kind: 'date',
            datetime: '2031-03-07T07:02',
            text: '2031-03-07, 07:02'
        })
    })

    test('a text that only starts like a date stays a text', () => {
        expect(shown('2019-10-04 was a Friday')).toEqual({
            kind: 'text',
            pieces: [{ kind: 'text', text: '2019-10-04 was a Friday' }]
        })
    })
})

describe('the links of the properties', () => {
    test('a link to a published note is a link to its page', () => {
        expect(shown('[[Rain barrel]]')).toEqual({
            kind: 'text',
            pieces: [{ kind: 'link', text: 'Rain barrel', href: '/10+Garden/Rain+barrel' }]
        })
    })

    test('a link shows its link text, and leads to the heading that it names', () => {
        expect(shown('[[Rain barrel#Cleaning|how to clean it]]')).toEqual({
            kind: 'text',
            pieces: [
                { kind: 'link', text: 'how to clean it', href: '/10+Garden/Rain+barrel#cleaning' }
            ]
        })
    })

    // As in the text of a note, and as Obsidian shows it.
    test('a link to a heading with no link text shows the note and the heading', () => {
        expect(shown('[[Rain barrel#Cleaning]]')).toEqual({
            kind: 'text',
            pieces: [
                {
                    kind: 'link',
                    text: 'Rain barrel > Cleaning',
                    href: '/10+Garden/Rain+barrel#cleaning'
                }
            ]
        })
        expect(shown('[[Wormery#Bins#Lids]] and [[#Cleaning]]')).toEqual({
            kind: 'text',
            pieces: [
                { kind: 'not-published', text: 'Wormery > Bins > Lids' },
                { kind: 'text', text: ' and ' },
                { kind: 'text', text: 'Cleaning' }
            ]
        })
    })

    // In a table of a note a backslash stands before the bar: it is no part of the heading.
    test('a backslash before the bar is no part of the heading', () => {
        expect(shown('[[Rain barrel#Cleaning\\|how]]')).toEqual({
            kind: 'text',
            pieces: [{ kind: 'link', text: 'how', href: '/10+Garden/Rain+barrel#cleaning' }]
        })
    })

    test('a link to a note that is not published is plain text, with no address', () => {
        expect(shown('[[Greenhouse alarm code|the code]]')).toEqual({
            kind: 'text',
            pieces: [{ kind: 'not-published', text: 'the code' }]
        })
    })

    test('a text around links keeps its place', () => {
        expect(shown('See [[Rain barrel]] and [[Wormery]].')).toEqual({
            kind: 'text',
            pieces: [
                { kind: 'text', text: 'See ' },
                { kind: 'link', text: 'Rain barrel', href: '/10+Garden/Rain+barrel' },
                { kind: 'text', text: ' and ' },
                { kind: 'not-published', text: 'Wormery' },
                { kind: 'text', text: '.' }
            ]
        })
    })
})

describe('the lists of the properties', () => {
    test('a list shows one item per value, without its empty items', () => {
        expect(shown(['[[Rain barrel]]', '', null, 'Ada', 3, true], 'directors')).toEqual({
            kind: 'list',
            items: [
                {
                    kind: 'text',
                    pieces: [{ kind: 'link', text: 'Rain barrel', href: '/10+Garden/Rain+barrel' }]
                },
                { kind: 'text', pieces: [{ kind: 'text', text: 'Ada' }] },
                { kind: 'number', text: '3' },
                { kind: 'boolean', value: true, text: '✓ true' }
            ]
        })
    })

    test('a list or an object inside a list shows as JSON', () => {
        expect(shown([['a', 'b'], { plot: 2 }])).toEqual({
            kind: 'list',
            items: [
                { kind: 'json', text: '[\n  "a",\n  "b"\n]' },
                { kind: 'json', text: '{\n  "plot": 2\n}' }
            ]
        })
    })

    test('the tags are links to their tag pages, with a hash sign', () => {
        expect(shown(['type/note', '#Topic/Water', ' '], 'tags')).toEqual({
            kind: 'list',
            items: [
                {
                    kind: 'text',
                    pieces: [{ kind: 'tag', text: '#type/note', href: '/-/tags/type/note' }]
                },
                {
                    kind: 'text',
                    pieces: [{ kind: 'tag', text: '#Topic/Water', href: '/-/tags/topic/water' }]
                }
            ]
        })
    })

    // A tag of the text is read by the parser. A tag of the properties is any
    // text: only the characters of a tag make a link, so no text of a note
    // writes a path of the site.
    test('a text that is no tag is plain text, with no address', () => {
        expect(
            shown(
                ['../../x', 'a//b', 'a, b', '/a', 'a/', '2031', '2031/04', 'jardin/été_2-b'],
                'tags'
            )
        ).toEqual({
            kind: 'list',
            items: [
                { kind: 'text', pieces: [{ kind: 'text', text: '../../x' }] },
                { kind: 'text', pieces: [{ kind: 'text', text: 'a//b' }] },
                { kind: 'text', pieces: [{ kind: 'text', text: 'a, b' }] },
                { kind: 'text', pieces: [{ kind: 'text', text: '/a' }] },
                { kind: 'text', pieces: [{ kind: 'text', text: 'a/' }] },
                // Obsidian reads no tag of digits only.
                { kind: 'text', pieces: [{ kind: 'text', text: '2031' }] },
                { kind: 'text', pieces: [{ kind: 'text', text: '2031/04' }] },
                {
                    kind: 'text',
                    pieces: [
                        {
                            kind: 'tag',
                            text: '#jardin/été_2-b',
                            href: '/-/tags/jardin/%C3%A9t%C3%A9_2-b'
                        }
                    ]
                }
            ]
        })
    })

    test('one tag as a text is one tag', () => {
        expect(shown('garden', 'tags')).toEqual({
            kind: 'list',
            items: [
                { kind: 'text', pieces: [{ kind: 'tag', text: '#garden', href: '/-/tags/garden' }] }
            ]
        })
    })
})

describe('the links of the properties, for the backlinks', () => {
    test('names each link with the name of its property and what a reader sees', () => {
        expect(
            propertyLinksOf({
                directors: ['[[Ada Quillfeather]]', '[[Rain barrel#Cleaning|the barrel]]'],
                related_to: 'See [[Wormery#Bins]].',
                tags: ['type/movie'],
                rating: 4
            })
        ).toEqual([
            { name: 'Directors', linkPath: 'Ada Quillfeather', text: 'Ada Quillfeather' },
            { name: 'Directors', linkPath: 'Rain barrel', text: 'the barrel' },
            { name: 'Related To', linkPath: 'Wormery', text: 'Wormery > Bins' }
        ])
    })

    test('reads no link of a hidden property, and no link into the note itself', () => {
        expect(propertyLinksOf({ position: '[[Rain barrel]]', see: '[[#Cleaning]]' })).toEqual([])
    })
})
