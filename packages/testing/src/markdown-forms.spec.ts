import { describe, expect, test } from 'bun:test'
import { checkHtml, readMarkdownForms } from './markdown-forms.ts'
import { listFixtureVaultFiles, readFixtureCatalog } from './fixture-vault.ts'
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

    test('gives each form at least one check, and every selector parses', async () => {
        for (const form of await readMarkdownForms()) {
            expect(form.checks.length, form.id).toBeGreaterThan(0)
            await checkHtml('', form.checks)
        }
    })
})
