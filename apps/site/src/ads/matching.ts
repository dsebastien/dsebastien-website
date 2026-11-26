import type { Product } from './catalog.ts'
import { ALIASES, TITLE_PHRASES } from './vocabulary.ts'

// The matching of the ads (AD-01, AD-02, MOD-11): the rule of the current site
// (`publish.js`, "Product CTAs", research 1.7), with the fix of decision R3.
//
// - A token is a text in small letters, `_` as `-`, with nothing but `a` to
//   `z`, digits and `-`.
// - The tokens of a note: each level of each tag of its `tags` property, and
//   the whole tag with `-` for `/` (not the tags of the system, `type/` and
//   `zone/`); each word of each of its `topics`, and the whole topic with `-`
//   between its words (a wikilink gives its target and its text); the phrases
//   of `TITLE_PHRASES` that its file name holds. The fix of R3: a single word
//   of a title of several words is no token any more; a title of one word is.
//   Each token adds the tokens of the alias map, one step.
// - The score of a product: 10,000 per tag of the product that is a token,
//   plus 2,000 times the share of its tags that match, plus a fifth of its
//   commercial rank (best value 500, bestseller 250, featured 100, plus its
//   priority), each part rounded. A product with no matching tag is out. The
//   two best scores show, in the order of the catalog when two are equal.
// - No ad on person and quote notes (`persons`, `quotes`, `own-quotes`), by
//   their note type or by a `type/` tag with the level `person`, `persons`,
//   `quote` or `quotes`, and none on the paths of `NO_AD_PATHS`, as today (AD-11).

/** What the matching reads of a note. */
export interface NoteForAds {
    /** The vault path of the note. */
    readonly vaultPath?: string
    /** The file name of the note, without `.md`: the title of today. */
    readonly fileName: string
    /** The canonical name of the note type, when the note has one. */
    readonly noteType?: string
    /** The `tags` property of the note. */
    readonly tags: unknown
    /** The `topics` property of the note. */
    readonly topics: unknown
}

/** The alias map: the tokens that a token adds. */
export type AliasMap = Readonly<Record<string, readonly string[]>>

/** The note types that get no ad. */
export const NO_AD_TYPES: ReadonlySet<string> = new Set(['persons', 'quotes', 'own-quotes'])

/** The notes that get no ad by their vault path, as today. */
export const NO_AD_PATHS: ReadonlySet<string> = new Set([
    '50 Resources/55 Obsidian Publish/README.md'
])

/** The levels of a `type/` tag that mark a note with no ad. */
const NO_AD_TYPE_LEVELS: ReadonlySet<string> = new Set(['person', 'persons', 'quote', 'quotes'])

/** The products of an ad at the end of a note: two at most, as today. */
export const END_SLOTS = 2

/** The token of a text, as today: small letters, `_` as `-`, only `a` to `z`, digits and `-`. */
export function tokenOf(text: string): string {
    return text
        .toLowerCase()
        .replace(/_/gu, '-')
        .replace(/[^a-z0-9-]/gu, '')
}

function textsOf(value: unknown): string[] {
    const list: unknown[] = Array.isArray(value) ? value : [value]
    return list.filter((item): item is string => typeof item === 'string')
}

/** The texts of a topic: a text, or the target and the text of a wikilink. */
function topicTexts(topic: string): string[] {
    const link = /^\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]$/u.exec(topic.trim())
    if (link === null) {
        return [topic]
    }
    const target = (link[1] ?? '').split('/').pop() ?? ''
    return link[2] === undefined ? [target] : [target, link[2]]
}

/** True when a note gets no ad: a person or a quote note. */
export function hasNoAd(note: NoteForAds): boolean {
    if (note.vaultPath !== undefined && NO_AD_PATHS.has(note.vaultPath)) {
        return true
    }
    if (note.noteType !== undefined && NO_AD_TYPES.has(note.noteType)) {
        return true
    }
    return textsOf(note.tags).some((tag) => {
        const levels = tag.toLowerCase().split('/')
        return levels[0] === 'type' && levels.some((level) => NO_AD_TYPE_LEVELS.has(level))
    })
}

/** The tokens of a note (see the rule above). */
export function tokensOf(note: NoteForAds, aliases: AliasMap = ALIASES): Set<string> {
    const tokens = new Set<string>()
    const add = (text: string): void => {
        const token = tokenOf(text)
        if (token !== '') {
            tokens.add(token)
        }
    }
    for (const tag of textsOf(note.tags)) {
        const levels = tag.split('/')
        const space = (levels[0] ?? '').toLowerCase()
        if (space === 'zone' || space === 'type') {
            continue
        }
        levels.forEach(add)
        add(tag.replaceAll('/', '-'))
    }
    for (const topic of textsOf(note.topics).flatMap(topicTexts)) {
        topic.split(/\s+/u).forEach(add)
        add(topic.replace(/\s+/gu, '-'))
    }
    const words = note.fileName.split(/\s+/u).filter((word) => word !== '')
    if (words.length === 1) {
        add(words[0] ?? '')
    }
    const title = note.fileName.toLowerCase()
    for (const phrase of TITLE_PHRASES) {
        if (title.includes(phrase)) {
            tokens.add(phrase.replace(/\s+/gu, '-'))
        }
    }
    const expanded = new Set<string>()
    for (const token of tokens) {
        expanded.add(token)
        for (const alias of aliases[token] ?? []) {
            expanded.add(alias)
        }
    }
    return expanded
}

function rankOf(product: Product): number {
    return (
        (product.bestValue ? 500 : 0) +
        (product.bestseller ? 250 : 0) +
        (product.featured ? 100 : 0) +
        product.priority
    )
}

/** The score of a product for the tokens of a note: 0 when none of its tags matches. */
export function scoreOf(product: Product, tokens: ReadonlySet<string>): number {
    const matches = product.tags.filter((tag) => tokens.has(tag)).length
    if (matches === 0) {
        return 0
    }
    const density = matches / Math.max(product.tags.length, 1)
    return matches * 10000 + Math.round(density * 2000) + Math.round(rankOf(product) * 0.2)
}

/** The products of the ad at the end of a note, in their order: none when nothing matches. */
export function adProductsOf(
    note: NoteForAds,
    products: readonly Product[],
    aliases: AliasMap = ALIASES
): Product[] {
    if (hasNoAd(note)) {
        return []
    }
    const tokens = tokensOf(note, aliases)
    return products
        .map((product) => ({ product, score: scoreOf(product, tokens) }))
        .filter((scored) => scored.score > 0)
        .sort((one, two) => two.score - one.score)
        .slice(0, END_SLOTS)
        .map((scored) => scored.product)
}
