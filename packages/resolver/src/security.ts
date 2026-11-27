// The usual security headers of the site (SEC-01 of the spec, issue 79). The
// handler gives them to every answer, and the deployment gives them to the
// files that the host serves without the Worker (the `_headers` file).

/**
 * The headers of every answer. HSTS has no `includeSubDomains` and no
 * `preload`: other hosts of the zone exist, which the site does not own.
 * The permissions turn off what the site never uses.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'strict-transport-security': 'max-age=31536000',
    'x-frame-options': 'DENY',
    'permissions-policy': [
        'accelerometer',
        'browsing-topics',
        'camera',
        'display-capture',
        'geolocation',
        'gyroscope',
        'magnetometer',
        'microphone',
        'midi',
        'payment',
        'usb'
    ]
        .map((feature) => `${feature}=()`)
        .join(', ')
}

/**
 * The file of the output of the build with the Content Security Policy of its
 * pages (`pagePolicy()` of the site): one line, with the hashes of the inline
 * scripts and styles of the pages.
 */
export const PAGE_POLICY_FILE = '-/page-policy.txt'

/**
 * The policy of a page of a release that has no policy file (a release of
 * an older build): it refuses frames and plugins, and blocks nothing that
 * such a page loads.
 */
export const FRAME_ONLY_POLICY = "frame-ancestors 'none'; object-src 'none'; base-uri 'none'"

/**
 * The policy of the server error page, which the build keeps without a
 * script and without a file of the release (NAV-20): its style is inline.
 */
export const SCRIPTLESS_PAGE_POLICY =
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; " +
    "form-action 'self'; base-uri 'none'; frame-ancestors 'none'"

/** The policy of a text of the site that is not a page: it runs and loads nothing. */
export const FILE_POLICY = "default-src 'none'; frame-ancestors 'none'; sandbox"

/**
 * The policy of a policy file as a header value.
 *
 * @throws when the text is not one line of a policy that refuses frames
 */
export function pagePolicyFrom(text: string): string {
    const policy = text.trim()
    // A header value has no control character; a line break would end it.
    // eslint-disable-next-line no-control-regex
    if (policy === '' || /[\u0000-\u001f\u007f]/u.test(policy)) {
        throw new Error(`${PAGE_POLICY_FILE} is not one line`)
    }
    if (!policy.split(';').some((part) => part.trim() === "frame-ancestors 'none'")) {
        throw new Error(`${PAGE_POLICY_FILE} does not refuse frames`)
    }
    return policy
}

/** Adds the security headers to an answer, without changing a header that it has. */
export function secured(response: Response): Response {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        if (!response.headers.has(name)) {
            response.headers.set(name, value)
        }
    }
    return response
}
