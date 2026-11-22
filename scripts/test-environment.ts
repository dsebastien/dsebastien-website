// The preload of every test run (`bunfig.toml`). A build of the site that a
// test starts inherits this environment: its checks run in the strict mode,
// where a warning of NAV-07 or of a link to no page stops the build too
// (`apps/site/src/site-checks.ts`, decision R65). A build of real notes warns.
process.env['SITE_CHECKS'] = 'strict'
