import { describe, expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import {
    ANALYTICS_VARIABLE,
    analyticsFrom,
    analyticsOfEnvironment,
    analyticsTag,
    NOT_FOUND_PATH,
    pageViewScript
} from './analytics.ts'

// The analytics of the site (AN-01, AN-03, business rule 9): Plausible through
// the proxy of the author, with the site id of the deploy target. A build
// without settings has no analytics at all. These tests use an invented proxy.

const SETTINGS = {
    siteId: 'analytics-test.invalid',
    script: 'https://proxy.example/content/script.manual.js',
    event: 'https://proxy.example/api/v1/event'
}

describe('the analytics settings of a deploy target', () => {
    test('reads the site id, the script and the event address', () => {
        expect(analyticsFrom(SETTINGS)).toEqual(SETTINGS)
    })

    test.each([
        ['siteId', 'Not a host'],
        ['siteId', ''],
        ['script', 'http://proxy.example/content/script.manual.js'],
        ['script', 'https://proxy.example/content/script.js'],
        ['script', 'https://user:secret@proxy.example/content/script.manual.js'],
        ['script', 'https://proxy.example/content/script.manual.js?x=1'],
        ['script', 'not an address'],
        ['event', 'https://other.example/api/v1/event'],
        ['event', 'https://proxy.example/api/v1/event#x'],
        ['event', 42]
    ])('refuses settings whose %s is %p', (key, value) => {
        expect(() => analyticsFrom({ ...SETTINGS, [key]: value })).toThrow(key)
    })

    test('refuses settings with a field that it does not know', () => {
        expect(() => analyticsFrom({ ...SETTINGS, cookie: true })).toThrow('cookie')
    })

    test('refuses settings that are not an object', () => {
        expect(() => analyticsFrom('notes.example')).toThrow('analytics')
    })
})

describe('the analytics of a build', () => {
    test('has none without the variable, or with an empty one', () => {
        expect(analyticsOfEnvironment({})).toBeUndefined()
        expect(analyticsOfEnvironment({ [ANALYTICS_VARIABLE]: '' })).toBeUndefined()
    })

    test('reads the settings that the variable holds', () => {
        expect(analyticsOfEnvironment({ [ANALYTICS_VARIABLE]: JSON.stringify(SETTINGS) })).toEqual(
            SETTINGS
        )
    })

    // The preload of the tests clears the variable: a build of a test sends nothing.
    test('is empty in a test run', () => {
        expect(process.env[ANALYTICS_VARIABLE]).toBe('')
    })

    test('stops the build when the variable is not valid settings', () => {
        expect(() => analyticsOfEnvironment({ [ANALYTICS_VARIABLE]: '{' })).toThrow(
            ANALYTICS_VARIABLE
        )
        expect(() =>
            analyticsOfEnvironment({
                [ANALYTICS_VARIABLE]: JSON.stringify({ ...SETTINGS, siteId: 1 })
            })
        ).toThrow('siteId')
    })
})

describe('the analytics tag', () => {
    test('loads the script of the proxy after the page, with the site id and the event address', () => {
        expect(analyticsTag(SETTINGS)).toEqual({
            'src': SETTINGS.script,
            'defer': true,
            'data-domain': SETTINGS.siteId,
            'data-api': SETTINGS.event
        })
    })
})

/** Runs the page view script in a page at an address, and gives the calls of `plausible`. */
function pageView(
    kind: 'page' | 'not-found',
    address: string,
    plausible?: (...args: unknown[]) => void
): { calls: unknown[][]; window: Record<string, unknown> } {
    const url = new URL(address)
    const window: Record<string, unknown> = {
        location: { origin: url.origin, pathname: url.pathname, href: url.href },
        ...(plausible === undefined ? {} : { plausible })
    }
    window['window'] = window
    runInNewContext(pageViewScript(kind), window)
    const queue = (window['plausible'] as { q?: unknown[] }).q ?? []
    return { calls: queue.map((args) => Array.from(args as ArrayLike<unknown>)), window }
}

describe('the page view', () => {
    test('queues a page view of the page until the script loads', () => {
        expect(pageView('page', 'https://notes.example/Garden/Drip+irrigation').calls).toEqual([
            ['pageview']
        ])
    })

    test('sends the view of the "not found" page as /404, with the missing path as a property', () => {
        expect(pageView('not-found', 'https://notes.example/No/such+note?q=1').calls).toEqual([
            [
                'pageview',
                {
                    u: `https://notes.example${NOT_FOUND_PATH}`,
                    props: { path: '/No/such+note' }
                }
            ]
        ])
    })

    test('calls the script when it is there already', () => {
        const sent: unknown[][] = []
        pageView('page', 'https://notes.example/', (...args) => sent.push(args))
        expect(sent).toEqual([['pageview']])
    })

    test('never breaks the page when the call fails', () => {
        expect(() =>
            pageView('page', 'https://notes.example/', () => {
                throw new Error('blocked')
            })
        ).not.toThrow()
    })
})
