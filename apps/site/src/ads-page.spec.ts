import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    FIXTURE_NOTE_TYPES,
    FIXTURE_STORE_CATALOG,
    copyFixtureVault,
    makeContentStoreCopy,
    makeTestStores,
    type TestStores
} from '@dsebastien-website/testing'
import { fileNoteTypes, nodeDevice } from '../../plugin/src/publishing/node/device.ts'
import { plan, publish } from '../../plugin/src/publishing/tool.ts'
import { ctaScript } from './ads/cta.ts'

// The ads of the built fixture site (issue 56, SEAM-05): a note about a topic
// of a product of the recorded store catalog ends with an ad for it (AD-01);
// one word of a title matches no product (AD-02); each link carries the
// properties of `cta_clicked` (AN-02); the ad is complete in the HTML, with no
// image, so it moves nothing (AD-09, AD-10).
const SITE = fileURLToPath(new URL('..', import.meta.url))

const NOTES = [
    '10 Garden/Drip irrigation.md',
    '10 Garden/Rain barrel.md',
    '10 Garden/Frost dates explained.md'
]

let stores: TestStores | undefined
let outDir: string | undefined
let exitCode = -1
const pages = new Map<string, string>()
const broken = { exitCode: -1, output: '', pages: new Map<string, string>() }

/** Builds the site of a content store with a store catalog, and reads its note pages by their paths. */
async function build(
    contentStore: string,
    folder: string,
    catalog: string
): Promise<{ exitCode: number; output: string; pages: Map<string, string> }> {
    const child = Bun.spawn(['bun', 'run', 'build', '--outDir', join(folder, 'dist')], {
        cwd: SITE,
        env: {
            ...process.env,
            CONTENT_STORE: contentStore,
            STORE_CATALOG: catalog,
            STORE_CATALOG_COPY: join(folder, 'store-catalog.json')
        },
        stdout: 'pipe',
        stderr: 'pipe'
    })
    const [output, errors, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited
    ])
    const found = new Map<string, string>()
    if (code === 0) {
        const notes = join(folder, 'dist', '-', 'note')
        for (const file of await readdir(notes)) {
            const html = await Bun.file(join(notes, file)).text()
            const canonical = /<link rel="canonical" href="https:\/\/[^/]+([^"]+)"/u.exec(html)?.[1]
            if (canonical !== undefined) {
                found.set(decodeURIComponent(canonical.replaceAll('+', ' ')), html)
            }
        }
    }
    return { exitCode: code, output: output + errors, pages: found }
}

beforeAll(async () => {
    stores = await makeTestStores()
    const vault = await copyFixtureVault(stores)
    const contentStore = await makeContentStoreCopy(stores)
    const device = nodeDevice({
        noteTypes: fileNoteTypes(FIXTURE_NOTE_TYPES),
        vault,
        contentStore,
        attachmentStorage: stores.attachmentStorage
    })
    const planned = await plan(device, { include: NOTES })
    await publish(device, planned.id, {
        time: '2031-04-01T08:00:00Z',
        device: 'garden-shed',
        face: 'plugin'
    })
    // The output folders are inside the site, in a folder that git ignores.
    const cache = join(SITE, '.cache')
    await mkdir(cache, { recursive: true })
    outDir = await mkdtemp(join(cache, 'ads-page-spec-'))
    const good = await build(contentStore, join(outDir, 'good'), FIXTURE_STORE_CATALOG)
    exitCode = good.exitCode
    for (const [path, html] of good.pages) {
        pages.set(path, html)
    }
    // A catalog that breaks the schema, with no valid copy before it.
    const catalog = JSON.parse(await readFile(FIXTURE_STORE_CATALOG, 'utf8')) as {
        products: Record<string, unknown>[]
    }
    delete catalog.products[0]?.['href']
    const brokenFile = join(outDir, 'broken-catalog.json')
    await writeFile(brokenFile, JSON.stringify(catalog))
    Object.assign(broken, await build(contentStore, join(outDir, 'broken'), brokenFile))
}, 300_000)

afterAll(async () => {
    if (outDir !== undefined) {
        await rm(outDir, { recursive: true, force: true })
    }
    await stores?.remove()
})

function pageOf(path: string): string {
    const html = pages.get(path)
    if (html === undefined) {
        throw new Error(`the build made no page for ${path}`)
    }
    return html
}

/** The ad of a page, or `undefined` when it has none. */
function adOf(html: string): string | undefined {
    return /<aside class="note-ad"[\s\S]*?<\/aside>/u.exec(html)?.[0]
}

function productsOf(ad: string | undefined): string[] {
    return [...(ad ?? '').matchAll(/data-cta-product="([^"]+)"/gu)].map((match) => match[1] ?? '')
}

describe('the ads of the built site', () => {
    test('the build completes', () => {
        expect(exitCode).toBe(0)
    })

    test('a note about a topic of a product ends with an ad for it, from the store catalog', () => {
        const html = pageOf('/10 Garden/Drip irrigation')
        const ad = adOf(html)
        expect(productsOf(ad)).toEqual(['water-wise-garden', 'rain-garden-kit'])
        expect(ad).toContain('Water-Wise Garden Course')
        expect(ad).toContain('Water less and grow more')
        // At the end of the note: after its text.
        expect(html.indexOf('data-ad ')).toBeGreaterThan(html.indexOf('data-note-body'))
    })

    test('one word of a title no longer matches a product', () => {
        // "Rain barrel" holds the word "barrel", a tag of the barrel workshop.
        expect(productsOf(adOf(pageOf('/10 Garden/Rain barrel')))).not.toContain('barrel-workshop')
    })

    test('each link of the ad carries the properties of cta_clicked, and the page runs the script', () => {
        const html = pageOf('/10 Garden/Drip irrigation')
        expect(adOf(html)).toContain(
            '<a class="card-link ad-card" href="https://store.example/product/water-wise-garden" target="_blank" rel="noopener" data-cta-product="water-wise-garden" data-cta-position="end" data-cta-slot="0" data-cta-page="10 Garden/Drip irrigation.md">'
        )
        expect(adOf(html)).toContain('data-cta-slot="1"')
        expect(html).toContain(`<script>${ctaScript}</script>`)
    })

    test('the ad is complete in the HTML and holds no image and no script, so it moves nothing', () => {
        const ad = adOf(pageOf('/10 Garden/Drip irrigation')) ?? ''
        expect(ad).not.toMatch(/<(img|picture|iframe|script|video)\b/u)
    })

    test('a note that matches no product has no ad and no script of the ads', () => {
        const html = pageOf('/10 Garden/Frost dates explained')
        expect(adOf(html)).toBeUndefined()
        expect(html).not.toContain('data-cta-product')
        expect(html).not.toContain(ctaScript)
    })
})

describe('the build with a store catalog that breaks its schema', () => {
    test('completes, says why, and ships no ad', () => {
        expect(broken.exitCode).toBe(0)
        expect(broken.output).toContain('products[0].href')
        expect(broken.output).toContain(
            'no valid copy of the store catalog exists: the build shows no product ad'
        )
        const html = broken.pages.get('/10 Garden/Drip irrigation') ?? ''
        expect(html).toContain('data-note-body')
        expect(html).not.toContain('data-cta-product')
    })
})
