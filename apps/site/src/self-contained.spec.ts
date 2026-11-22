import { describe, expect, test } from 'bun:test'
import { rejectionOf } from '@dsebastien-website/testing'
import { selfContained } from './self-contained.ts'

// The server error page is one file (NAV-20, decision R64): its style sheets
// go into the page, without the fonts, and nothing else of the release stays.
const SHEETS: Record<string, string> = {
    '/_astro/site.css':
        '@font-face{font-family:Noto;src:url(/_astro/noto.woff2) format("woff2")}.button{color:var(--color-primary)}',
    '/_astro/more.css': '@font-face{font-family:Other;src:url(/_astro/other.woff2)}.chip{gap:1rem}'
}

async function read(href: string): Promise<string> {
    const sheet = SHEETS[href]
    if (sheet === undefined) {
        throw new Error(`no sheet ${href}`)
    }
    return await Promise.resolve(sheet)
}

describe('self-contained page', () => {
    test('puts each style sheet into the page, without its fonts', async () => {
        const html =
            '<html><head><link rel="stylesheet" href="/_astro/site.css"><link rel="stylesheet" href="/_astro/more.css"></head><body><a class="button" href="/">Home</a></body></html>'
        expect(await selfContained(html, read)).toBe(
            '<html><head><style>.button{color:var(--color-primary)}</style><style>.chip{gap:1rem}</style></head><body><a class="button" href="/">Home</a></body></html>'
        )
    })

    test.each([
        ['a script', '<html><head><script>1</script></head></html>'],
        [
            'a script with a source',
            '<html><head><script type="module" src="/_astro/x.js"></script></head></html>'
        ],
        [
            'a preloaded font',
            '<html><head><link rel="preload" href="/_astro/noto.woff2" as="font"></head></html>'
        ],
        ['an image of the release', '<html><body><img src="/_astro/logo.svg"></body></html>'],
        ['an image at the root', '<html><body><img src="/logo.svg"></body></html>'],
        ['a set of images', '<html><body><img srcset="/a.png 2x"></body></html>'],
        ['a use of an SVG', '<html><body><svg><use href="/icons.svg#x"></use></svg></body></html>'],
        [
            'a style attribute that loads a file',
            '<html><body><p style="background:url(/a.png)">x</p></body></html>'
        ],
        ['a frame', '<html><body><iframe srcdoc="x"></iframe></body></html>'],
        ['an object', '<html><body><object data="/a.pdf"></object></body></html>'],
        ['an embed', '<html><body><embed type="x"></body></html>']
    ])('refuses a page with %s', async (_name, html) => {
        expect(await rejectionOf(selfContained(html, read))).toContain('server error page')
    })

    test('lets links, an inline SVG and a form pass', async () => {
        const html =
            '<html><body><a href="/">Home</a><a href="#content">Skip</a><svg viewBox="0 0 24 24"><path d="M1 1"></path></svg><form action="/-/search"></form></body></html>'
        expect(await selfContained(html, read)).toBe(html)
    })

    test('refuses a style sheet that loads another file', async () => {
        const html = '<html><head><link rel="stylesheet" href="/_astro/bad.css"></head></html>'
        const bad = async (): Promise<string> =>
            await Promise.resolve('.hero{background:url(/_astro/hero.png)}')
        expect(await rejectionOf(selfContained(html, bad))).toContain('server error page')
    })

    test('refuses a style sheet that would end the style element', async () => {
        const html = '<html><head><link rel="stylesheet" href="/_astro/bad.css"></head></html>'
        const bad = async (): Promise<string> =>
            await Promise.resolve('.a::after{content:"</style><script>"}')
        expect(await rejectionOf(selfContained(html, bad))).toContain('server error page')
    })
})
