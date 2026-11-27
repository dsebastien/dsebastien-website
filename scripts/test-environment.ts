// The preload of every test run (`bunfig.toml`). A build of the site that a
// test starts inherits this environment: its checks run in the strict mode,
// where a warning of NAV-07 or of a link to no page stops the build too
// (`apps/site/src/site-checks.ts`, decision R65). A build of real notes warns.
// The name is SITE_CHECKS_MODE of site-checks.ts, which this preload does not
// import: a test there checks that both say the same.
process.env['SITE_CHECKS'] = 'strict'

// A build that a test starts has no analytics (AN-01), also when the shell
// names settings: a test that needs them gives its own invented ones. The name
// is ANALYTICS_VARIABLE of apps/site/src/analytics/analytics.ts.
process.env['SITE_ANALYTICS'] = ''

// Every device of a test has the seal key of the tests (R104), built at run
// time: `testSealKey()` of packages/testing, the same as the Rust tests. A
// test of a missing key gives its device another source. The name is
// SEAL_KEY_VARIABLE of apps/plugin/src/publishing/seal.ts.
process.env['VAULT_PUBLISH_SEAL_KEY'] = '5e'.repeat(32)
