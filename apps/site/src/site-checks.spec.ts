import { describe, expect, test } from 'bun:test'
import { goneKey, type ResolverMap } from '@dsebastien-website/resolver'
import {
    fileOfLink,
    readBuiltPage,
    siteFindings,
    type BuiltPage,
    type LinkTarget
} from './site-checks.ts'

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
    /** A test site: `/missing...` leads to no page, an outside link to nothing that the checks read. */
    const fileOf = (link: string): LinkTarget =>
        link.startsWith('/missing')
            ? { kind: 'missing' }
            : link.startsWith('/')
              ? { kind: 'page', file: link.slice(1) }
              : { kind: 'other' }

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

    test('find an internal link that leads to no page, on any page, once per page', () => {
        const pages = new Map([
            ['home', page('Home', ['/a', 'https://example.invalid', '/missing-tag'])],
            ['a', page('A', ['/missing-tag', '/missing-tag'], { indexable: false })]
        ])
        expect(siteFindings(pages, 'home', new Set(['a']), fileOf)).toEqual([
            'home links to "/missing-tag", which leads to no page',
            'a links to "/missing-tag", which leads to no page'
        ])
    })
})

describe('the target of a link of a built page', () => {
    const map: ResolverMap = {
        pages: { '/': 'index.html', '/Mint': '-/note/m.html' },
        files: { '/-/md/Mint.md': { file: '-/md/m.md', type: 'markdown' } },
        attachments: { '/-/attachments/abc/mint.png': 'abc' },
        folded: { mint: '/Mint' },
        notFound: '404.html'
    }

    test('is the page of a path, after one redirect', () => {
        expect(fileOfLink('/Mint#Uses', map)).toEqual({ kind: 'page', file: '-/note/m.html' })
        expect(fileOfLink('/mint', map)).toEqual({ kind: 'page', file: '-/note/m.html' })
    })

    test('is no page for a file, an attachment and an outside link', () => {
        for (const link of [
            '/-/md/Mint.md',
            '/-/attachments/abc/mint.png',
            'https://example.invalid/x',
            '//example.invalid',
            'mailto:a@example.invalid',
            '#top'
        ]) {
            expect(fileOfLink(link, map), link).toEqual({ kind: 'other' })
        }
    })

    test('is missing for an internal path that leads to the not found page', () => {
        expect(fileOfLink('/-/tags/tag/', map)).toEqual({ kind: 'missing' })
        expect(fileOfLink('/Basil', map)).toEqual({ kind: 'missing' })
    })

    // A page that links to an address of an unpublished note leads to the
    // gone page (410): the build stops as for "not found" (R64).
    test('is missing for an address of an unpublished note', () => {
        const withGone: ResolverMap = {
            ...map,
            gone: {
                file: '410.html',
                longest: 6,
                paths: { [goneKey('/Basil')]: true },
                folded: { [goneKey('basil')]: true },
                names: {},
                aliases: {}
            }
        }
        expect(fileOfLink('/Basil', withGone)).toEqual({ kind: 'missing' })
        expect(fileOfLink('/basil', withGone)).toEqual({ kind: 'missing' })
    })
})
