import { HOST_NAME } from '../host-name.ts'

// The analytics of the site (AN-01, AN-03, business rule 9): Plausible through
// the proxy of the author (his own Worker), as the current site does, with no
// cookie. The site id and the addresses of the proxy are settings of the
// deploy target (`analytics` of the private target file), never constants of
// the code: a deployment gives them to the build in the variable
// `SITE_ANALYTICS`, and the build writes them into the pages, which stay
// static. A build without that variable (a local build, a test, the public
// CI) has no analytics tag at all, so nothing reaches a real site id by
// mistake.
//
// The script is the `manual` variant of the proxy: it sends no page view by
// itself, so each page sends its own. That is what keeps the goal of the
// current site "pageview of /404" (decision R9): the plain script always sends
// the address of the page, the manual one takes another address. A normal
// page sends its view as it is; the "not found" page sends `/404`, with the
// missing path as the property `path`.

/** The analytics settings of a deploy target. */
export interface AnalyticsSettings {
    /** The site id of the analytics tool: the domain of the site in Plausible. */
    readonly siteId: string
    /** The address of the script on the proxy: its `manual` variant. */
    readonly script: string
    /** The address of the events on the proxy. */
    readonly event: string
}

/** The variable that gives the analytics settings to a build, as JSON. */
export const ANALYTICS_VARIABLE = 'SITE_ANALYTICS'

/** The path that the "not found" page sends as its page view (decision R9). */
export const NOT_FOUND_PATH = '/404'

/** The path that the gone page of an unpublished note sends as its page view. */
export const GONE_PATH = '/410'

/** The page view of a page: its own address, or the path of an error page with the path of the request. */
export type PageViewKind = 'page' | 'not-found' | 'gone'

/** The script that sends no page view by itself. */
const MANUAL_SCRIPT = /\/script\.manual\.js$/u

/** The address when it is a plain https address (no credentials, query or fragment). */
function plainAddress(value: unknown): URL | undefined {
    if (typeof value !== 'string' || !URL.canParse(value)) {
        return undefined
    }
    const url = new URL(value)
    const plain =
        url.protocol === 'https:' &&
        url.username === '' &&
        url.password === '' &&
        !value.includes('?') &&
        !value.includes('#')
    return plain ? url : undefined
}

const FIELDS = ['siteId', 'script', 'event'] as const

/** Reads the analytics settings of a target. It throws with the name of the first field that is wrong. */
export function analyticsFrom(value: unknown): AnalyticsSettings {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('the analytics settings must be an object')
    }
    const fields: Record<string, unknown> = { ...value }
    for (const key of Object.keys(fields)) {
        if (!(FIELDS as readonly string[]).includes(key)) {
            throw new Error(`the analytics settings have an unknown field: ${key}`)
        }
    }
    const siteId = fields['siteId']
    if (typeof siteId !== 'string' || !HOST_NAME.test(siteId)) {
        throw new Error('the analytics settings have a wrong or missing siteId')
    }
    const script = plainAddress(fields['script'])
    if (script === undefined || !MANUAL_SCRIPT.test(script.pathname)) {
        throw new Error(
            'the analytics settings have a wrong or missing script (an https address of script.manual.js)'
        )
    }
    // One host for the script and the events: the page talks to the proxy only.
    const event = plainAddress(fields['event'])
    if (event?.origin !== script.origin) {
        throw new Error(
            'the analytics settings have a wrong or missing event (an https address on the host of the script)'
        )
    }
    return { siteId, script: String(fields['script']), event: String(fields['event']) }
}

/** The analytics settings of a build, from its environment, or `undefined` for no analytics. */
export function analyticsOfEnvironment(
    environment: Readonly<Record<string, string | undefined>>
): AnalyticsSettings | undefined {
    const text = environment[ANALYTICS_VARIABLE]
    if (text === undefined || text === '') {
        return undefined
    }
    let value: unknown
    try {
        value = JSON.parse(text)
    } catch {
        throw new Error(`${ANALYTICS_VARIABLE} is not JSON`)
    }
    return analyticsFrom(value)
}

/** The attributes of the script element of the analytics: after the page, never in its way. */
export function analyticsTag(settings: AnalyticsSettings): Record<string, string | boolean> {
    return {
        'src': settings.script,
        'defer': true,
        'data-domain': settings.siteId,
        'data-api': settings.event
    }
}

/**
 * The inline script of the page view. Before the script of the proxy loads,
 * `window.plausible` is the queue of the current site (`publish.js`), which
 * the script sends when it loads. The "not found" page and the gone page send
 * their path (`/404`, `/410`) with the path of the request as the property
 * `path`. The manual script does not count a page that the browser shows
 * again from its back-forward cache, so this script sends the view again
 * then, as the plain script does. A call that fails never breaks the page.
 * It is one block, so it declares no global name.
 */
export function pageViewScript(kind: PageViewKind): string {
    const path = kind === 'not-found' ? NOT_FOUND_PATH : GONE_PATH
    const view =
        kind === 'page'
            ? `window.plausible('pageview')`
            : `window.plausible('pageview', { u: location.origin + ${JSON.stringify(path)}, props: { path: location.pathname } })`
    return `{
    window.plausible = window.plausible || function () {
        (window.plausible.q = window.plausible.q || []).push(arguments)
    }
    const view = () => {
        try {
            ${view}
        } catch {}
    }
    view()
    addEventListener('pageshow', (event) => {
        if (event.persisted) view()
    })
}`
}
