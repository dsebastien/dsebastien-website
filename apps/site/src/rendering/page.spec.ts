import { describe, expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import { headingFor, headingIds, oldAnchorScript, slugOf } from './anchors.ts'
import { EMBED_DEPTH, SitePages, type FileLink, type SiteNote } from './page.ts'

// The page step of a note (issue 45): the markup that Astro keeps, with each
// mark resolved in the state of the build. The marks come from the Markdown
// processor; `rendering.spec.ts` covers the whole path on the corpus.

/** A published note of a test, with its markup and the links of its manifest entry. */
function note(
    vaultPath: string,
    markup: string,
    links: Record<string, string> = {},
    files: Record<string, FileLink> = {}
): SiteNote {
    const name = vaultPath.replace(/\.md$/u, '').replaceAll(' ', '+')
    return {
        vaultPath,
        path: `/${name}`,
        markup,
        links: new Map(Object.entries(links)),
        files: new Map(Object.entries(files))
    }
}

/** The page of `Self.md`, with the given markup, among the other notes. */
function page(markup: string, links: Record<string, string> = {}, ...others: SiteNote[]): string {
    return new SitePages([note('Self.md', markup, links), ...others]).render('Self.md')
}

const BARREL = note(
    'Rain barrel.md',
    '<h1 id="rain-barrel">Rain barrel</h1>\n<p>Fill it in spring.</p>'
)
const LINKS = {
    'Rain barrel': 'Rain barrel.md',
    'Frost dates': 'Frost dates.md',
    'Deep': 'Deep.md'
}

describe('links of a page', () => {
    test('a mark whose target is published becomes a link to its canonical path', () => {
        expect(
            page(
                '<p>The <note-link data-link="Rain%20barrel">barrel</note-link>.</p>',
                LINKS,
                BARREL
            )
        ).toBe('<p>The <a href="/Rain+barrel">barrel</a>.</p>')
    })

    test('a mark whose target is not published becomes plain text in the style, with no address', () => {
        expect(
            page('<note-link data-link="Frost%20dates">Frost dates</note-link>', LINKS, BARREL)
        ).toBe('<span class="not-published">Frost dates</span>')
    })

    test('a mark whose link path has no target becomes plain text in the style', () => {
        expect(page('<note-link data-link="Nothing">Nothing</note-link>', LINKS, BARREL)).toBe(
            '<span class="not-published">Nothing</span>'
        )
    })

    test('every mark gets its own state, and the other markup stays', () => {
        expect(
            page(
                '<p><note-link data-link="Rain%20barrel">one</note-link> <em>and</em> <note-link data-link="Nothing">two</note-link></p>',
                LINKS,
                BARREL
            )
        ).toBe(
            '<p><a href="/Rain+barrel">one</a> <em>and</em> <span class="not-published">two</span></p>'
        )
    })

    test('a mark of raw HTML with a link path that cannot be decoded has no target, and the build goes on', () => {
        expect(page('<note-link data-link="%E0">raw</note-link>', LINKS, BARREL)).toBe(
            '<span class="not-published">raw</span>'
        )
    })

    test('the text of a mark can hold markup', () => {
        expect(
            page(
                '<note-link data-link="Rain%20barrel">the <em>big</em> barrel</note-link>',
                LINKS,
                BARREL
            )
        ).toBe('<a href="/Rain+barrel">the <em>big</em> barrel</a>')
    })
})

describe('anchors of a page (URL-14)', () => {
    const GUIDE = note(
        'Guide.md',
        '<h1 id="guide">Guide</h1><h2 id="spring">Spring</h2><h3 id="tasks">Tasks</h3><h2 id="autumn">Autumn</h2><h3 id="autumn-tasks">Tasks</h3><p id="^shade">Shade.</p>'
    )
    const render = (markup: string): string => page(markup, { Guide: 'Guide.md' }, GUIDE)

    test('a link to a heading of another note leads to the id of that heading', () => {
        expect(render('<note-link data-link="Guide" data-fragment="Spring">x</note-link>')).toBe(
            '<a href="/Guide#spring">x</a>'
        )
    })

    test('a heading path leads to the heading under that parent, in any letter case and punctuation', () => {
        expect(
            render('<note-link data-link="Guide" data-fragment="autumn%23TASKS!">x</note-link>')
        ).toBe('<a href="/Guide#autumn-tasks">x</a>')
    })

    test('a link to a block leads to the id of the block', () => {
        expect(render('<note-link data-link="Guide" data-fragment="%5Eshade">x</note-link>')).toBe(
            '<a href="/Guide#%5Eshade">x</a>'
        )
    })

    test('a link to a heading or a block that the note does not have leads to the note', () => {
        expect(render('<note-link data-link="Guide" data-fragment="Winter">x</note-link>')).toBe(
            '<a href="/Guide">x</a>'
        )
        expect(render('<note-link data-link="Guide" data-fragment="%5Enone">x</note-link>')).toBe(
            '<a href="/Guide">x</a>'
        )
    })

    test('a link into the note itself leads to its heading, or is plain text when the heading is missing', () => {
        const markup =
            '<h2 id="harvest">Harvest</h2><p><note-link data-link="" data-fragment="Harvest">Harvest</note-link> <note-link data-link="" data-fragment="Gone">Gone</note-link></p>'
        expect(page(markup)).toBe(
            '<h2 id="harvest">Harvest</h2><p><a href="#harvest">Harvest</a> Gone</p>'
        )
    })

    test('a heading takes the slug of its text; a repeated one takes the slug of its parent, then a number', () => {
        expect(
            headingIds([
                { depth: 1, text: 'Garden: a Review' },
                { depth: 2, text: 'Spring' },
                { depth: 3, text: 'Tasks' },
                { depth: 2, text: 'Autumn' },
                { depth: 3, text: 'Tasks' },
                { depth: 3, text: 'Tasks' },
                { depth: 2, text: 'Légumes 🌱' }
            ])
        ).toEqual([
            'garden-a-review',
            'spring',
            'tasks',
            'autumn',
            'autumn-tasks',
            'autumn-tasks-2',
            'légumes'
        ])
        expect(slugOf('!!!')).toBe('section')
        expect(headingIds([{ depth: 2, text: 'Notes' }], new Set(['notes']))).toEqual(['notes-2'])
    })

    test('an old hash of the current site finds its heading: the text with + for a space, and Parent#Child', () => {
        const headings = [
            { depth: 2, text: 'Panels: a review', id: 'panels-a-review' },
            { depth: 2, text: 'Spring', id: 'spring' },
            { depth: 3, text: 'Tasks', id: 'tasks' },
            { depth: 2, text: 'Autumn', id: 'autumn' },
            { depth: 3, text: 'Tasks', id: 'autumn-tasks' }
        ]
        expect(headingFor(headings, 'panels+a+review')).toBe('panels-a-review')
        expect(headingFor(headings, 'Panels: a review')).toBe('panels-a-review')
        expect(headingFor(headings, 'Tasks')).toBe('tasks')
        expect(headingFor(headings, 'Autumn#Tasks')).toBe('autumn-tasks')
        expect(headingFor(headings, 'Winter')).toBeUndefined()
        expect(headingFor(headings, '')).toBeUndefined()
    })
})

describe('script of a note page for an old hash (URL-14)', () => {
    /** Runs the script on a page with these headings and this hash; returns where it went. */
    function run(hash: string): { scrolled: string | undefined; replaced: string | undefined } {
        let scrolled: string | undefined
        let replaced: string | undefined
        // The H1 of the title band (issue 47) is outside the note body: the
        // script finds it only through its own selector.
        // Its text is the title property, and `data-heading` keeps the text
        // of the H1 of the note, which the old hash names.
        const title = {
            tagName: 'H1',
            textContent: 'A journal of the garden',
            dataset: { heading: 'Garden journal' },
            id: 'garden-journal',
            scrollIntoView: () => {
                scrolled = 'garden-journal'
            }
        }
        const headings = [
            ['H2', 'Panels: a review', 'panels-a-review'],
            ['H2', 'Spring', 'spring'],
            ['H3', 'Tasks', 'tasks'],
            ['H2', 'Autumn', 'autumn'],
            ['H3', 'Tasks', 'autumn-tasks']
        ].map(([tagName, textContent, id]) => ({
            tagName,
            textContent,
            id,
            scrollIntoView: () => {
                scrolled = id
            }
        }))
        runInNewContext(oldAnchorScript, {
            location: { hash },
            document: {
                getElementById: (id: string) =>
                    [title, ...headings].find((heading) => heading.id === id) ?? null,
                querySelectorAll: (selector: string) =>
                    selector.includes('[data-note-title]') ? [title, ...headings] : headings,
                getElementsByName: (name: string) =>
                    name === 'user-content-top'
                        ? [
                              {
                                  scrollIntoView: () => {
                                      scrolled = name
                                  }
                              }
                          ]
                        : []
            },
            history: {
                replaceState: (_state: unknown, _title: string, url: string) => {
                    replaced = url
                }
            },
            addEventListener: () => undefined
        })
        return { scrolled, replaced }
    }

    test('an old hash goes to its heading, and the address takes the new id', () => {
        expect(run('#panels+a+review')).toEqual({
            scrolled: 'panels-a-review',
            replaced: '#panels-a-review'
        })
        expect(run('#Panels:%20a%20review')).toEqual({
            scrolled: 'panels-a-review',
            replaced: '#panels-a-review'
        })
        expect(run('#Autumn#Tasks')).toEqual({
            scrolled: 'autumn-tasks',
            replaced: '#autumn-tasks'
        })
        expect(run('#Garden+journal')).toEqual({
            scrolled: 'garden-journal',
            replaced: '#garden-journal'
        })
        // An anchor of raw HTML (`<a name="top">`) has the prefix of the allow list.
        expect(run('#top')).toEqual({ scrolled: 'user-content-top', replaced: undefined })
    })

    test('a hash that is an id, an unknown hash and no hash change nothing', () => {
        expect(run('#autumn-tasks')).toEqual({ scrolled: undefined, replaced: undefined })
        expect(run('#Winter')).toEqual({ scrolled: undefined, replaced: undefined })
        expect(run('')).toEqual({ scrolled: undefined, replaced: undefined })
    })
})

describe('embeds of notes (REN-01)', () => {
    test('an embed of a published note shows the note, with its own links in their state and no id', () => {
        const compost = note(
            'Compost.md',
            '<h1 id="compost">Compost</h1><p>Turn it. <note-link data-link="Rain%20barrel">Water</note-link> <note-link data-link="Draft">Draft</note-link></p>',
            { 'Rain barrel': 'Rain barrel.md', 'Draft': 'Draft.md' }
        )
        expect(
            page(
                '<p><note-link data-link="Compost" data-embed="">Compost</note-link></p>',
                { Compost: 'Compost.md' },
                compost,
                BARREL
            )
        ).toBe(
            '<div class="note-embed" data-embed-of="/Compost"><h2>Compost</h2><p>Turn it. <a href="/Rain+barrel">Water</a> <span class="not-published">Draft</span></p></div>'
        )
    })

    test('an embed of a heading shows its section, up to the next heading of its level or above', () => {
        const guide = note(
            'Guide.md',
            '<h2 id="a">A</h2><p>one</p><h3 id="b">B</h3><p>two</p><h2 id="c">C</h2><p>three</p>'
        )
        expect(
            page(
                '<note-link data-link="Guide" data-fragment="A" data-embed="">x</note-link>',
                { Guide: 'Guide.md' },
                guide
            )
        ).toBe(
            '<div class="note-embed" data-embed-of="/Guide"><h3>A</h3><p>one</p><h4>B</h4><p>two</p></div>'
        )
    })

    test('an embed of a block shows that block only; a list item stays in a list', () => {
        const guide = note(
            'Guide.md',
            '<p id="^one">One.</p><ul><li id="^two">Two.</li><li>Three.</li></ul>'
        )
        const render = (fragment: string): string =>
            page(
                `<note-link data-link="Guide" data-fragment="${fragment}" data-embed="">x</note-link>`,
                { Guide: 'Guide.md' },
                guide
            )
        expect(render('%5Eone')).toBe(
            '<div class="note-embed" data-embed-of="/Guide"><p>One.</p></div>'
        )
        expect(render('%5Etwo')).toBe(
            '<div class="note-embed" data-embed-of="/Guide"><ul><li>Two.</li></ul></div>'
        )
    })

    test('an embed of a heading or a block that the note does not have is a link to the note', () => {
        const guide = note('Guide.md', '<p>Text.</p>')
        expect(
            page(
                '<note-link data-link="Guide" data-fragment="%5Enone" data-embed="">Guide</note-link>',
                { Guide: 'Guide.md' },
                guide
            )
        ).toBe('<a href="/Guide">Guide</a>')
    })

    test('an embed of a note that is not published is plain text in the style', () => {
        expect(
            page(
                '<note-link data-link="Frost%20dates" data-embed="">Frost dates</note-link>',
                LINKS
            )
        ).toBe('<span class="not-published">Frost dates</span>')
    })

    test('two notes that embed each other show each text once: the embed that closes the cycle is a link', () => {
        const one = note(
            'One.md',
            '<p>First text.</p><p><note-link data-link="Two" data-embed="">Two</note-link></p>',
            { Two: 'Two.md' }
        )
        const two = note(
            'Two.md',
            '<p>Second text.</p><p><note-link data-link="One" data-embed="">One</note-link></p>',
            { One: 'One.md' }
        )
        expect(new SitePages([one, two]).render('One.md')).toBe(
            '<p>First text.</p><div class="note-embed" data-embed-of="/Two"><p>Second text.</p><p><a href="/One">One</a></p></div>'
        )
    })

    test('a link into the embedded note itself, and a footnote of it, lead to that note, not to the page', () => {
        const other = note(
            'Other.md',
            '<h2 id="other">Other</h2><p><note-link data-link="" data-fragment="Other">Other</note-link><sup><a href="#user-content-fn-1">1</a></sup></p>'
        )
        expect(
            page(
                '<note-link data-link="Other" data-embed="">Other</note-link>',
                { Other: 'Other.md' },
                other
            )
        ).toBe(
            '<div class="note-embed" data-embed-of="/Other"><h3>Other</h3><p><a href="/Other#other">Other</a><sup><a href="/Other#user-content-fn-1">1</a></sup></p></div>'
        )
    })

    test('an embed inside a paragraph splits it: a paragraph never holds a block', () => {
        const other = note('Other.md', '<p>Inner.</p>')
        expect(
            page(
                '<p>Before <note-link data-link="Other" data-embed="">Other</note-link> after.</p>',
                { Other: 'Other.md' },
                other
            )
        ).toBe(
            '<p>Before </p><div class="note-embed" data-embed-of="/Other"><p>Inner.</p></div><p> after.</p>'
        )
    })

    test('embeds on lines that follow each other leave no line break and no empty paragraph', () => {
        const other = note('Other.md', '<p>Inner.</p>')
        const embed = '<note-link data-link="Other" data-embed="">Other</note-link>'
        expect(
            page(
                `<p>Line1<br>\n${embed}<br>\n${embed}<br>\nLine3</p>`,
                { Other: 'Other.md' },
                other
            )
        ).toBe(
            '<p>Line1</p><div class="note-embed" data-embed-of="/Other"><p>Inner.</p></div><div class="note-embed" data-embed-of="/Other"><p>Inner.</p></div><p>Line3</p>'
        )
    })

    test('a split paragraph keeps its block id on its first piece only', () => {
        const other = note('Other.md', '<p>Inner.</p>')
        expect(
            page(
                '<p id="^blk">Before <note-link data-link="Other" data-embed="">Other</note-link> after</p>',
                { Other: 'Other.md' },
                other
            )
        ).toBe(
            '<p id="^blk">Before </p><div class="note-embed" data-embed-of="/Other"><p>Inner.</p></div><p> after</p>'
        )
    })

    test('an embed inside bold text is lifted out of the paragraph, and the bold text is cut around it', () => {
        const other = note('Other.md', '<p>Inner.</p>')
        expect(
            page(
                '<p>A <strong>bold <note-link data-link="Other" data-embed="">Other</note-link> x</strong> b</p>',
                { Other: 'Other.md' },
                other
            )
        ).toBe(
            '<p>A <strong>bold </strong></p><div class="note-embed" data-embed-of="/Other"><p>Inner.</p></div><p><strong> x</strong> b</p>'
        )
    })

    test('a diagram in an embed keeps its own ids and its title, apart from a diagram of the page', () => {
        const svg = (title: string): string =>
            `<figure class="diagram"><svg class="pele" aria-labelledby="diagram-1-title"><title id="diagram-1-title">${title}</title><rect fill="url(#diagram-1-grad)"></rect><linearGradient id="diagram-1-grad"></linearGradient></svg></figure>`
        const other = note('Other.md', svg('Embedded'))
        const html = page(
            `${svg('Host')}<note-link data-link="Other" data-embed="">Other</note-link>`,
            { Other: 'Other.md' },
            other
        )
        const ids = [...html.matchAll(/ id="([^"]+)"/gu)].map(([, id]) => id)
        expect(new Set(ids).size).toBe(ids.length)
        expect(ids).toHaveLength(4)
        const embedded = html.slice(html.indexOf('note-embed'))
        const label = /aria-labelledby="([^"]+)"/u.exec(embedded)?.[1] ?? ''
        expect(embedded).toContain(`<title id="${label}">Embedded</title>`)
        expect(embedded).toMatch(/fill="url\(#(e1-diagram-1-grad)\)".*id="\1"/u)
    })

    test('a note that embeds itself shows a link to itself', () => {
        const self = note(
            'Self.md',
            '<p>Text.</p><p><note-link data-link="Self" data-embed="">Self</note-link></p>',
            { Self: 'Self.md' }
        )
        expect(new SitePages([self]).render('Self.md')).toBe(
            '<p>Text.</p><p><a href="/Self">Self</a></p>'
        )
    })

    test('a chain of embeds stops at the depth limit with a link', () => {
        const chain = Array.from({ length: EMBED_DEPTH + 2 }, (_, index) =>
            note(
                `N${String(index)}.md`,
                `<p>Text ${String(index)}.</p><p><note-link data-link="N${String(index + 1)}" data-embed="">N${String(index + 1)}</note-link></p>`,
                {
                    [`N${String(index + 1)}`]: `N${String(index + 1)}.md`
                }
            )
        )
        const html = new SitePages(chain).render('N0.md')
        for (let index = 0; index < EMBED_DEPTH; index += 1) {
            expect(html).toContain(`Text ${String(index)}.`)
        }
        expect(html).not.toContain(`Text ${String(EMBED_DEPTH)}.`)
        expect(html).toContain(`<a href="/N${String(EMBED_DEPTH)}">N${String(EMBED_DEPTH)}</a>`)
    })
})

describe('link cards (CARD-01 to CARD-09)', () => {
    const NOTES = { 'Rain barrel': 'Rain barrel.md', 'Draft': 'Draft.md' }
    const card = (inner: string): string => `<link-card>${inner}</link-card>`

    test('a card to another site shows its title and the name of the site, with no request to it', () => {
        expect(
            page(
                '<link-cards><link-card data-url="https://www.garden.example/soil">Soil</link-card></link-cards>'
            )
        ).toBe(
            '<div class="link-cards"><div class="link-card"><a class="link-card-link" href="https://www.garden.example/soil"><span class="link-card-title">Soil</span><span class="link-card-source">garden.example</span></a></div></div>'
        )
    })

    test('a card of a published note leads to it; one of a note that is not published is plain text; one with no target goes', () => {
        const html = page(
            `<link-cards>${card('<note-link data-link="Rain%20barrel">The barrel</note-link>')}${card('<note-link data-link="Draft">Draft</note-link>')}${card('<note-link data-link="Missing">Missing</note-link>')}</link-cards>`,
            NOTES,
            BARREL
        )
        expect(html).toBe(
            '<div class="link-cards"><div class="link-card"><a class="link-card-link" href="/Rain+barrel"><span class="link-card-title">The barrel</span></a></div><div class="link-card"><span class="not-published">Draft</span></div></div>'
        )
    })

    test('a card whose address is not http or https is dropped: no script and no data address', () => {
        for (const url of [
            'javascript:alert(1)',
            'JavaScript:alert(1)',
            'data:text/html,x',
            'vbscript:x',
            '//garden.example/x',
            'garden.md'
        ]) {
            expect(
                page(
                    `<link-cards><link-card data-url="${encodeURI(url)}">x</link-card></link-cards>`
                )
            ).toBe('')
        }
        expect(
            page(
                '<link-cards><link-card data-url="javascript://youtube.com/%0Aalert(3)" data-video="">x</link-card></link-cards>'
            )
        ).toBe('')
    })

    test('a video card leads to https only', () => {
        expect(
            page(
                '<link-cards><link-card data-url="http://www.youtube.com/watch?v=a" data-video="">v</link-card></link-cards>'
            )
        ).toBe('')
        expect(
            page(
                '<link-cards><link-card data-url="https://www.youtube.com/watch?v=a" data-video="">v</link-card></link-cards>'
            )
        ).toContain('href="https://www.youtube.com/watch?v=a"')
    })

    test('a card of a note leads to its heading; a card of an attachment leads to the file', () => {
        const guide = note('Guide.md', '<h2 id="spring">Spring</h2>')
        const self = note(
            'Self.md',
            `<link-cards>${card('<note-link data-link="Guide" data-fragment="Spring">Guide</note-link>')}${card('<note-link data-link="map.pdf">The map</note-link>')}</link-cards>`,
            { Guide: 'Guide.md' },
            { 'map.pdf': { url: '/-/attachments/k/map.pdf', name: 'map.pdf' } }
        )
        const html = new SitePages([self, guide]).render('Self.md')
        expect(html).toContain('href="/Guide#spring"')
        expect(html).toContain('href="/-/attachments/k/map.pdf"')
    })

    test('a block where no card can show is removed whole (CARD-05)', () => {
        expect(
            page(
                `<p>Before.</p><link-cards>${card('<note-link data-link="Missing">Secret</note-link>')}</link-cards>`,
                NOTES
            )
        ).toBe('<p>Before.</p>')
    })
})

// The attachments of a note (issue 35): the manifest entry says to which file
// each link leads, with its hashed URL and the size of an image.
describe('attachments of a page', () => {
    const KEY = 'a9526809f9da4f3a083bceb07247ac2633b41de1ddf9cad8d37e0a518b550a33'
    const FILES: Record<string, FileLink> = {
        'garden-plan.png': {
            url: `/-/attachments/${KEY}/garden-plan.png`,
            name: 'garden-plan.png',
            width: 16,
            height: 12
        },
        'plan.svg': { url: `/-/attachments/${KEY}/plan.svg`, name: 'plan.svg' },
        'pond.mp4': { url: `/-/attachments/${KEY}/pond.mp4`, name: 'pond.mp4' },
        'frogs.MP3': { url: `/-/attachments/${KEY}/frogs.MP3`, name: 'frogs.MP3' },
        'map.pdf': { url: `/-/attachments/${KEY}/map.pdf`, name: 'map.pdf' }
    }
    const render = (markup: string): string =>
        new SitePages([note('Self.md', markup, {}, FILES)]).render('Self.md')

    test('an embed of an image becomes an image with its width and its height', () => {
        expect(
            render(
                '<p><note-link data-link="garden-plan.png" data-embed="">garden-plan.png</note-link></p>'
            )
        ).toBe(
            `<p><img src="/-/attachments/${KEY}/garden-plan.png" alt="garden-plan.png" width="16" height="12" loading="lazy" decoding="async"></p>`
        )
    })

    test('an embed with a width keeps the shape of the image; a Markdown image takes the size after the bar', () => {
        expect(render('<note-link data-link="garden-plan.png" data-embed="">300</note-link>')).toBe(
            `<img src="/-/attachments/${KEY}/garden-plan.png" alt="garden-plan.png" width="300" height="225" loading="lazy" decoding="async">`
        )
        expect(
            render('<note-link data-link="garden-plan.png" data-embed="">40x10</note-link>')
        ).toContain('width="40" height="10"')
        expect(
            render('<note-link data-link="garden-plan.png" data-embed="">The plan|120</note-link>')
        ).toContain('alt="The plan" width="120" height="90"')
    })

    test('an image whose size is not known has no width and no height', () => {
        expect(render('<note-link data-link="plan.svg" data-embed="">A plan</note-link>')).toBe(
            `<img src="/-/attachments/${KEY}/plan.svg" alt="A plan" loading="lazy" decoding="async">`
        )
    })

    test('the text of an image is its alternative text, without markup, with its quotes escaped', () => {
        expect(
            render(
                '<note-link data-link="garden-plan.png" data-embed="">the "<em>new</em>" plan</note-link>'
            )
        ).toContain('alt="the &#x22;new&#x22; plan"')
    })

    test('an embed of a video and of a sound gets the player of the browser', () => {
        expect(render('<note-link data-link="pond.mp4" data-embed="">pond.mp4</note-link>')).toBe(
            `<video src="/-/attachments/${KEY}/pond.mp4" controls preload="metadata"></video>`
        )
        expect(render('<note-link data-link="frogs.MP3" data-embed="">frogs.MP3</note-link>')).toBe(
            `<audio src="/-/attachments/${KEY}/frogs.MP3" controls preload="metadata"></audio>`
        )
    })

    test('an embed of another file, and a link to a file, become a link to the file', () => {
        expect(render('<note-link data-link="map.pdf" data-embed="">map.pdf</note-link>')).toBe(
            `<a href="/-/attachments/${KEY}/map.pdf">map.pdf</a>`
        )
        expect(render('<note-link data-link="garden-plan.png">the plan</note-link>')).toBe(
            `<a href="/-/attachments/${KEY}/garden-plan.png">the plan</a>`
        )
    })

    test('an image inside a link to a file is an image inside one link', () => {
        expect(
            render(
                '<note-link data-link="map.pdf"><note-link data-link="garden-plan.png" data-embed="">The plan</note-link></note-link>'
            )
        ).toBe(
            `<a href="/-/attachments/${KEY}/map.pdf"><img src="/-/attachments/${KEY}/garden-plan.png" alt="The plan" width="16" height="12" loading="lazy" decoding="async"></a>`
        )
    })

    test('an embed of a file that is not an attachment is plain text in the style', () => {
        expect(
            render('<note-link data-link="shed-key.png" data-embed="">shed-key.png</note-link>')
        ).toBe('<span class="not-published">shed-key.png</span>')
    })
})

// The page of a note (issue 47): its body, with the H1 at its top taken out
// for the title band (R58), and the first image loaded at once (PERF-25).
describe('page of a note', () => {
    const KEY = 'a9526809f9da4f3a083bceb07247ac2633b41de1ddf9cad8d37e0a518b550a33'
    const FILES: Record<string, FileLink> = {
        'cover.png': {
            url: `/-/attachments/${KEY}/cover.png`,
            name: 'cover.png',
            width: 4,
            height: 3
        },
        'bed.png': { url: `/-/attachments/${KEY}/bed.png`, name: 'bed.png', width: 4, height: 3 }
    }
    const pageOf = (markup: string, ...others: SiteNote[]): ReturnType<SitePages['page']> =>
        new SitePages([note('Self.md', markup, LINKS, FILES), ...others]).page('Self.md')
    const image = (name: string): string =>
        `<note-link data-link="${name}" data-embed="">${name}</note-link>`

    test('takes the H1 at the top of the note out of the body, with its text and its id', () => {
        expect(pageOf('\n<h1 id="compost">Compost <em>basics</em></h1>\n<p>Turn it.</p>')).toEqual({
            heading: { text: 'Compost basics', id: 'compost' },
            html: '\n\n<p>Turn it.</p>'
        })
    })

    test('keeps an H1 that is not at the top, and a first heading of another level', () => {
        expect(pageOf('<p>Intro.</p>\n<h1 id="later">Later</h1>')).toEqual({
            html: '<p>Intro.</p>\n<h1 id="later">Later</h1>'
        })
        expect(pageOf('<h2 id="part">Part</h2>')).toEqual({ html: '<h2 id="part">Part</h2>' })
    })

    // The embeds hold no H1 (R58): the headings of an embed go one level down
    // per depth of the embed.
    test('gives the headings of an embedded note one level less, so the page has no H1 in its body', () => {
        const deep = note(
            'Deep.md',
            '<h1 id="deep">Deep</h1>\n<h5 id="five">Five</h5>\n<h6 id="six">Six</h6>\n<p><note-link data-link="Rain%20barrel" data-embed="">Rain barrel</note-link></p>',
            LINKS
        )
        const html = pageOf(
            '<p><note-link data-link="Deep" data-embed="">Deep</note-link></p>',
            deep,
            BARREL
        ).html

        expect(html).not.toContain('<h1')
        expect(html).toContain('<h2>Deep</h2>')
        expect(html).toContain('<h6>Five</h6>')
        expect(html).toContain('<h6>Six</h6>')
        // An embed inside an embed goes one level further down.
        expect(html).toContain('<h3>Rain barrel</h3>')
    })

    test('loads the first image at once with a high priority, and the others lazily', () => {
        expect(pageOf(`<p>${image('cover.png')}</p>\n<p>${image('bed.png')}</p>`).html).toBe(
            `<p><img src="/-/attachments/${KEY}/cover.png" alt="cover.png" width="4" height="3" decoding="async" fetchpriority="high"></p>\n` +
                `<p><img src="/-/attachments/${KEY}/bed.png" alt="bed.png" width="4" height="3" loading="lazy" decoding="async"></p>`
        )
    })

    test('gives the priority to an image of raw HTML too, when it comes first', () => {
        expect(pageOf('<p><img src="/a.png" alt="A"></p>').html).toBe(
            '<p><img src="/a.png" alt="A" fetchpriority="high"></p>'
        )
    })

    test('does not change what the page step gives to an embed of the note', () => {
        const pages = new SitePages([note('Self.md', '<h1 id="self">Self</h1>', LINKS, FILES)])
        pages.page('Self.md')

        expect(pages.render('Self.md')).toBe('<h1 id="self">Self</h1>')
    })
})
