import { defaultSchema, type Options } from 'rehype-sanitize'
import { MARK } from './mark.ts'

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
    clobber: [],
    clobberPrefix: '',
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
        '*': [...(base['*'] ?? []), 'className', 'id', 'data*'],
        'details': [...(base['details'] ?? []), 'open']
    }
}
