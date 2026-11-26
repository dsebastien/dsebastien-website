// The noindex property of a note (IDX-20, story 100, decision R85). A note
// with `publish_noindex: true` stays on the site: its page says
// `noindex, follow`, and it leaves the sitemaps (and so the batches of
// IndexNow, which follow the sitemaps). The site reads it from the cleaned
// note, as the other properties that only the site uses (`description`,
// `language`): the publishing tool keeps every property but `public_note`
// in the cleaned note, so the manifest entry, the canonical form and the
// parity do not change. Only the value `true` counts.

/** The key of the property. */
export const NOINDEX_PROPERTY = 'publish_noindex'

/** True when the properties of a note take it out of the index. */
export function isNoindexNote(properties: Readonly<Record<string, unknown>>): boolean {
    return properties[NOINDEX_PROPERTY] === true
}
