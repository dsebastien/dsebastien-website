import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { guardedFetch, isPublicAddress, type ResolvePort } from './guarded-fetch.ts'
import { previewKey, readLinkPreviews } from './previews.ts'

// The requests of the previews reach only the public web (CARD-06): a local
// server stands for the public web on 127.0.0.2 (the tests allow that one
// address), and a "secret" server on 127.0.0.1, at the same port, stands for
// the private network. The secret server must never get a request.

const SITE = fileURLToPath(new URL('../..', import.meta.url))
const NOW = new Date('2031-05-01T08:00:00Z')
const PUBLIC = '127.0.0.2'

let port = 0
let photo = new Uint8Array(0)
const secretAsked: string[] = []
const publicAsked: string[] = []
let publicServer: ReturnType<typeof Bun.serve> | undefined
let secretServer: ReturnType<typeof Bun.serve> | undefined

const page = (head: string): Response =>
    new Response(`<!doctype html><html><head>${head}</head><body>Text</body></html>`, {
        headers: { 'content-type': 'text/html; charset=utf-8' }
    })

beforeAll(async () => {
    photo = new Uint8Array(
        await sharp({
            create: { width: 640, height: 336, channels: 3, background: '#5a8f3c' }
        })
            .png()
            .toBuffer()
    )
    publicServer = Bun.serve({
        hostname: PUBLIC,
        port: 0,
        fetch: (request) => {
            const { pathname } = new URL(request.url)
            publicAsked.push(pathname)
            if (pathname === '/photo.png')
                return new Response(photo, { headers: { 'content-type': 'image/png' } })
            if (pathname === '/good')
                return page(
                    `<meta property="og:image" content="http://garden.test:${String(port)}/photo.png">`
                )
            if (pathname === '/to-secret-image')
                return page(
                    `<meta property="og:image" content="http://127.0.0.1:${String(port)}/secret.png">`
                )
            if (pathname === '/to-secret-name')
                return page(
                    `<meta property="og:image" content="http://secret.test:${String(port)}/secret.png">`
                )
            if (pathname === '/redirect')
                return new Response(null, {
                    status: 302,
                    headers: { location: `http://secret.test:${String(port)}/page` }
                })
            return page('')
        }
    })
    port = publicServer.port ?? 0
    secretServer = Bun.serve({
        hostname: '127.0.0.1',
        port,
        fetch: (request) => {
            secretAsked.push(new URL(request.url).pathname)
            return page(`<meta property="og:image" content="/secret.png">`)
        }
    })
})

afterAll(async () => {
    await publicServer?.stop(true)
    await secretServer?.stop(true)
})

let cache = ''

beforeEach(async () => {
    secretAsked.length = 0
    publicAsked.length = 0
    const parent = join(SITE, '.cache')
    await mkdir(parent, { recursive: true })
    cache = await mkdtemp(join(parent, 'guarded-fetch-spec-'))
})

afterEach(async () => {
    await rm(cache, { recursive: true, force: true })
})

/** The names of the tests: `garden.test` on the public server, `secret.test` on the secret one. */
const names: Record<string, string[]> = {
    'garden.test': [PUBLIC],
    'secret.test': ['127.0.0.1'],
    'metadata.test': ['169.254.169.254'],
    'lan.test': ['192.168.1.10'],
    'mixed.test': [PUBLIC, '10.0.0.7'],
    'mapped.test': ['::ffff:127.0.0.1']
}

const resolve: ResolvePort = async (hostname) =>
    Promise.resolve(
        (names[hostname] ?? []).map((address) => ({
            address,
            family: address.includes(':') ? (6 as const) : (4 as const)
        }))
    )

const isAllowed = (address: string): boolean => address === PUBLIC || isPublicAddress(address)

const init: RequestInit = { redirect: 'manual', headers: { accept: 'text/html' } }

describe('the addresses that a preview may reach (CARD-06)', () => {
    test('the public web, and none of the private, reserved or special ranges', () => {
        for (const address of ['93.184.215.14', '8.8.8.8', '2606:4700::1111', '2a00:1450::1']) {
            expect([address, isPublicAddress(address)]).toEqual([address, true])
        }
        for (const address of [
            '127.0.0.1',
            '127.8.9.10',
            '10.1.2.3',
            '172.16.0.1',
            '172.31.255.255',
            '192.168.0.1',
            '169.254.169.254',
            '100.64.0.1',
            '100.127.255.255',
            '0.0.0.0',
            '0.1.2.3',
            '224.0.0.1',
            '239.255.255.250',
            '255.255.255.255',
            '::',
            '::1',
            'fe80::1',
            'fe80::1%eth0',
            'fc00::1',
            'fd12:3456::1',
            'ff02::1',
            '::ffff:127.0.0.1',
            '::ffff:7f00:1',
            '::ffff:a00:1',
            '::ffff:169.254.169.254',
            '::127.0.0.1',
            '64:ff9b::a00:1',
            '2002:7f00:1::1',
            '2002:c0a8:101::1',
            '2001:db8::1',
            'garden.test',
            ''
        ]) {
            expect([address, isPublicAddress(address)]).toEqual([address, false])
        }
        expect(isPublicAddress('::ffff:8.8.8.8')).toBe(true)
        expect(isPublicAddress('172.15.0.1')).toBe(true)
        expect(isPublicAddress('172.32.0.1')).toBe(true)
        expect(isPublicAddress('100.128.0.1')).toBe(true)
    })

    test('a name that resolves to an allowed address is reached at the checked address', async () => {
        const fetch = guardedFetch({ resolve, isAllowed })
        const response = await fetch(`http://garden.test:${String(port)}/plain`, init)
        expect(response.status).toBe(200)
        expect(await response.text()).toContain('Text')
        expect(publicAsked).toEqual(['/plain'])
        expect(secretAsked).toEqual([])
    })

    test('a loopback, private, link-local or mapped address is refused, as a name or a literal', async () => {
        const fetch = guardedFetch({ resolve, isAllowed })
        for (const host of [
            '127.0.0.1',
            'localhost',
            '0177.0.0.1',
            '2130706433',
            '0x7f.1',
            '[::ffff:127.0.0.1]',
            '[::1]',
            'secret.test',
            'metadata.test',
            'lan.test',
            'mixed.test',
            'mapped.test',
            'unknown.test'
        ]) {
            const asked = fetch(`http://${host}:${String(port)}/`, init)
            expect(asked).rejects.toThrow()
            await asked.catch(() => undefined)
        }
        expect(secretAsked).toEqual([])
        expect(publicAsked).toEqual([])
    })

    test('a name is resolved once per request: a second answer cannot switch the address', async () => {
        let calls = 0
        const rebinding: ResolvePort = async () => {
            calls += 1
            return Promise.resolve([
                { address: calls === 1 ? PUBLIC : '127.0.0.1', family: 4 as const }
            ])
        }
        const fetch = guardedFetch({ resolve: rebinding, isAllowed })
        const response = await fetch(`http://rebind.test:${String(port)}/plain`, init)
        await response.text()
        expect(calls).toBe(1)
        expect(publicAsked).toEqual(['/plain'])
        expect(secretAsked).toEqual([])
    })

    test('a page of the public web cannot lead a preview to the private network', async () => {
        const fetch = guardedFetch({ resolve, isAllowed })
        const targets = ['/to-secret-image', '/to-secret-name', '/redirect', '/good'].map(
            (path) => ({ url: `http://garden.test:${String(port)}${path}`, video: false })
        )
        const previews = await readLinkPreviews(targets, {
            cache,
            fetch,
            now: NOW,
            warn: () => undefined
        })
        const shown = targets.map((target) => previews.get(previewKey(target) ?? ''))
        expect(shown.slice(0, 3)).toEqual([{}, {}, {}])
        expect(shown[3]?.image).toBeDefined()
        expect(secretAsked).toEqual([])
    })
})
