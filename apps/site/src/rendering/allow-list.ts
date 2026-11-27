import { defaultSchema, type Options } from 'rehype-sanitize'
import { BUILT_MARK, MARK } from './mark.ts'

// The allow list of the HTML of a note (REN-15 of the spec): a rule of
// security, not a privacy check. Raw HTML in a note is read with the rest of
// the note and keeps only the elements and the attributes of this list, as
// Obsidian keeps only what its sanitizer allows. It starts from the list of
// GitHub (`defaultSchema` of `hast-util-sanitize`): no script, no style, no
// frame, no form, no event attribute, no `javascript:` address.
//
// The steps of the site add to it what they write before the list runs: the
// marks of the page step, the callouts, the tags and the highlights. A note
// can write a mark of its own: the page step resolves it like the others,
// through the manifest, so it can only lead to a published note.
//
// Ids are kept as they are (no `user-content-` prefix): the ids of the
// headings, the blocks and the footnotes are the anchors of a page (URL-14).
// The HTML step after the list gives a number to an id of raw HTML that is
// an id of the frame of the page or that the build writes, and to any
// repeated id (issue 124). A `name` gets the prefix.

// Only the data attributes that the steps of the site write before the list
// runs are kept, each on its element: the callouts, the footnotes, the tasks, the marks
// and the mark of the build (issue 124). Every other one goes (issue 79): the
// scripts of a page find their elements by data attributes (the properties
// panel, the mode switch, the headings, the links of the ads), which only the
// site writes.
//
// The list of GitHub limits the classes of some elements (`a`, `li`, `ul`,
// `code`) to the ones that GitHub writes. Here every element may have a class,
// so these limits go: the steps of the site write their own classes there (a
// tag is `a.tag`).
const base = Object.fromEntries(
    Object.entries(defaultSchema.attributes ?? {}).map(([name, list]) => [
        name,
        list.filter((item) => !(Array.isArray(item) && item[0] === 'className'))
    ])
)

export const allowList: Options = {
    ...defaultSchema,
    // A `name` gets the prefix, so that a note cannot hide a property of the
    // document (`<img name="querySelectorAll">`) from the scripts of the page.
    clobber: ['name'],
    clobberPrefix: 'user-content-',
    strip: ['script', 'style', 'template', 'noscript', 'iframe', 'object', 'embed'],
    tagNames: [
        ...(defaultSchema.tagNames ?? []),
        'mark',
        'section',
        MARK.link,
        MARK.cards,
        MARK.card
    ],
    attributes: {
        ...base,
        '*': [...(base['*'] ?? []), 'className', 'id', BUILT_MARK],
        'div': [...(base['div'] ?? []), 'dataCallout'],
        'details': [...(base['details'] ?? []), 'open', 'dataCallout', 'dataCalloutFold'],
        'section': [...(base['section'] ?? []), 'dataFootnotes'],
        // The parser of Obsidian marks the character of a task.
        'li': [...(base['li'] ?? []), 'dataTaskChar'],
        'a': [...(base['a'] ?? []), 'dataFootnoteRef', 'dataFootnoteBackref'],
        [MARK.link]: ['dataLink', 'dataFragment', 'dataEmbed', 'dataAddress'],
        [MARK.card]: ['dataUrl', 'dataVideo']
    }
}
