import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { goneKey, type ResolverMap } from '@dsebastien-website/resolver'
import {
    fileOfLink,
    hrefOfAddress,
    judgeFindings,
    readBuiltPage,
    SITE_CHECKS_MODE,
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
        expect(siteFindings(pages, 'home', new Set(['a', 'b']), fileOf)).toEqual({
            stops: [],
            warnings: []
        })
    })

    test('find a shared title and a missing description', () => {
        const pages = new Map([
            ['home', page('Home', ['/a', '/b', '/c'])],
            ['a', page('Same')],
            ['b', { ...page('Same'), description: 'About B.' }],
            ['c', { ...page('C'), description: undefined }]
        ])
        expect(siteFindings(pages, 'home', new Set(), fileOf)).toEqual({
            stops: ['b and a share the title "Same"', 'c has no description'],
            warnings: []
        })
    })

    // R102: a shared description is a warning, one for each group of pages that share it.
    test('warn once for each description that several indexable pages share', () => {
        const pages = new Map([
            ['home', page('Home', ['/a', '/b', '/c', '/d', '/e', '/f'])],
            ['a', { ...page('A'), description: 'A herb.' }],
            ['b', { ...page('B'), description: 'A tea.' }],
            ['c', { ...page('C'), description: 'A herb.' }],
            ['d', { ...page('D'), description: 'A tea.' }],
            ['e', { ...page('E'), description: 'A herb.' }],
            ['f', { ...page('F'), description: 'A herb.', indexable: false }]
        ])
        expect(siteFindings(pages, 'home', new Set(), fileOf)).toEqual({
            stops: [],
            warnings: [
                '3 pages share the description "A herb." (IDX-04): a, c, e',
                '2 pages share the description "A tea." (IDX-04): b, d'
            ]
        })
    })

    test('ignore the titles of a page that is not indexed', () => {
        const pages = new Map([
            ['home', page('Home', ['/a'])],
            ['a', page('Home', [], { indexable: false })]
        ])
        expect(siteFindings(pages, 'home', new Set(), fileOf)).toEqual({ stops: [], warnings: [] })
    })

    // A takedown or an unpublish can cause these two findings alone: they are
    // warnings, so a removal never blocks a build (decision of the author R65).
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
        expect(siteFindings(pages, 'home', new Set(['4', '5', 'lost', 'hidden']), fileOf)).toEqual({
            stops: [],
            warnings: [
                '5 is an indexable note that the home page does not reach in 4 links',
                'lost is an indexable note that the home page does not reach in 4 links'
            ]
        })
    })

    test('find an internal link that leads to no page, on any page, once per page', () => {
        const pages = new Map([
            ['home', page('Home', ['/a', 'https://example.invalid', '/missing-tag'])],
            ['a', page('A', ['/missing-tag', '/missing-tag'], { indexable: false })]
        ])
        expect(siteFindings(pages, 'home', new Set(['a']), fileOf)).toEqual({
            stops: [],
            warnings: [
                'home links to "/missing-tag", which leads to no page',
                'a links to "/missing-tag", which leads to no page'
            ]
        })
    })
})

describe('the verdict on the findings of a build', () => {
    /** A logger that keeps what it is told. */
    function logger(): { warned: string[]; info: string[]; warn: (text: string) => void } {
        const warned: string[] = []
        return { warned, info: [], warn: (text) => warned.push(text) }
    }

    test('stops the build on a finding that stops, in every mode', () => {
        for (const strict of [false, true]) {
            const told = logger()
            expect(() => {
                judgeFindings({ stops: ['a has no title'], warnings: ['b is far'] }, strict, told)
            }).toThrow('a has no title')
        }
    })

    test('gives a warning and does not stop a build of real notes', () => {
        const told = logger()
        judgeFindings({ stops: [], warnings: ['b is far', 'c links to "/x"'] }, false, told)
        expect(told.warned).toEqual(['b is far', 'c links to "/x"'])
    })

    test('stops a build of the tests on a warning, so a change of the code that breaks a rule is caught', () => {
        const told = logger()
        expect(() => {
            judgeFindings({ stops: [], warnings: ['b is far'] }, true, told)
        }).toThrow('b is far')
    })

    // Every build that a test starts inherits the environment of the tests
    // (the preload of `bunfig.toml`).
    test('is strict in the tests', () => {
        expect(process.env[SITE_CHECKS_MODE]).toBe('strict')
    })

    // Bun reads the bunfig.toml of the folder that it runs in only: a test
    // run from the folder of the site would build without the strict mode.
    test('is strict also for a test run from the folder of the site', async () => {
        const preloads = async (file: string): Promise<string[]> =>
            [
                ...(await readFile(new URL(file, import.meta.url), 'utf8')).matchAll(
                    /^preload = .*$/gmu
                )
            ].map((match) => match[0])
        expect(await preloads('../../../bunfig.toml')).toEqual([
            'preload = ["./scripts/test-environment.ts"]'
        ])
        expect(await preloads('../bunfig.toml')).toEqual([
            'preload = ["../../scripts/test-environment.ts"]'
        ])
    })

    test('says nothing and stops nothing when there is no finding', () => {
        const told = logger()
        judgeFindings({ stops: [], warnings: [] }, true, told)
        expect(told.warned).toEqual([])
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

    test('is missing for a name of two notes: the "not found" page that names them', () => {
        const withChoice: ResolverMap = {
            ...map,
            names: { basil: ['/A/Basil', '/B/Basil'] },
            choices: { '/A/Basil\n/B/Basil': '-/choice/basil.html' }
        }
        expect(fileOfLink('/Basil', withChoice)).toEqual({ kind: 'missing' })
    })

    // The resolver never redirects to a redirect: a location is a canonical path.
    test('is no page after a second redirect', () => {
        const chain: ResolverMap = { ...map, folded: { mint: '/Mint2', mint2: '/Mint' } }
        expect(fileOfLink('/mint', chain)).toEqual({ kind: 'other' })
    })
})

describe('the address that a raw link of a note leads to (issue 98)', () => {
    const map: ResolverMap = {
        pages: { '/': 'index.html', '/Mint': '-/note/m.html', '/-/library': '-/library.html' },
        files: { '/-/md/Mint.md': { file: '-/md/m.md', type: 'markdown' } },
        attachments: { '/-/attachments/abc/mint.png': 'abc' },
        folded: { mint: '/Mint' },
        names: { basil: ['/A/Basil', '/B/Basil'] },
        choices: { '/A/Basil\n/B/Basil': '-/choice/basil.html' },
        notFound: '404.html',
        gone: {
            file: '410.html',
            longest: 6,
            paths: { [goneKey('/Sage')]: true },
            folded: { [goneKey('sage')]: true },
            names: {},
            aliases: {}
        }
    }

    test('is the address as written when a page or a file answers it', () => {
        for (const address of [
            '/',
            '/Mint#Uses',
            '/Mint?x=1',
            '/-/library',
            '/-/md/Mint.md',
            '/-/attachments/abc/mint.png'
        ]) {
            expect(hrefOfAddress(address, map), address).toBe(address)
        }
    })

    test('is the canonical path, with the rest of the address, after a redirect', () => {
        expect(hrefOfAddress('/mint#Uses', map)).toBe('/Mint#Uses')
    })

    test('is nothing for no page, the gone page, a name of two notes and another host', () => {
        for (const address of ['/Thyme', '/Sage', '/Basil', '//garden.example/', 'Mint']) {
            expect(hrefOfAddress(address, map), address).toBeUndefined()
        }
    })
})
