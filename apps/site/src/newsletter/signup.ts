// The signup of the newsletter bar (NEWS-04). The service is the members API
// of the main site (Ghost 6 and later), called as `ghost-subscribe.js` of the
// author calls it (https://github.com/dsebastien/ghost-subscribe, MIT): an
// integrity token first, then the request of a signup with that token. This
// module is the only place that knows the service: the bar sees a result,
// and the page has no address of the service outside its bundled script.

/** The main site, whose members API takes the signups. */
const MEMBERS_SITE = 'https://www.dsebastien.net'

/** The longest wait for one answer of the service. */
const TIME_LIMIT = 10_000

/** The message of today when the service refuses with no message of its own. */
export const REFUSED_MESSAGE = 'Subscription failed. Please try again.'

/** What a signup gave. */
export type SignupResult =
    /** The service sent the mail that confirms the signup. */
    | { readonly kind: 'sent' }
    /** The address is a member already. */
    | { readonly kind: 'already' }
    /** The address is not one: nothing was sent. */
    | { readonly kind: 'invalid' }
    /** The service refused, with its message. */
    | { readonly kind: 'refused'; readonly message: string }
    /** The service could not be reached. */
    | { readonly kind: 'failed' }

/** The message of the first error of an answer of the service, if it has one. */
async function messageOf(answer: Response): Promise<string | undefined> {
    const data: unknown = await answer.json().catch(() => undefined)
    if (typeof data !== 'object' || data === null || !('errors' in data)) {
        return undefined
    }
    const errors = data.errors
    const first: unknown = Array.isArray(errors) ? errors[0] : undefined
    if (typeof first !== 'object' || first === null || !('message' in first)) {
        return undefined
    }
    return typeof first.message === 'string' && first.message !== '' ? first.message : undefined
}

/** Signs an address up for the newsletter. It never throws. */
export async function signUp(email: string, fetcher: typeof fetch = fetch): Promise<SignupResult> {
    const address = email.trim()
    if (!address.includes('@')) {
        return { kind: 'invalid' }
    }
    try {
        const token = await fetcher(`${MEMBERS_SITE}/members/api/integrity-token/`, {
            method: 'GET',
            headers: { 'app-pragma': 'no-cache', 'x-ghost-version': '6.0' },
            signal: AbortSignal.timeout(TIME_LIMIT)
        })
        if (!token.ok) {
            return { kind: 'failed' }
        }
        const integrityToken = await token.text()
        const answer = await fetcher(`${MEMBERS_SITE}/members/api/send-magic-link`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ email: address, emailType: 'subscribe', integrityToken }),
            signal: AbortSignal.timeout(TIME_LIMIT)
        })
        // The service answers 201 when it sent the mail.
        if (answer.status === 201) {
            return { kind: 'sent' }
        }
        const message = await messageOf(answer)
        if (message !== undefined && /\balready\b/iu.test(message)) {
            return { kind: 'already' }
        }
        return { kind: 'refused', message: message ?? REFUSED_MESSAGE }
    } catch {
        return { kind: 'failed' }
    }
}
