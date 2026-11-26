import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { checkContentCopy, withdrawnAttachmentKeys } from '../apps/site/worker/content-copy.ts'
import { processIsAlive, takeDeployLock } from '../apps/site/worker/deploy-lock.ts'
import { deployToken, releaseImages, targetFrom } from '../apps/site/worker/deployment.ts'
import { attachmentFolder, encodeVariants } from '../apps/site/worker/image-variants.ts'
import { r2Storage } from '../apps/site/worker/r2.ts'
import { makeVariants } from '../apps/site/worker/release.ts'

// The warm-up of the image variants (issue 87, R92): it makes every variant
// of the images of the published notes that the object storage of a target
// lacks, and uploads it, with no build and no deployment. A deployment makes
// the missing variants too, but a takedown makes none, so run this once
// before the first deployment after the variants came (the first one would
// encode every image of the site), and after a change of their generation.
//
//     bun run variants --target <file> --content-store <folder> --attachments <folder>
//
// It takes the lock of the deployments of the target, and reads the copy of
// the content store clean and at the `main` of the content store, as a
// deployment does. The images under a guard (`withdrawn.json`) get no
// variant. A variant that it cannot make is a warning that names its image:
// its pages give the file of the image. It deletes nothing: the next
// deployment cleans the object storage. The token is the one of a
// deployment.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
        'target': { type: 'string' },
        'content-store': { type: 'string' },
        'attachments': { type: 'string' }
    },
    strict: true
})

async function folder(option: string, path: string | undefined): Promise<string> {
    if (path === undefined) {
        throw new Error(`--${option} <folder> is required`)
    }
    const full = resolve(path)
    if (!(await stat(full).catch(() => undefined))?.isDirectory()) {
        throw new Error(`${full} is not a folder`)
    }
    return full
}

async function main(): Promise<number> {
    if (values.target === undefined) {
        throw new Error('--target <file> is required')
    }
    const target = targetFrom(JSON.parse(await readFile(resolve(values.target), 'utf8')))
    const store = await folder('content-store', values['content-store'])
    const attachments = await folder('attachments', values.attachments)
    const token = deployToken(process.env)
    if (token === undefined) {
        throw new Error('NOTES_DEPLOY_CLOUDFLARE_API_TOKEN and CLOUDFLARE_API_TOKEN are not set')
    }
    const lock = await takeDeployLock(join(ROOT, '.cache', 'deploy', target.worker, 'lock'), {
        pid: process.pid,
        now: () => new Date(),
        isAlive: processIsAlive
    })
    try {
        if (lock.warning !== undefined) {
            console.warn(lock.warning)
        }
        await checkContentCopy(store)
        const withdrawn = new Set(await withdrawnAttachmentKeys(store))
        const images = (await releaseImages(store)).filter((image) => !withdrawn.has(image.key))
        const storage = r2Storage({ accountId: target.accountId, bucket: target.bucket, token })
        const result = await makeVariants(
            {
                attachments: attachmentFolder(attachments),
                encode: encodeVariants,
                log: (line) => {
                    console.error(line)
                }
            },
            images,
            storage,
            new Set(await storage.list())
        )
        for (const warning of result.warnings) {
            console.warn(`warning: ${warning}`)
        }
        console.error(
            `${String(images.length)} images with variants; ${String(result.uploaded)} variants uploaded, ${String(result.warnings.length)} warning(s)`
        )
        return 0
    } finally {
        await lock.release()
    }
}

try {
    process.exitCode = await main()
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
}
