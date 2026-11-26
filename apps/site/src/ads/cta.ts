// The click of an ad (AN-02, decision R9): the event `cta_clicked` keeps its
// name and its five properties, `product`, `position`, `slot`, `page` and
// `href`, so that ad clicks stay comparable with the baseline. Each link of an
// ad carries the first four in data attributes; `href` is the address of the
// link. One listener in the capture phase reads them (AN-04), with the
// selector and the values of the current site (`publish.js`).
//
// The script sends through `window.plausible`, the call of the analytics
// script of the proxy (issue 57, `analytics/analytics.ts`). Before that
// script loads, the call is the queue of the current site (`publish.js`),
// which the script sends when it loads.
// When the call fails, the click goes on: the event never breaks the link.

/** The name of the event of an ad click. */
export const CTA_EVENT = 'cta_clicked'

/** The position of the ad at the end of a note. */
export const END_POSITION = 'end'

/** The data attributes of the link of an ad, from the product, the position, the slot and the page. */
export function ctaAttributes(
    product: string,
    position: string,
    slot: number,
    page: string
): Record<string, string> {
    return {
        'data-cta-product': product,
        'data-cta-position': position,
        'data-cta-slot': String(slot),
        'data-cta-page': page
    }
}

/** The script of the ad clicks. It is one block, so it declares no global name. */
export const ctaScript = `{
    window.plausible = window.plausible || function () {
        (window.plausible.q = window.plausible.q || []).push(arguments)
    }
    addEventListener('click', (event) => {
        const link = event.target?.closest?.('a[data-cta-position]')
        if (!link) return
        try {
            const data = link.dataset
            window.plausible(${JSON.stringify(CTA_EVENT)}, { props: { product: data.ctaProduct, position: data.ctaPosition, slot: data.ctaSlot, page: data.ctaPage, href: link.href } })
        } catch {}
    }, true)
}`
