import { fileURLToPath } from 'node:url'

/**
 * The analytics settings of the builds of the tests (AN-01): the proxy of the
 * current site, which is public, and a site id that is clearly invented. A
 * browser test intercepts every event: none reaches the network.
 */
export const TEST_ANALYTICS = {
    siteId: 'analytics-test.invalid',
    script: 'https://blue-bar-dsebastien-19fd.developassion.workers.dev/content/script.manual.js',
    event: 'https://blue-bar-dsebastien-19fd.developassion.workers.dev/api/v1/event'
} as const

/**
 * The pinned copy of the script of the proxy (`script.manual.js`) that the
 * browser tests serve in its place, so that no test reaches the proxy. Its
 * first line names its source and the day it was read; `bun run
 * analytics:script` compares it with the live script.
 */
export const PINNED_ANALYTICS_SCRIPT = fileURLToPath(
    new URL('../fixtures/plausible-script.manual.js', import.meta.url)
)
