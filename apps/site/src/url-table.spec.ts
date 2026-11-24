import { describe, expect, test } from 'bun:test'
import {
    checkUrlCase,
    checkUrlTable,
    type Ask,
    type UrlCase,
    type UrlTableSite
} from './url-table.ts'

// The check of a case of the URL table, with hosts in memory: a right answer
// gives no finding, and each wrong part of an answer gives one. The table
// itself runs on a built site in `urls-page.spec.ts`.

const site: UrlTableSite = {
    table: {
        notes: [{ path: 'Welcome.md', aliases: [] }],
        removed: [{ path: '10 Garden/Rain barrel.md', aliases: ['Water butt'] }],
        cases: []
    },
    markdownOf: () => Promise.resolve('# Welcome\n')
}

/** A host that gives one answer per path. */
function host(answers: Record<string, () => Response>): Ask {
    return (path) => Promise.resolve(answers[path]?.() ?? new Response(null, { status: 599 }))
}

const html = (body: string, status = 200, headers: Record<string, string> = {}): Response =>
    new Response(body, {
        status,
        headers: { 'content-type': 'text/html; charset=utf-8', ...headers }
    })

const page = (path: string): Response =>
    html(`<link rel="canonical" href="https://notes.dsebastien.net${path}">`)

const NEVER_KEPT = { 'cache-control': 'no-store', 'vary': 'Accept' }

describe('the check of a page', () => {
    const entry: UrlCase = {
        name: 'a page',
        request: '/Welcome',
        status: 200,
        canonical: '/Welcome'
    }

    test('has no finding for the page with its canonical link', async () => {
        expect(
            await checkUrlCase(entry, host({ '/Welcome': () => page('/Welcome') }), site)
        ).toEqual([])
    })

    test('names a wrong status, a wrong type and a wrong canonical link', async () => {
        const wrong = host({
            '/Welcome': () =>
                new Response('<link rel="canonical" href="https://other.example/Welcome">', {
                    status: 404,
                    headers: { 'content-type': 'text/plain' }
                })
        })
        expect(await checkUrlCase(entry, wrong, site)).toEqual([
            'status: expected 200, got 404',
            'content-type: expected "text/html; charset=utf-8", got "text/plain"',
            'canonical link: expected "https://notes.dsebastien.net/Welcome", got "https://other.example/Welcome"'
        ])
    })
})

describe('the check of a redirect', () => {
    const entry: UrlCase = {
        name: 'small letters',
        request: '/welcome',
        status: 301,
        location: '/Welcome',
        cacheControl: 'public, max-age=3600'
    }
    const redirect = (location: string, cacheControl: string): Response =>
        new Response(null, { status: 301, headers: { location, 'cache-control': cacheControl } })

    test('has no finding for one hop to a page', async () => {
        const right = host({
            '/welcome': () => redirect('/Welcome', 'public, max-age=3600'),
            '/Welcome': () => page('/Welcome')
        })
        expect(await checkUrlCase(entry, right, site)).toEqual([])
    })

    test('names a wrong target, a wrong cache time and a second hop', async () => {
        const wrong = host({
            '/welcome': () => redirect('/Welcome/', 'no-store'),
            '/Welcome': () => redirect('/welcome', 'no-store')
        })
        expect(await checkUrlCase(entry, wrong, site)).toEqual([
            'location: expected "/Welcome", got "/Welcome/"',
            'cache-control: expected "public, max-age=3600", got "no-store"',
            'status of the target: expected 200, got 301',
            'canonical link of the target: expected "https://notes.dsebastien.net/Welcome", got undefined'
        ])
    })
})

describe('the check of an error answer', () => {
    const gone: UrlCase = { name: 'gone', request: '/10+Garden/Rain+barrel', status: 410 }

    test('has no finding for the gone page, never kept', async () => {
        const right = host({
            '/10+Garden/Rain+barrel': () => html('<h1>This note was removed</h1>', 410, NEVER_KEPT)
        })
        expect(await checkUrlCase(gone, right, site)).toEqual([])
    })

    test('names an answer that a cache keeps and a page that shows the removed note', async () => {
        const wrong = host({
            '/10+Garden/Rain+barrel': () => html('<h1>This note was removed</h1> Water butt', 410)
        })
        expect(await checkUrlCase(gone, wrong, site)).toEqual([
            'cache-control: expected "no-store", got null',
            'vary: expected "Accept", got null',
            'body: it names the removed note "Water butt"'
        ])
    })

    test('checks the short Markdown text of an agent with its suggestions', async () => {
        const entry: UrlCase = {
            name: 'a name of two notes',
            request: '/Mint',
            status: 404,
            format: 'markdown',
            accept: 'text/markdown',
            suggestions: ['/10+Garden/Mint', '/20+Kitchen/Mint']
        }
        const answer = (body: string) => (): Response =>
            new Response(body, {
                status: 404,
                headers: { 'content-type': 'text/markdown; charset=utf-8', ...NEVER_KEPT }
            })
        const right = host({
            '/Mint': answer('# Not found\n\n- /10+Garden/Mint\n- /20+Kitchen/Mint\n')
        })
        expect(await checkUrlCase(entry, right, site)).toEqual([])
        const wrong = host({ '/Mint': answer('Not found\n- /10+Garden/Mint\n') })
        expect(await checkUrlCase(entry, wrong, site)).toEqual([
            'body: it does not start with "# Not found\\n\\n"',
            'body: "- /20+Kitchen/Mint\\n" is missing'
        ])
    })
})

describe('the check of a file', () => {
    const entry: UrlCase = {
        name: 'the Markdown of a note',
        request: '/-/md/Welcome.md',
        status: 200,
        file: 'markdown:Welcome.md'
    }
    const markdown = (body: string) => (): Response =>
        new Response(body, { headers: { 'content-type': 'text/markdown; charset=utf-8' } })

    test('has no finding for the cleaned note of the content store', async () => {
        const right = host({ '/-/md/Welcome.md': markdown('# Welcome\n') })
        expect(await checkUrlCase(entry, right, site)).toEqual([])
    })

    test('names a body that is not the cleaned note', async () => {
        const wrong = host({ '/-/md/Welcome.md': markdown('# Other\n') })
        expect(await checkUrlCase(entry, wrong, site)).toEqual([
            'body: expected "# Welcome\\n", got "# Other\\n"'
        ])
    })
})

describe('the check of the whole table', () => {
    const cases: UrlCase[] = [
        { name: 'a page', request: '/Welcome', status: 200, canonical: '/Welcome' },
        { name: 'another page', request: '/Mint', status: 200, canonical: '/Mint' },
        { name: 'a third page', request: '/Sage', status: 200, canonical: '/Sage' }
    ]
    const whole: UrlTableSite = { ...site, table: { ...site.table, cases } }

    test('gives only the cases with a finding, also for a host that gives no answer', async () => {
        const ask: Ask = (path) => {
            if (path === '/Sage') {
                return Promise.reject(new Error('connection refused'))
            }
            return Promise.resolve(path === '/Welcome' ? page('/Welcome') : html('', 404))
        }
        expect(await checkUrlTable(ask, whole)).toEqual([
            {
                name: 'another page',
                request: '/Mint',
                findings: [
                    'status: expected 200, got 404',
                    'canonical link: expected "https://notes.dsebastien.net/Mint", got undefined'
                ]
            },
            { name: 'a third page', request: '/Sage', findings: ['no answer: connection refused'] }
        ])
    })
})
