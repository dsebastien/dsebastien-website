import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Acceptance criterion of issue 16: an empty Astro and Tailwind site builds.
// The test runs the build script of the site and reads the files of the output.
const SITE = fileURLToPath(new URL('..', import.meta.url))

let outDir: string | undefined
let exitCode = -1

function outputPath(): string {
    if (outDir === undefined) {
        throw new Error('the output folder does not exist')
    }
    return outDir
}

async function readOutput(path: string): Promise<string> {
    return await Bun.file(join(outputPath(), path)).text()
}

async function readStylesheets(): Promise<string> {
    const files = await readdir(outputPath(), { recursive: true })
    const sheets = files.filter((file) => file.endsWith('.css'))
    const texts = await Promise.all(sheets.map((sheet) => readOutput(sheet)))
    return texts.join('\n')
}

beforeAll(async () => {
    // The output folder is inside the site, in a folder that git ignores: Astro
    // moves files into it, and a move to another file system fails.
    const cache = join(SITE, '.cache')
    await mkdir(cache, { recursive: true })
    outDir = await mkdtemp(join(cache, 'build-spec-'))
    const child = Bun.spawn(['bun', 'run', 'build', '--outDir', outDir], {
        cwd: SITE,
        stdout: 'ignore',
        stderr: 'ignore'
    })
    exitCode = await child.exited
}, 180_000)

afterAll(async () => {
    // Remove only a folder that this test made.
    if (outDir !== undefined) {
        await rm(outDir, { recursive: true, force: true })
    }
})

describe('build of the empty site', () => {
    test('completes', () => {
        expect(exitCode).toBe(0)
    })

    test('writes the home page as plain HTML', async () => {
        const html = await readOutput('index.html')
        expect(html).toContain('<html lang="en"')
        expect(html).toContain('<h1')
        expect(html).not.toContain('<script')
    })

    test('compiles the Tailwind classes that the home page uses', async () => {
        const html = await readOutput('index.html')
        expect(html).toContain('class="mx-auto max-w-prose p-8"')
        const css = await readStylesheets()
        expect(css).toContain('.max-w-prose')
    })
})
