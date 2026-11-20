import { describe, expect, test } from 'bun:test'
import { checkHtml, readMarkdownForms } from './markdown-forms.ts'
import { join } from 'node:path'
import { FIXTURE_VAULT, listFixtureVaultFiles, readFixtureCatalog } from './fixture-vault.ts'
import { rejectionOf } from './test-stores.ts'

// Issue 26: the corpus of the Markdown forms. Each form of issue 12 has an
// invented note and checks on the HTML that a conversion gives for it. A
// candidate converter passes a form when every check passes. The checks say
// what spec v2 asks (REN, CARD, URL-14), not what one converter writes.

describe('checkHtml', () => {
    test('passes when an element matches the selector', async () => {
        expect(await checkHtml('<p>Sow <mark>early</mark></p>', [{ has: 'mark' }])).toEqual([])
    })

    test('fails with the selector when no element matches', async () => {
        expect(await checkHtml('<p>Sow early</p>', [{ has: 'mark' }])).toEqual([
            'no element matches "mark"'
        ])
    })

    test('takes a list of selectors as alternatives', async () => {
        expect(
            await checkHtml('<details><summary>Tip</summary></details>', [
                { has: '[data-callout-fold], details' }
            ])
        ).toEqual([])
    })

    test('counts only the elements whose text holds the text, entities read', async () => {
        const html = '<a href="/a">Beans &amp; peas</a><a href="/b">Corn</a>'
        expect(await checkHtml(html, [{ has: 'a', text: 'Beans & peas' }])).toEqual([])
        expect(await checkHtml(html, [{ has: 'a', text: 'Squash' }])).toEqual([
            'no element matches "a" with the text "Squash"'
        ])
    })

    test('reads the text of the descendants of an element', async () => {
        expect(
            await checkHtml('<p>Water <b>at dawn</b> only</p>', [
                { has: 'p', text: 'Water at dawn only' }
            ])
        ).toEqual([])
    })

    test('checks an exact count, also zero', async () => {
        const html =
            '<ul><li><input type="checkbox" checked></li><li><input type="checkbox"></li></ul>'
        expect(await checkHtml(html, [{ has: 'input[type="checkbox"]', count: 2 }])).toEqual([])
        expect(await checkHtml(html, [{ has: 'script', count: 0 }])).toEqual([])
        expect(await checkHtml(html, [{ has: 'input[checked]', count: 2 }])).toEqual([
            '"input[checked]" matches 1 elements, not 2'
        ])
    })

    test('fails when a text that must not appear is anywhere in the HTML, comments included', async () => {
        expect(await checkHtml('<p>Sow</p>', [{ lacks: '%%' }])).toEqual([])
        expect(
            await checkHtml('<p>Sow</p><!-- %% the key is under the pot %% -->', [
                { lacks: 'under the pot' }
            ])
        ).toEqual(['the HTML holds "under the pot"'])
    })

    test('fails when a text that must not appear is in the visible text, not in the markup', async () => {
        const html =
            '<p>LINK: <a href="https://garden.example/soil">https://garden.example/soil</a></p>'
        expect(await checkHtml(html, [{ lacks: 'LINK: https://garden.example/soil' }])).toEqual([])
        expect(await checkHtml(html, [{ lacksText: 'LINK: https://garden.example/soil' }])).toEqual(
            ['the text holds "LINK: https://garden.example/soil"']
        )
        expect(
            await checkHtml('<span data-block="#^squash-shade">Squash</span>', [
                { lacksText: '^squash-shade' }
            ])
        ).toEqual([])
    })

    // Issue 84, point 2: a raw LINK line split over two block elements.
    test('reads a space at the edge of a block element', async () => {
        const html =
            '<p>LINK:</p><ul><li><a href="https://garden.example/tools">https://garden.example/tools</a></li></ul>'
        expect(
            await checkHtml(html, [{ lacksText: 'LINK: https://garden.example/tools' }])
        ).toEqual(['the text holds "LINK: https://garden.example/tools"'])
        expect(
            await checkHtml('<div><p>Sow</p><p>early</p></div>', [
                { has: 'div', text: 'Sow early' }
            ])
        ).toEqual([])
        expect(
            await checkHtml('<p>Sow<br>early</p>', [
                { lacksText: 'Sow early' },
                { lacksText: 'Sowearly' }
            ])
        ).toEqual(['the text holds "Sow early"'])
    })

    test('reads no space at the edge of an inline element', async () => {
        expect(
            await checkHtml('<p>Sow<b>early</b></p>', [
                { lacksText: 'Sowearly' },
                { has: 'p', text: 'Sowearly' }
            ])
        ).toEqual(['the text holds "Sowearly"'])
    })

    test('reads no text of a script or a style', async () => {
        const html =
            '<p>Sow</p><script>const line = "LINK: x"</script><style>p::after{content:"LINK: y"}</style>'
        expect(
            await checkHtml(html, [
                { lacksText: 'LINK: x' },
                { lacksText: 'LINK: y' },
                { has: 'p', text: 'Sow' }
            ])
        ).toEqual([])
        expect(await checkHtml(`<div>${html}</div>`, [{ has: 'div', text: 'LINK' }])).toEqual([
            'no element matches "div" with the text "LINK"'
        ])
    })

    // Issue 84, point 1: the rewriter closes no element by itself, so in
    // `<p>One<p>One` the outer p holds the inner one, and a count of the
    // deepest p with the text sees one.
    test('counts how many times a text is in the text of the page', async () => {
        const looped = '<p>Leave one bed empty.<p>Leave one bed empty.'
        expect(await checkHtml(looped, [{ hasText: 'Leave one bed empty.', count: 1 }])).toEqual([
            'the text holds "Leave one bed empty." 2 times, not 1'
        ])
        expect(
            await checkHtml('<p>Leave one <em>bed</em> empty.</p>', [
                { hasText: 'Leave one bed empty.', count: 1 },
                { hasText: 'Leave one bed empty.' }
            ])
        ).toEqual([])
        expect(await checkHtml('<p>Sow</p>', [{ hasText: 'Leave one bed empty.' }])).toEqual([
            'the text does not hold "Leave one bed empty."'
        ])
        expect(await checkHtml('<p>aaa</p>', [{ hasText: 'aa', count: 1 }])).toEqual([])
    })

    test('counts only the deepest element that holds the text', async () => {
        const html = '<ul><li>Outer<ul><li>Inner</li></ul></li></ul>'
        expect(await checkHtml(html, [{ has: 'li', text: 'Inner', count: 1 }])).toEqual([])
        expect(await checkHtml(html, [{ has: 'li', text: 'Outer', count: 1 }])).toEqual([])
    })

    // Issue 84, point 4: two alternatives of one selector that mark the same
    // callout, one inside the other.
    test('counts only the deepest of nested matches, also without a text', async () => {
        const folded = 'details:not([open]), [data-callout-fold="-"], .is-collapsible.is-collapsed'
        const html =
            '<div data-callout="faq" data-callout-fold="-"><details><summary>Why mulch?</summary></details></div>'
        expect(await checkHtml(html, [{ has: folded, count: 1 }])).toEqual([])
        expect(
            await checkHtml('<ul><li>One</li><li>Two<ul><li>Three</li></ul></li></ul>', [
                { has: 'li', count: 2 }
            ])
        ).toEqual([])
    })

    test('reports a failure, not a crash, for an entity that names no character', async () => {
        expect(
            await checkHtml('<p>&#x110000; and &#xe9;</p>', [
                { has: 'p', text: '&#x110000; and é' }
            ])
        ).toEqual([])
    })

    test('checks that each link to a fragment reaches an id of the page', async () => {
        const page = '<h3 id="tasks">Tasks</h3><h3 id="tasks-1">Tasks</h3>'
        expect(
            await checkHtml(`<p><a href="#tasks-1">Tasks</a></p>${page}`, [
                { anchorsResolve: 'p a' }
            ])
        ).toEqual([])
        expect(
            await checkHtml(`<p><a href="#autumntasks">Tasks</a></p>${page}`, [
                { anchorsResolve: 'p a' }
            ])
        ).toEqual(['"p a" links to "#autumntasks", which is no id of the page'])
        expect(
            await checkHtml(
                `<p><a href="#Autumn%20Tasks">Tasks</a></p><h3 id="Autumn Tasks">Tasks</h3>`,
                [{ anchorsResolve: 'p a' }]
            )
        ).toEqual([])
        expect(await checkHtml('<p>Tasks</p>', [{ anchorsResolve: 'p a' }])).toEqual([
            'no element matches "p a" with a link to a fragment'
        ])
    })

    // Issue 84, point 5: `[[#Autumn#Tasks]]` must reach the second Tasks
    // heading, not any id.
    test('checks that each link to a fragment reaches the named element', async () => {
        const page =
            '<h2 id="spring">Spring</h2><h3 id="tasks">Tasks</h3>' +
            '<h2 id="autumn">Autumn</h2><h3 id="tasks-1">Tasks</h3>'
        const check = { anchorsResolve: 'p a', target: 'h3', nth: 2 }
        expect(await checkHtml(`<p><a href="#tasks-1">Tasks</a></p>${page}`, [check])).toEqual([])
        expect(await checkHtml(`<p><a href="#tasks">Tasks</a></p>${page}`, [check])).toEqual([
            '"p a" links to "#tasks", which is not the id of element 2 of "h3"'
        ])
        expect(await checkHtml(`<p><a href="#autumn">Tasks</a></p>${page}`, [check])).toEqual([
            '"p a" links to "#autumn", which is not the id of element 2 of "h3"'
        ])
        expect(
            await checkHtml(`<p><a href="#tasks-1">Tasks</a></p><h3 id="tasks-1">Tasks</h3>`, [
                check
            ])
        ).toEqual(['"h3" matches 1 elements, so it has no element 2'])
    })

    test('checks that matched elements have distinct ids', async () => {
        expect(
            await checkHtml('<h2 id="a">Tip</h2><h2 id="a-1">Tip</h2>', [{ distinctIds: 'h2' }])
        ).toEqual([])
        expect(
            await checkHtml('<h2 id="a">Tip</h2><h2 id="a">Tip</h2>', [{ distinctIds: 'h2' }])
        ).toEqual(['two elements of "h2" have the id "a"'])
        expect(await checkHtml('<h2>Tip</h2>', [{ distinctIds: 'h2' }])).toEqual([
            'an element of "h2" has no id'
        ])
    })

    test('gives one failure per failing check, in the order of the checks', async () => {
        expect(await checkHtml('<p>==x==</p>', [{ has: 'mark' }, { lacks: '==' }])).toEqual([
            'no element matches "mark"',
            'the HTML holds "=="'
        ])
    })

    test('refuses a selector that does not parse', async () => {
        expect(await rejectionOf(checkHtml('<p></p>', [{ has: 'a[' }]))).toContain('selector')
    })
})

// The forms of issue 12, written here from the issue and spec v2, not read
// from the forms file: the file must cover each one.
const FORMS_OF_ISSUE_12 = [
    'wikilink-note',
    'wikilink-heading',
    'wikilink-block',
    'wikilink-alias',
    'wikilink-hard-names',
    'wikilink-unpublished',
    'wikilink-missing',
    'wikilink-duplicate-name',
    'wikilink-own-heading',
    'markdown-link-note',
    'embed-image-size',
    'embed-image-in-link',
    'embed-note',
    'embed-heading',
    'embed-block',
    'embed-cycle',
    'embed-pdf',
    'embed-audio',
    'embed-video',
    'embed-base',
    'embed-canvas',
    'callout-types',
    'callout-folded',
    'callout-nested',
    'callout-title',
    'frozen-dataview-table',
    'frozen-dataview-list',
    'link-block',
    'video-url-line',
    'meta-bind-inline',
    'meta-bind-block',
    'live-dataview',
    'live-base',
    'comment-percent',
    'comment-html',
    'tags',
    'footnotes',
    'highlights',
    'math-inline',
    'math-block',
    'mermaid',
    'table-pipe-in-link',
    'task-list',
    'properties',
    'headings-same-text',
    'code-block',
    'raw-html'
]

describe('the forms file', () => {
    test('covers every form of issue 12, each one time', async () => {
        const ids = (await readMarkdownForms()).map((form) => form.id)
        expect([...ids].sort()).toEqual([...FORMS_OF_ISSUE_12].sort())
    })

    test('names for each form a note of the fixture vault that the catalog declares', async () => {
        const files = new Set(await listFixtureVaultFiles())
        const declared = new Set((await readFixtureCatalog()).flatMap((entry) => entry.files))
        for (const form of await readMarkdownForms()) {
            expect(files.has(form.note), form.id).toBe(true)
            expect(declared.has(form.note), form.id).toBe(true)
        }
    })

    // A note that lost its form would make every check of the form pass or
    // fail for the wrong reason.
    test('names for each form a note that holds the form', async () => {
        for (const form of await readMarkdownForms()) {
            const text = await Bun.file(join(FIXTURE_VAULT, form.note)).text()
            expect(new RegExp(form.source, 'mu').test(text), form.id).toBe(true)
        }
    })

    test('gives each form at least one check, and every selector parses', async () => {
        for (const form of await readMarkdownForms()) {
            expect(form.checks.length, form.id).toBeGreaterThan(0)
            await checkHtml('', form.checks)
        }
    })
})
