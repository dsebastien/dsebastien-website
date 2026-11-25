import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { DEPLOYMENT_RECORD_FILE } from '@dsebastien-website/resolver'
import { deployToken, targetFrom } from '../apps/site/worker/deployment.ts'
import { LIVE_CHECKS, readHostRecord, revertRelease } from '../apps/site/worker/release.ts'

// The revert of a release (issue 32, BUILD-07): the host goes back to the
// Worker version before the live one, with `wrangler rollback`, and the
// command prints which commit of the content store is live then, by the
// deployment record that the host gives.
//
//     bun run deploy:revert --target <file>
//
// The token comes from `NOTES_DEPLOY_CLOUDFLARE_API_TOKEN`, else
// `CLOUDFLARE_API_TOKEN`, as for `bun run deploy`. A revert puts back the
// pages of the release before, not the attachments that the deployment after
// it deleted from the object storage (issue 120).

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const WRANGLER = join(ROOT, 'apps', 'site', 'node_modules', '.bin', 'wrangler')

const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { target: { type: 'string' } },
    strict: true
})

async function main(): Promise<void> {
    if (values.target === undefined) {
        throw new Error('--target <file> is required')
    }
    const target = targetFrom(JSON.parse(await readFile(resolve(values.target), 'utf8')))
    const token = deployToken(process.env)
    if (token === undefined) {
        throw new Error('NOTES_DEPLOY_CLOUDFLARE_API_TOKEN and CLOUDFLARE_API_TOKEN are not set')
    }
    const site = `https://${target.host}/`
    const record = new URL(DEPLOYMENT_RECORD_FILE, site)
    const result = await revertRelease({
        rollback: async () => {
            // With no version, wrangler goes back to the version before the live one.
            const child = Bun.spawn(
                [
                    WRANGLER,
                    'rollback',
                    '--name',
                    target.worker,
                    '--message',
                    'bun run deploy:revert',
                    '--yes'
                ],
                {
                    cwd: ROOT,
                    env: {
                        ...process.env,
                        CLOUDFLARE_API_TOKEN: token,
                        CLOUDFLARE_ACCOUNT_ID: target.accountId
                    },
                    stdio: ['inherit', 'inherit', 'inherit']
                }
            )
            const code = await child.exited
            if (code !== 0) {
                throw new Error(`wrangler rollback ended with the code ${String(code)}`)
            }
        },
        live: { ...LIVE_CHECKS, read: () => readHostRecord(site) },
        wait: (milliseconds) => Bun.sleep(milliseconds)
    })
    const name = (revision: string | null | undefined): string =>
        revision === undefined ? 'unknown' : (revision ?? 'none (an output built elsewhere)')
    process.stdout.write(
        `before the revert: content ${name(result.before?.contentRevision)}, built ${result.before?.builtAt ?? 'unknown'}\n`
    )
    process.stdout.write(
        `live now: content ${name(result.after?.contentRevision)}, built ${result.after?.builtAt ?? 'unknown'}\n`
    )
    if (!result.changed) {
        console.warn(`the host still gives the record before the revert: check ${record.href}`)
    }
}

await main()
