import { compareCodePoints } from '../../../plugin/src/publishing/order.ts'
import { isSystemTag } from '../lists.ts'
import type { Product } from './catalog.ts'

// The matching of the ads (AD-01, AD-02, MOD-11). The rule of the current site
// (research 1.7), with the fix of decision R3:
//
// - The tokens of a note: the last level of each of its tags (not the tags of
//   the system, `type/` and `zone/`), its `topics`, and its title: the whole
//   title and each phrase of two words or more in it. A single word of a
//   longer title is never a token, so `Rain barrel` matches no product tagged
//   `barrel`. The alias map adds tokens.
// - A product matches a note when one of its tags is a token. The order: the
//   number of matching tags, then the share of the tags of the product that
//   match, then the commercial rank (best value, bestseller, featured,
//   priority) as a small nudge, then the id. No match gives no ad.
// - No ad on person and quote notes, as today (AD-11).

/** What the matching reads of a note. */
export interface NoteForAds {
    /** The display title of the note. */
    readonly title: string
    /** The canonical name of the note type, when the note has one. */
    readonly noteType?: string
    /** The tags of the note, by their folded forms, with their parent levels. */
    readonly tags: Iterable<string>
    /** The `topics` property of the note. */
    readonly topics: unknown
}

/** The alias map: the tokens that a token adds. */
export type AliasMap = Readonly<Record<string, readonly string[]>>

/** The alias map of the site. */
export const ALIASES: AliasMap = {
    pkm: ['personal-knowledge-management', 'knowledge-management']
}

/** The note types that get no ad. */
export const NO_AD_TYPES: ReadonlySet<string> = new Set(['persons', 'quotes', 'own-quotes'])

/** The products of an ad at the end of a note: two at most, as today. */
export const END_SLOTS = 2

/** The folded form of a text: small letters, no accents, a hyphen between words. */
export function slugOf(text: string): string {
    return text
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/gu, '')
}

/** The texts of a `topics` property: a text, or the target and the text of a wikilink. */
function topicTexts(topics: unknown): string[] {
    const list: unknown[] = Array.isArray(topics) ? topics : [topics]
    return list.flatMap((item) => {
        if (typeof item !== 'string') {
            return []
        }
        const link = /^\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]$/u.exec(item.trim())
        if (link === null) {
            return [item]
        }
        const target = (link[1] ?? '').split('/').pop() ?? ''
        return link[2] === undefined ? [target] : [target, link[2]]
    })
}

/** The phrases of a title: the whole title, and each run of two words or more. */
function titlePhrases(title: string): string[] {
    const words = slugOf(title)
        .split('-')
        .filter((word) => word !== '')
    const phrases = [words.join('-')]
    for (let start = 0; start < words.length; start++) {
        for (let end = start + 2; end <= words.length; end++) {
            phrases.push(words.slice(start, end).join('-'))
        }
    }
    return phrases
}

/** The tokens of a note (see the rule above). */
export function tokensOf(note: NoteForAds, aliases: AliasMap = ALIASES): Set<string> {
    const texts = [
        ...[...note.tags]
            .filter((tag) => !isSystemTag(tag))
            .map((tag) => tag.split('/').pop() ?? ''),
        ...topicTexts(note.topics),
        ...titlePhrases(note.title)
    ]
    const tokens = new Set<string>()
    for (const text of texts) {
        const token = slugOf(text)
        if (token !== '') {
            tokens.add(token)
            for (const alias of aliases[token] ?? []) {
                tokens.add(slugOf(alias))
            }
        }
    }
    return tokens
}

function rankOf(product: Product): number {
    const flags = [product.bestValue, product.bestseller, product.featured].filter(Boolean).length
    return flags + product.priority / 1000
}

/** The products of the ad at the end of a note, in their order: none when nothing matches. */
export function adProductsOf(
    note: NoteForAds,
    products: readonly Product[],
    aliases: AliasMap = ALIASES
): Product[] {
    if (note.noteType !== undefined && NO_AD_TYPES.has(note.noteType)) {
        return []
    }
    const tokens = tokensOf(note, aliases)
    return products
        .map((product) => {
            const tags = new Set(product.tags.map(slugOf).filter((tag) => tag !== ''))
            const matched = [...tags].filter((tag) => tokens.has(tag)).length
            return { product, matched, density: tags.size === 0 ? 0 : matched / tags.size }
        })
        .filter((scored) => scored.matched > 0)
        .sort(
            (one, two) =>
                two.matched - one.matched ||
                two.density - one.density ||
                rankOf(two.product) - rankOf(one.product) ||
                compareCodePoints(one.product.id, two.product.id)
        )
        .slice(0, END_SLOTS)
        .map((scored) => scored.product)
}
