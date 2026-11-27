// The mobile rules of the site (issue 91, PAGE-07, DES-11, decision R95), as
// one function that runs in a page of a browser: the browser test gives it to
// `page.evaluate()`, so it imports nothing and uses only the globals of the
// page. It returns what breaks a rule; an empty list passes.
//
// - width: nothing makes the page scroll sideways. A wide part (a table, a
//   code block, a diagram) scrolls inside its own box.
// - target: every control is 44 by 44 px at least, but a link in a sentence
//   and a link in the text of a note, whose size the line of the text sets
//   (the inline exception of WCAG 2.5.8).
// - hover: a rule of the style sheets for `:hover` changes only colors, lines
//   and shadows: it shows, hides and moves nothing that a finger needs.
// - viewport: the width of the device, a zoom that the reader may change, the
//   page above the keyboard (`interactive-widget=resizes-content`), and no
//   `viewport-fit=cover`, so the browser keeps the page inside the safe areas.
// - field: a text field has a text of 16 px at least: a phone zooms into a
//   smaller one when it takes the focus.

/** What breaks a mobile rule. */
export interface MobileFinding {
    rule: 'width' | 'target' | 'hover' | 'viewport' | 'field'
    detail: string
}

/**
 * Checks the mobile rules on the page in which it runs.
 *
 * @param screen the width of the screen in CSS pixels. A phone widens its
 *   layout to a page that is too wide and zooms out, so the page alone
 *   cannot tell that it is too wide.
 */
export function MOBILE_RULES(screen: number): MobileFinding[] {
    /** The smallest width and height of a control, and the smallest text of a field, in CSS pixels. */
    const TARGET = 44
    const FIELD_TEXT = 16
    const findings: MobileFinding[] = []
    const root = document.documentElement
    const width = Math.min(screen, root.clientWidth)

    const name = (element: Element): string => {
        const classes = [...element.classList].slice(0, 3).join('.')
        const text = element.textContent.replace(/\s+/gu, ' ').trim().slice(0, 40)
        return `<${element.tagName.toLowerCase()}${classes === '' ? '' : `.${classes}`}> "${text}"`
    }
    const shown = (element: Element): boolean => {
        if (element.getClientRects().length === 0) return false
        if (getComputedStyle(element).visibility === 'hidden') return false
        const box = element.getBoundingClientRect()
        // Text for screen readers only, and a skip link outside the page until it has the focus.
        if (box.width <= 1 && box.height <= 1) return false
        return box.bottom + scrollY > 0 && box.right + scrollX > 0
    }
    /** True when an ancestor cuts or scrolls what goes past its edges. */
    const clipped = (element: Element): boolean => {
        for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
            if (parent === document.body || parent === root) return false
            const overflow = getComputedStyle(parent).overflowX
            if (overflow !== 'visible') return true
        }
        return false
    }

    // width
    const widest = Math.max(root.scrollWidth, document.body.scrollWidth, root.clientWidth)
    if (widest > screen) {
        // An element that goes past the edge, or whose text does (a long word).
        const right = (element: Element): number => {
            const box = element.getBoundingClientRect()
            return getComputedStyle(element).overflowX === 'visible'
                ? Math.max(box.right, box.left + element.scrollWidth)
                : box.right
        }
        const wide = [...document.body.querySelectorAll('*')]
            .filter((element) => right(element) > width + 0.5)
            .filter((element) => shown(element) && !clipped(element))
            .filter((element) => ![...element.children].some((child) => right(child) > width + 0.5))
            .slice(0, 5)
            .map(name)
        findings.push({
            rule: 'width',
            detail: `the page is ${String(widest)} px wide on a screen of ${String(screen)} px: ${wide.join(', ')}`
        })
    }

    // target
    const blockOf = (element: Element): Element => {
        let parent = element.parentElement
        while (
            parent !== null &&
            ['inline', 'contents'].includes(getComputedStyle(parent).display)
        ) {
            parent = parent.parentElement
        }
        return parent ?? root
    }
    const inText = (element: Element): boolean => {
        if (getComputedStyle(element).display !== 'inline') return false
        if (element.closest('[data-note-body]') !== null) return true
        const own = element.textContent.replace(/\s+/gu, '')
        const around = blockOf(element).textContent.replace(/\s+/gu, '')
        return around.length > own.length
    }
    const controls = document.querySelectorAll(
        'a[href], button, summary, input:not([type="hidden"]), select, textarea, [role="button"], [role="option"], [tabindex]:not([tabindex="-1"])'
    )
    for (const control of controls) {
        if (!shown(control) || control.matches(':disabled') || inText(control)) continue
        // A link that covers its row with a pseudo-element (a result of the
        // search) has the size of the row.
        const after = getComputedStyle(control, '::after')
        const cover =
            after.content !== 'none' && after.position === 'absolute'
                ? (control as HTMLElement).offsetParent
                : null
        const box = (cover ?? control).getBoundingClientRect()
        if (box.width < TARGET - 0.5 || box.height < TARGET - 0.5) {
            findings.push({
                rule: 'target',
                detail: `${name(control)} is ${String(Math.round(box.width))} by ${String(Math.round(box.height))} px`
            })
        }
    }

    // hover
    const allowed =
        /^(color|background-color|background|border(-(top|right|bottom|left|block|inline)(-(start|end))?)?-color|border-color|text-decoration(-.+)?|box-shadow|outline(-.+)?|--tw-.+|transition(-.+)?)$/u
    const rules = (list: CSSRuleList): CSSStyleRule[] =>
        [...list].flatMap((rule) => {
            const inner = 'cssRules' in rule ? rules((rule as CSSGroupingRule).cssRules) : []
            return rule instanceof CSSStyleRule ? [rule, ...inner] : inner
        })
    for (const sheet of document.styleSheets) {
        let list: CSSRuleList
        try {
            list = sheet.cssRules
        } catch {
            continue
        }
        for (const rule of rules(list)) {
            if (!rule.selectorText.includes(':hover')) continue
            const changed = [...rule.style].filter((property) => !allowed.test(property))
            if (changed.length > 0) {
                findings.push({
                    rule: 'hover',
                    detail: `${rule.selectorText} sets ${changed.join(', ')}`
                })
            }
        }
    }

    // viewport
    const viewport = document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? ''
    const parts = new Map(
        viewport.split(',').map((part) => {
            const [key = '', value = ''] = part.split('=').map((text) => text.trim())
            return [key, value] as const
        })
    )
    const wanted: [string, (value: string | undefined) => boolean][] = [
        ['width', (value) => value === 'device-width'],
        ['initial-scale', (value) => value === '1'],
        ['interactive-widget', (value) => value === 'resizes-content'],
        ['user-scalable', (value) => value === undefined || value === 'yes'],
        ['maximum-scale', (value) => value === undefined || Number(value) >= 5],
        ['viewport-fit', (value) => value === undefined || value === 'auto']
    ]
    for (const [key, valid] of wanted) {
        if (!valid(parts.get(key))) {
            findings.push({ rule: 'viewport', detail: `"${viewport}" has a wrong ${key}` })
        }
    }

    // field
    for (const field of document.querySelectorAll('input:not([type="hidden"]), textarea, select')) {
        if (field instanceof HTMLInputElement && ['checkbox', 'radio'].includes(field.type))
            continue
        if (!shown(field)) continue
        const size = Number.parseFloat(getComputedStyle(field).fontSize)
        if (size < FIELD_TEXT) {
            findings.push({
                rule: 'field',
                detail: `${name(field)} has a text of ${String(size)} px`
            })
        }
    }
    return findings
}
