import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

// Guards of the local development container (Dockerfile, compose.yaml).
// The container itself is checked by hand: CI does not start it.
const ROOT = fileURLToPath(new URL('..', import.meta.url))

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readText(path: string): Promise<string> {
    return await Bun.file(`${ROOT}${path}`).text()
}

/** The tag of the image `name` in the `FROM` lines of the Dockerfile. */
async function readImageTag(name: string): Promise<string | undefined> {
    const dockerfile = await readText('Dockerfile')
    const pattern = new RegExp(`^FROM ${name}:(\\S+)`, 'm')
    return pattern.exec(dockerfile)?.[1]
}

describe('local development container', () => {
    test('uses the Node version of .nvmrc', async () => {
        const version = (await readText('.nvmrc')).trim()
        expect(await readImageTag('node')).toBe(`${version}-bookworm-slim`)
    })

    test('uses the Bun version of package.json', async () => {
        const manifest: unknown = JSON.parse(await readText('package.json'))
        const packageManager = isRecord(manifest) ? manifest['packageManager'] : undefined
        if (typeof packageManager !== 'string') {
            throw new Error('package.json has no packageManager')
        }
        expect(await readImageTag('oven/bun')).toBe(packageManager.replace('bun@', ''))
    })

    test('sends no file of the clone to the image build', async () => {
        // The image needs no file of the repository: the source is mounted when
        // the container runs. An empty build context can never hold a private file.
        const rules = (await readText('.dockerignore'))
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '' && !line.startsWith('#'))
        expect(rules).toEqual(['*'])
    })

    test('publishes the dev server on this machine only', async () => {
        const compose: unknown = Bun.YAML.parse(await readText('compose.yaml'))
        const services = isRecord(compose) ? compose['services'] : undefined
        const site = isRecord(services) ? services['site'] : undefined
        const ports = isRecord(site) ? site['ports'] : undefined
        if (!Array.isArray(ports) || ports.length === 0) {
            throw new Error('compose.yaml publishes no port for the site')
        }
        const open = ports.filter(
            (port) => typeof port !== 'string' || !port.startsWith('127.0.0.1:')
        )
        expect(open).toEqual([])
    })
})
