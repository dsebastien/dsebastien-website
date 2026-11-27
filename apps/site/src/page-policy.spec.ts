import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { hashSource, inlineCodeOf, MAX_INLINE_HASHES, pagePolicy } from './page-policy.ts'

// The Content Security Policy of the pages (SEC-01, issue 79). The browser
// test (`browser-page.spec.ts`) loads the built fixture site under it.

const ANALYTICS = {
    siteId: 'notes.example',
    script: 'https://stats.example/js/script.manual.js',
    event: 'https://stats.example/api/event'
}

describe('the inline code of a page', () => {
    test('is its inline scripts and styles, not its script files', () => {
        const code = inlineCodeOf(
            '<head><script>a()</script><script type="module" src="/_astro/x.js"></script><style>p{}</style></head><body><script>\nb()\n</script></body>'
        )
        expect([...code.scripts]).toEqual(['a()', '\nb()\n'])
        expect([...code.styles]).toEqual(['p{}'])
    })

    test('refuses a style attribute, which no hash allows', () => {
        expect(() => inlineCodeOf('<p style="color:red">x</p>', 'x.html')).toThrow(
            'x.html has a style attribute'
        )
        expect([...inlineCodeOf('<p>style="x"</p>').scripts]).toEqual([])
    })
})

describe('the policy of the pages', () => {
    test('allows the hash of each inline text, as the browser computes it', () => {
        const hash = createHash('sha256').update('a()', 'utf8').digest('base64')
        expect(hashSource('a()')).toBe(`'sha256-${hash}'`)
        const policy = pagePolicy({ scripts: new Set(['a()']), styles: new Set(['p{}']) })
        expect(policy).toContain(`script-src 'self' 'sha256-${hash}'`)
        expect(policy).toContain(`style-src 'self' ${hashSource('p{}')}`)
    })

    test('is strict, and allows the analytics proxy only with the settings of the target', () => {
        const none = pagePolicy({ scripts: new Set(), styles: new Set() })
        expect(none).toBe(
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; font-src 'self'; connect-src 'self' https://www.dsebastien.net; frame-src https://www.youtube-nocookie.com; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
        )
        const withAnalytics = pagePolicy({ scripts: new Set(), styles: new Set() }, ANALYTICS)
        expect(withAnalytics).toContain("script-src 'self' https://stats.example;")
        expect(withAnalytics).toContain("connect-src 'self' https://stats.example ")
    })

    test('stops a build whose inline scripts change with the page', () => {
        const scripts = new Set(
            Array.from({ length: MAX_INLINE_HASHES + 1 }, (_, i) => `v(${String(i)})`)
        )
        expect(() => pagePolicy({ scripts, styles: new Set() })).toThrow('distinct inline scripts')
    })
})
