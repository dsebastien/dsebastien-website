import type { Product } from './catalog.ts'

// The text of an ad card, as on the current site (`publish.js`): the badge in
// title case, then a line with the label of the price tier and the category.

/** The label of each price tier; a tier with an empty label or no label shows none. */
const TIER_LABELS: Readonly<Record<string, string>> = {
    free: 'Free',
    subscription: 'Membership',
    premium: 'Premium',
    standard: '',
    budget: '',
    enterprise: 'Enterprise'
}

/** A text in title case, with spaces for `-` and `_`: `best-value` gives `Best Value`. */
export function titleCase(text: string): string {
    return text.replace(/[-_]/gu, ' ').replace(/\b\w/gu, (letter) => letter.toUpperCase())
}

/** The line above the name of a product: the label of its tier and its category. */
export function kickerOf(product: Product): string {
    const tier = product.priceTier === undefined ? '' : (TIER_LABELS[product.priceTier] ?? '')
    return [tier, titleCase(product.mainCategory ?? '')].filter((part) => part !== '').join(' · ')
}
