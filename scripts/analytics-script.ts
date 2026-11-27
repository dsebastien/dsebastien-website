// Compares the pinned copy of the script of the analytics proxy, which the
// browser tests serve (`PINNED_ANALYTICS_SCRIPT` of `packages/testing`), with
// the live script, and measures the live one with Brotli against
// `ANALYTICS_SCRIPT_BROTLI`, the size that the budgets of a note page count
// (issue 57, AN-01). It reaches the network, so it is not a test: run it by
// hand, `bun run analytics:script`, and pin the new copy when it changed.

import { PINNED_ANALYTICS_SCRIPT, TEST_ANALYTICS } from '@dsebastien-website/testing'
import { ANALYTICS_SCRIPT_BROTLI, brotliSize } from '../apps/site/src/budgets.ts'

const pinned = await Bun.file(PINNED_ANALYTICS_SCRIPT).text()
// The first line of the copy names its source; the rest is the script.
const pinnedScript = pinned.slice(pinned.indexOf('\n') + 1)
const answer = await fetch(TEST_ANALYTICS.script, { signal: AbortSignal.timeout(10_000) })
if (!answer.ok) {
    console.error(`${TEST_ANALYTICS.script} answered ${String(answer.status)}`)
    process.exit(1)
}
const live = await answer.text()
const size = brotliSize(new TextEncoder().encode(live))
const same = live === pinnedScript
process.stdout.write(
    `pinned copy: ${same ? 'the same as the live script' : 'differs from the live script'}
`
)
process.stdout.write(
    `live script: ${String(size)} bytes with Brotli, the budgets count ${String(ANALYTICS_SCRIPT_BROTLI)}\n`
)
if (!same || size > ANALYTICS_SCRIPT_BROTLI) {
    process.exit(1)
}
