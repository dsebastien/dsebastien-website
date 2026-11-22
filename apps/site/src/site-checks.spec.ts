import { describe, expect, test } from 'bun:test'
import { readBuiltPage, siteFindings, type BuiltPage } from './site-checks.ts'

function page(title: string, links: string[] = [], options: Partial<BuiltPage> = {}): BuiltPage {
    return { title, description: `About ${title}.`, indexable: true, links, ...options }
}

describe('a built page', () => {
    test('gives its title, its description, whether it is indexed, and its links', () => {
        const html =
            '<html><head><title>Bread &amp; butter · Recipe</title><meta name="description" content="A &quot;quick&quot; pickle."><meta name="robots" content="noindex, follow"></head><body><a class="link" href="/A+%26+B#x">a</a><a href="https://example.invalid">b</a></body></html>'
        expect(readBuiltPage(html)).toEqual({
            title: 'Bread & butter · Recipe',
            description: 'A "quick" pickle.',
            indexable: false,
            links: ['/A+%26+B#x', 'https://example.invalid']
        })
    })

    test('is indexed without a robots tag that says noindex', () => {
        expect(readBuiltPage('<title>A</title>').indexable).toBe(true)
    })
})

describe('the checks of a built site', () => {
    const fileOf = (link: string): string | undefined => link.slice(1)

    test('find nothing in a site that keeps the rules', () => {
        const pages = new Map([
            ['home', page('Home', ['/hub'])],
            ['hub', page('Hub', ['/a', '/b'])],
            ['a', page('A')],
            ['b', page('B')]
        ])
        expect(siteFindings(pages, 'home', new Set(['a', 'b']), fileOf)).toEqual([])
    })

    test('find a shared title, a shared description and a missing description', () => {
        const pages = new Map([
            ['home', page('Home', ['/a', '/b', '/c'])],
            ['a', page('Same')],
            ['b', { ...page('Same'), description: 'About Home.' }],
            ['c', { ...page('C'), description: undefined }]
        ])
        expect(siteFindings(pages, 'home', new Set(), fileOf)).toEqual([
            'b and a share the title "Same"',
            'b and home share the description "About Home."',
            'c has no description'
        ])
    })

    test('ignore the titles of a page that is not indexed', () => {
        const pages = new Map([
            ['home', page('Home', ['/a'])],
            ['a', page('Home', [], { indexable: false })]
        ])
        expect(siteFindings(pages, 'home', new Set(), fileOf)).toEqual([])
    })

    test('find an indexable note more than four links from the home page', () => {
        const pages = new Map([
            ['home', page('Home', ['/1'])],
            ['1', page('1', ['/2'])],
            ['2', page('2', ['/3'])],
            ['3', page('3', ['/4'])],
            ['4', page('4', ['/5'])],
            ['5', page('5')],
            ['lost', page('Lost')],
            ['hidden', page('Hidden', [], { indexable: false })]
        ])
        expect(siteFindings(pages, 'home', new Set(['4', '5', 'lost', 'hidden']), fileOf)).toEqual([
            '5 is an indexable note that the home page does not reach in 4 links',
            'lost is an indexable note that the home page does not reach in 4 links'
        ])
    })
})
