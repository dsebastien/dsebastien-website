import { SITEMAP_INDEX_PATH } from './sitemaps.ts'

// The rules for robots (URL-31, AGENT-01, AI-01, AI-04 of the spec; issue 54,
// seo items 42 to 44 and 146): one group that allows every crawler on every
// URL, with one Content Signals line for search and AI input and no training
// value (the answer differs per content class, AI-03), and the line of the
// sitemap index. A page that must stay out of the index says `noindex`; it is
// never blocked here, or a crawler could not read its `noindex`. The group
// for training crawlers (seo item 147) is not built at the first release
// (AI-05), and the rules of the host for AI bots are issue 21.

/** The text of `robots.txt` of the site at this origin. */
export function robotsText(origin: string): string {
    return [
        'User-agent: *',
        'Content-Signal: search=yes, ai-input=yes',
        'Allow: /',
        '',
        `Sitemap: ${new URL(SITEMAP_INDEX_PATH, origin).href}`,
        ''
    ].join('\n')
}
