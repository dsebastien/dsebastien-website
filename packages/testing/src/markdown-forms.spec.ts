import { describe, expect, test } from 'bun:test'
import { checkHtml, parseFormCheck, readMarkdownForms } from './markdown-forms.ts'
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

    // Issue 84, point 1: a repeated embed counts in the text of the page,
    // whatever its markup (here, p elements with no end tag).
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
        // A list item that holds a nested list is outer: two items count.
        expect(
            await checkHtml('<ul><li>One</li><li>Two<ul><li>Three</li></ul></li></ul>', [
                { has: 'li', count: 2 }
            ])
        ).toEqual([])
    })

    // First review of issue 84: the rewriter closes no element by itself, so
    // sibling cells and items with no end tag nested, and the rule of the
    // deepest match counted one of two. A browser closes them.
    test('closes an element whose end tag the HTML leaves out, as a browser does', async () => {
        const table = '<table><tr><th>Helper<th>Bed<tr><td><a href="/w">worms</a><td>north</table>'
        expect(
            await checkHtml(table, [
                { has: 'th', count: 2 },
                { has: 'td', count: 2 },
                { has: 'tr', count: 2 },
                { has: 'td', text: 'north', count: 1 }
            ])
        ).toEqual([])
        expect(
            await checkHtml('<ol><li>a<li>b<li>c</ol>', [
                { has: 'li', count: 3 },
                { has: 'li', text: 'a b', count: 0 }
            ])
        ).toEqual([])
        expect(
            await checkHtml('<dl><dt>Bed<dd>North<dt>Crop<dd>Peas</dl>', [
                { has: 'dt', count: 2 },
                { has: 'dd', count: 2 }
            ])
        ).toEqual([])
        expect(
            await checkHtml('<p>One<p>One<div>Two</div>', [
                { has: 'p', text: 'One', count: 2 },
                { has: 'p', text: 'Two', count: 0 }
            ])
        ).toEqual([])
        expect(
            await checkHtml('<ul><li>One<ul><li>Two</ul><li>Three</ul>', [{ has: 'li', count: 2 }])
        ).toEqual([])
    })

    test('reads no text of what a reader does not see', async () => {
        const html =
            '<title>Crop rotation</title><noscript><p>LINK: x</p></noscript>' +
            '<template><p>LINK: y</p></template><iframe>LINK: z</iframe><p>Crop rotation</p>'
        expect(
            await checkHtml(html, [{ lacksText: 'LINK' }, { hasText: 'Crop rotation', count: 1 }])
        ).toEqual([])
    })

    // Second review of issue 84: a script inside a template must still fail a
    // check that counts zero of them. The rewriter reads the content of a
    // noscript as raw text, so an element there is never a match (issue 85).
    test('counts an element inside a hidden element', async () => {
        const html =
            '<template><script>alert(1)</script><iframe src="https://www.youtube.com/embed/tour"></iframe></template>' +
            '<iframe src="/-/attachments/a/b.pdf"></iframe>'
        expect(
            await checkHtml(html, [
                { has: 'script', count: 0 },
                { has: '[src*="youtube"]', count: 0 },
                { has: 'iframe[src^="/-/attachments/"]', count: 1 }
            ])
        ).toEqual([
            '"script" matches 1 elements, not 0',
            '"[src*="youtube"]" matches 1 elements, not 0'
        ])
    })

    // Issue 85: the reader builds the tree that a browser builds, with no
    // script (a noscript holds elements), foreign content and every implied end.
    test('counts an element inside a noscript, and reads no text of it', async () => {
        const html =
            '<noscript><iframe src="https://www.youtube-nocookie.com/embed/x"></iframe><p>LINK: x</p></noscript><p>Tour</p>'
        expect(
            await checkHtml(html, [
                { has: 'iframe', count: 0 },
                { has: '[src*="youtube"]', count: 0 },
                { lacksText: 'LINK' }
            ])
        ).toEqual([
            '"iframe" matches 1 elements, not 0',
            '"[src*="youtube"]" matches 1 elements, not 0'
        ])
        expect(
            await checkHtml('<noscript><a href="/tour">Tour</a></noscript>', [
                { has: 'a[href="/tour"]', count: 1 }
            ])
        ).toEqual([])
    })

    // First review of issue 85.
    test('gives a match inside a template or a noscript no text, and its ids are no link targets', async () => {
        const checks = [{ has: 'a', text: 'Compost basics' }]
        expect(
            await checkHtml('<template><a href="/c">Compost basics</a></template>', checks)
        ).toEqual(['no element matches "a" with the text "Compost basics"'])
        expect(
            await checkHtml('<noscript><a href="/c">Compost basics</a></noscript>', checks)
        ).toEqual(['no element matches "a" with the text "Compost basics"'])
        expect(
            await checkHtml(
                '<p><a href="#x">Harvest</a></p><template><h2 id="x">H</h2></template>',
                [{ anchorsResolve: 'p a[href^="#"]' }]
            )
        ).toEqual(['"p a[href^="#"]" links to "#x", which is no id of the page'])
    })

    test('reads the name of an element in a selector in any letter case, as a browser does', async () => {
        expect(await checkHtml('<iframe src="y"></iframe>', [{ has: 'IFRAME', count: 0 }])).toEqual(
            ['"IFRAME" matches 1 elements, not 0']
        )
        expect(
            await checkHtml('<p class="A">x</p>', [
                { has: 'P.A', count: 1 },
                { has: 'p.a', count: 0 }
            ])
        ).toEqual([])
    })

    // Second review of issue 85.
    test('reads the name of a foreign element as written, and an escaped id or class as written', async () => {
        expect(
            await checkHtml(
                '<svg><foreignObject><p>x</p></foreignObject><clipPath></clipPath></svg>',
                [
                    { has: 'foreignObject', count: 1 },
                    { has: 'svg foreignObject p', count: 1 },
                    { has: 'clipPath', count: 1 }
                ]
            )
        ).toEqual([])
        expect(await checkHtml('<h2 id="1Abc">x</h2>', [{ has: '#\\31 Abc', count: 1 }])).toEqual(
            []
        )
    })

    test('reads no link, no target and no id of a hidden element', async () => {
        expect(
            await checkHtml(
                '<h2 id="a">A</h2><p><a href="#a">A</a></p><template><a href="#nope">z</a><h2 id="a">copy</h2></template>',
                [{ anchorsResolve: 'a[href^="#"]', target: 'h2', nth: 1 }, { distinctIds: 'h2' }]
            )
        ).toEqual([])
        expect(
            await checkHtml('<p><a href="#t">x</a></p><noscript id="t"></noscript>', [
                { anchorsResolve: 'p a' }
            ])
        ).toEqual(['"p a" links to "#t", which is no id of the page'])
    })

    test('reads the type of a field in any letter case, as a browser does', async () => {
        expect(
            await checkHtml('<input TYPE="Checkbox" CHECKED>', [
                { has: 'input[type="checkbox"][checked]', count: 1 }
            ])
        ).toEqual([])
    })

    test('reads a fragment as the body of a note: a row with no table is no row', async () => {
        expect(
            await checkHtml('<tr><td>worms</td></tr>', [
                { has: 'td', count: 0 },
                { hasText: 'worms' }
            ])
        ).toEqual([])
    })

    test('keeps the elements of foreign content inside an open paragraph', async () => {
        const html =
            '<p>Flow: <svg><foreignObject><div><p>Sprout</p></div></foreignObject></svg></p>'
        expect(await checkHtml(html, [{ has: 'svg', text: 'Sprout', count: 1 }])).toEqual([])
        expect(
            await checkHtml('<p>x <math><mi>a</mi><mtext><div>b</div></mtext></math></p>', [
                { has: 'math', text: 'b', count: 1 }
            ])
        ).toEqual([])
    })

    test('closes elements by the other rules of the HTML standard', async () => {
        // A row closes an open caption.
        expect(
            await checkHtml('<table><caption>Plan<tr><td>Peas</table>', [
                { has: 'caption', text: 'Peas', count: 0 },
                { has: 'caption', text: 'Plan', count: 1 }
            ])
        ).toEqual([])
        // A list item closes a paragraph in button scope; so does a center.
        expect(
            await checkHtml('<ul><li><p>a<li>b</ul><p>c<center>d</center>', [
                { has: 'p', text: 'b', count: 0 },
                { has: 'p', text: 'd', count: 0 },
                { has: 'p', text: 'a', count: 1 },
                { has: 'p', text: 'c', count: 1 },
                { has: 'li', count: 2 }
            ])
        ).toEqual([])
        // An end tag of a paragraph that is not open makes an empty one.
        expect(await checkHtml('<div></p></div>', [{ has: 'p', count: 1 }])).toEqual([])
    })

    test('closes the cells and the row before an implied body, and a paragraph at the end of its item or cell', async () => {
        expect(
            await checkHtml('<table><tr><td>a<tbody><tr><td>b</table>', [
                { has: 'tr', count: 2 },
                { has: 'td', text: 'a b', count: 0 },
                { has: 'tbody', count: 2 }
            ])
        ).toEqual([])
        expect(
            await checkHtml('<ul><li><p>a</li><li>b</li></ul>', [
                { has: 'p', count: 1 },
                { has: 'p', text: 'b', count: 0 }
            ])
        ).toEqual([])
        // A paragraph inside a cell stops at the cell: the next cell is no part of it.
        expect(
            await checkHtml('<table><tr><td><p>a<td>b</table>', [
                { has: 'p', text: 'b', count: 0 },
                { has: 'p', text: 'a', count: 1 },
                { has: 'td', count: 2 }
            ])
        ).toEqual([])
    })

    // A browser reads an entity that names no character as U+FFFD (issue 85).
    test('reads an entity that names no character as a browser does, with no crash', async () => {
        expect(
            await checkHtml('<p>&#x110000; and &#xe9;</p>', [{ has: 'p', text: '\uFFFD and é' }])
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
        expect(
            await rejectionOf(checkHtml('', [{ anchorsResolve: 'p a', target: 'h3[', nth: 1 }]))
        ).toContain('selector')
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

describe('parseFormCheck', () => {
    test('reads each kind of check', () => {
        const valid = [
            { has: 'p', text: 'Sow', count: 1 },
            { lacks: '%%' },
            { hasText: 'Sow', count: 2 },
            { hasText: 'Sow' },
            { lacksText: 'LINK' },
            { distinctIds: 'h2' },
            { anchorsResolve: 'p a' },
            { anchorsResolve: 'p a', target: 'h3', nth: 2 }
        ]
        for (const check of valid) expect(parseFormCheck(check, 'f')).toEqual(check)
    })

    test('refuses a check of no kind, a mixed one, an empty text and a wrong number', () => {
        const invalid: unknown[] = [
            null,
            {},
            { has: 'p', lacks: 'x' },
            { hasText: 'Sow', text: 'Sow' },
            { hasText: ' ' },
            { lacksText: ' ' },
            { lacks: '' },
            { has: 'p', text: ' ' },
            { has: 'p', count: -1 },
            { hasText: 'Sow', count: 1.5 },
            { anchorsResolve: 'p a', nth: 2 },
            { anchorsResolve: 'p a', target: 'h3' },
            { anchorsResolve: 'p a', target: 'h3', nth: 0 }
        ]
        for (const check of invalid) {
            expect(() => parseFormCheck(check, 'f'), JSON.stringify(check)).toThrow(
                'a check of the form f is not valid'
            )
        }
    })
})

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

    // Issue 84, point 3, and its second review: a card per target that can
    // show, and none for the note on the deny list.
    const card = (url: string, text = url): string =>
        `<div class="card"><a href="${url}">${text}</a></div>`
    const url = (name: string): string => `https://garden.example/${name}`
    const notStore = '<pre><code>LINK: https://garden.example/not-a-card</code></pre>'

    test('passes link-block for a card per target that can show', async () => {
        const form = (await readMarkdownForms()).find((each) => each.id === 'link-block')
        const html = [
            ...['soil', 'seeds', 'bees', 'ponds', 'mulch'].map((name) => card(url(name))),
            card('/10+Garden/Compost+basics', 'Compost basics'),
            card('/10+Garden/Rain+barrel', 'The barrel'),
            card(url('tools')),
            card('/10+Garden/Herb+bed/Thyme', 'Thyme'),
            card(url('hedges')),
            ...['spring', 'summer', 'autumn'].map((name) => card(url(name))),
            card('/10+Garden/Frost+dates+explained', 'Frost dates explained'),
            '<span class="unpublished">Winter plan (draft)</span>',
            card(url('winter')),
            notStore,
            '<p>LINK: https://garden.example/frozen</p>'
        ].join('')
        expect(await checkHtml(html, form?.checks ?? [])).toEqual([])
    })

    test('fails link-block when only the bare URL lines become cards', async () => {
        const form = (await readMarkdownForms()).find((each) => each.id === 'link-block')
        const html = [
            ...['soil', 'seeds', 'bees', 'ponds'].map((name) => card(url(name))),
            `<p>LINK: <a href="${url('mulch')}">A guide to mulch</a></p>`,
            '<p>LINK: <a href="/10+Garden/Compost+basics">Compost basics</a></p>',
            `<p>LINK:</p><ul><li><a href="${url('tools')}">${url('tools')}</a></li></ul>`,
            `<p>LINKS</p><ul><li><a href="${url('hedges')}">${url('hedges')}</a></li></ul>`,
            notStore
        ].join('')
        expect(await checkHtml(html, form?.checks ?? [])).toEqual([
            'no element matches "a[href="https://garden.example/spring"]"',
            'no element matches "a[href*="rain" i][href*="barrel" i]"',
            'no element matches "a[href*="thyme" i]"',
            'no element matches "a[href="https://garden.example/summer"]"',
            'no element matches "a[href="https://garden.example/autumn"]"',
            'no element matches "a[href="https://garden.example/winter"]"',
            'no element matches "a[href*="frost" i][href*="dates" i]"',
            'the text holds "LINK: A guide to mulch"',
            'the text holds "LINK: Compost basics"',
            'the text holds "LINK: https://garden.example/tools"',
            'the text holds "LINKS https://garden.example/hedges"'
        ])
    })

    test('fails link-block for a card of the note on the deny list', async () => {
        const form = (await readMarkdownForms()).find((each) => each.id === 'link-block')
        const html = card('/90+Locked+Shed/Greenhouse+alarm+code', 'Greenhouse alarm code')
        expect(await checkHtml(html, form?.checks ?? [])).toContain(
            '"a[href*="greenhouse" i]" matches 1 elements, not 0'
        )
    })
})
