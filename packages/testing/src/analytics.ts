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
