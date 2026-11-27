import { chromium, type Browser } from 'playwright-core'

// The browser seam of the tests (issue 57): `playwright-core` drives the Chrome
// that is installed on the machine (`channel: 'chrome'`). No browser is
// downloaded: the runner of the CI has Chrome, and so has the machine of the
// author. Without Chrome the test fails with a message that says so; it never
// passes in silence.

/** Starts the installed Chrome without a window. It throws a clear error when Chrome is missing. */
export async function launchChrome(): Promise<Browser> {
    try {
        return await chromium.launch({ channel: 'chrome', headless: true })
    } catch (error) {
        const reason = error instanceof Error ? error.message.split('\n')[0] : String(error)
        throw new Error(
            `the browser tests need Google Chrome installed on this machine (${reason ?? ''})`,
            { cause: error }
        )
    }
}
