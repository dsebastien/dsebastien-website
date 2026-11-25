import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AttachmentStorage } from '../../plugin/src/publishing/ports.ts'
import { deployRelease, resultLine, type DeployResult, type DeployRun } from './release.ts'

// The run of a deployment (issue 32, BUILD-07, BUILD-08, STORE-08, PUB-42):
// the attachments go to the object storage before the build, the build
// gets its deployment record and its limits, the release goes live, and the
// storage loses the files that no published note uses. The object storage,
// the build, wrangler and the host are fakes: nothing reaches a host.

const CACHE = fileURLToPath(new URL('../../../.cache', import.meta.url))
const CONTENT = 'c'.repeat(40)
const SITE = 'd'.repeat(40)
const TIME = new Date('2031-04-01T08:00:00.250Z')

/** The bytes of an invented attachment, and its key. */
function file(text: string): { key: string; bytes: Uint8Array } {
    const bytes = new TextEncoder().encode(text)
    return { key: createHash('sha256').update(bytes).digest('hex'), bytes }
}

const PHOTO = file('photo')
const PLAN = file('plan')
const OLD = file('old')

let folders: string[] = []

afterEach(async () => {
    // Remove only the folders that this test made.
    for (const folder of folders) {
        await rm(folder, { recursive: true, force: true })
    }
    folders = []
})

/** An object storage in memory that writes what it does into the events. */
function memoryStorage(
    names: string[],
    events: string[]
): AttachmentStorage & { names: Set<string> } {
    const stored = new Set(names)
    return {
        names: stored,
        list: () => {
            events.push('list')
            return Promise.resolve([...stored])
        },
        put: (key) => {
            events.push(`put ${key}`)
            stored.add(key)
            return Promise.resolve()
        },
        remove: (name) => {
            events.push(`remove ${name}`)
            return Promise.resolve(stored.delete(name))
        }
    }
}

interface Fixture {
    readonly run: DeployRun
    readonly events: string[]
    readonly storage: AttachmentStorage & { names: Set<string> }
    /** The output of the fake build, once it ran. */
    dist(): string
}

/**
 * A run with an object storage that holds these names, an attachment folder
 * with these files, and a build that writes a small output.
 */
function fixture(
    options: {
        stored?: string[]
        folder?: { key: string; bytes: Uint8Array }[]
        used?: string[]
        overrides?: Partial<DeployRun>
    } = {}
): Fixture {
    const events: string[] = []
    const storage = memoryStorage(options.stored ?? [], events)
    const local = new Map((options.folder ?? []).map((item) => [item.key, item.bytes]))
    let dist: string | undefined
    let deployed: unknown
    const run: DeployRun = {
        url: 'https://preview.notes.example/',
        contentRevision: CONTENT,
        siteRevision: SITE,
        now: () => TIME,
        usedKeys: options.used ?? [PHOTO.key, PLAN.key],
        storage,
        attachments: {
            exists: (key) => Promise.resolve(local.has(key)),
            read: (key) => {
                const bytes = local.get(key)
                return bytes === undefined
                    ? Promise.reject(new Error(`no file ${key}`))
                    : Promise.resolve(bytes)
            }
        },
        takedown: false,
        headers: '/*\n  X-Robots-Tag: noindex\n',
        build: async () => {
            events.push('build')
            await mkdir(CACHE, { recursive: true })
            dist = await mkdtemp(join(CACHE, 'release-spec-'))
            folders.push(dist)
            await mkdir(join(dist, '-'))
            await writeFile(join(dist, '-', 'resolver-map.json'), '{}')
            await writeFile(join(dist, 'index.html'), 'home')
            return dist
        },
        limits: { files: 10, fileSize: 1000 },
        deploy: async (output) => {
            events.push('deploy')
            deployed = JSON.parse(await readFile(join(output, '-', 'deployment.json'), 'utf8'))
        },
        live: {
            read: () => {
                events.push('live?')
                return Promise.resolve(deployed)
            },
            checks: 3,
            pause: 1000
        },
        wait: (milliseconds) => {
            events.push(`wait ${String(milliseconds)}`)
            return Promise.resolve()
        },
        log: () => undefined,
        ...options.overrides
    }
    return {
        run,
        events,
        storage,
        dist: () => {
            if (dist === undefined) {
                throw new Error('the build did not run')
            }
            return dist
        }
    }
}

const OK: Omit<DeployResult, 'uploaded' | 'deleted' | 'warnings'> = {
    build: 'ok',
    deploy: 'ok',
    live: true,
    url: 'https://preview.notes.example/',
    contentRevision: CONTENT,
    error: null
}

describe('a deployment', () => {
    test('uploads the used files that the storage lacks before the build, then cleans the storage once live', async () => {
        const site = fixture({ stored: [PHOTO.key, OLD.key], folder: [PHOTO, PLAN] })
        const result = await deployRelease(site.run)
        expect(result).toEqual({ ...OK, uploaded: 1, deleted: 1, warnings: [] })
        expect(site.events).toEqual([
            'list',
            `put ${PLAN.key}`,
            'build',
            'deploy',
            'live?',
            `remove ${OLD.key}`
        ])
        expect([...site.storage.names].sort()).toEqual([PHOTO.key, PLAN.key].sort())
    })

    test('writes the deployment record and the headers file into the output', async () => {
        const site = fixture({ stored: [PHOTO.key, PLAN.key] })
        await deployRelease(site.run)
        expect(
            JSON.parse(await readFile(join(site.dist(), '-', 'deployment.json'), 'utf8'))
        ).toEqual({ contentRevision: CONTENT, siteRevision: SITE, builtAt: '2031-04-01T08:00:00Z' })
        expect(await readFile(join(site.dist(), '_headers'), 'utf8')).toBe(
            '/*\n  X-Robots-Tag: noindex\n'
        )
    })

    test('stops before the build when a used file is in neither place, and names its key', async () => {
        const site = fixture({ stored: [OLD.key], folder: [PHOTO] })
        const result = await deployRelease(site.run)
        expect(result).toMatchObject({ build: 'skipped', deploy: 'skipped', live: false })
        expect(result.uploaded).toBe(0)
        expect(result.deleted).toBe(0)
        expect(result.error).toContain(PLAN.key)
        expect(result.error).not.toContain(PHOTO.key)
        expect(site.events).toEqual(['list'])
    })

    // A file of the folder must be the file of its key: a wrong one would be
    // given under the hashed URL of another for a year.
    test('stops before the build when a file of the folder is not the file of its key', async () => {
        const site = fixture({ folder: [PHOTO, { key: PLAN.key, bytes: OLD.bytes }] })
        const result = await deployRelease(site.run)
        expect(result.build).toBe('skipped')
        expect(result.error).toContain(PLAN.key)
        expect(site.events).not.toContain(`put ${PLAN.key}`)
        expect(site.events).not.toContain('build')
    })

    // A wrong folder (an empty `--dist` is the working folder) gets no file of the deployment.
    test('writes nothing into a folder that is not the output of a build', async () => {
        await mkdir(CACHE, { recursive: true })
        const folder = await mkdtemp(join(CACHE, 'release-spec-'))
        folders.push(folder)
        await writeFile(join(folder, 'package.json'), '{}')
        const site = fixture({
            stored: [PHOTO.key, PLAN.key],
            overrides: { build: () => Promise.resolve(folder) }
        })
        const result = await deployRelease(site.run)
        expect(result).toMatchObject({ build: 'failed', deploy: 'skipped' })
        expect(result.error).toContain('resolver map')
        expect(await readdir(folder)).toEqual(['package.json'])
    })

    // BUILD-08.
    test('stops a release above a limit of the host before the deployment, and deletes nothing', async () => {
        const site = fixture({
            stored: [PHOTO.key, PLAN.key, OLD.key],
            overrides: { limits: { files: 2, fileSize: 1000 } }
        })
        const result = await deployRelease(site.run)
        expect(result).toMatchObject({
            build: 'failed',
            deploy: 'skipped',
            live: false,
            deleted: 0
        })
        expect(result.error).toContain('the host takes 2 at most')
        expect(site.events).toEqual(['list', 'build'])
    })

    test('deletes nothing when the build fails', async () => {
        const site = fixture({
            stored: [PHOTO.key, PLAN.key, OLD.key],
            overrides: { build: () => Promise.reject(new Error('the build ended with the code 1')) }
        })
        const result = await deployRelease(site.run)
        expect(result).toMatchObject({ build: 'failed', deploy: 'skipped', deleted: 0 })
        expect(result.error).toContain('the build ended')
        expect(site.storage.names.has(OLD.key)).toBe(true)
    })

    test('deletes nothing when the deployment fails', async () => {
        const site = fixture({
            stored: [PHOTO.key, PLAN.key, OLD.key],
            overrides: { deploy: () => Promise.reject(new Error('wrangler ended with the code 1')) }
        })
        const result = await deployRelease(site.run)
        expect(result).toMatchObject({ build: 'ok', deploy: 'failed', live: false, deleted: 0 })
        expect(site.storage.names.has(OLD.key)).toBe(true)
    })

    // Decision of the author 3: the files of a takedown leave the storage also when the release fails.
    test.each([
        ['build', { build: () => Promise.reject(new Error('the build failed')) }],
        ['deployment', { deploy: () => Promise.reject(new Error('wrangler failed')) }]
    ])(
        'after a takedown, deletes the files that no note uses when the %s fails, then fails',
        async (_step, failure) => {
            const site = fixture({
                stored: [PHOTO.key, PLAN.key, OLD.key],
                overrides: { takedown: true, ...failure }
            })
            const result = await deployRelease(site.run)
            expect(result.deleted).toBe(1)
            expect(result.live).toBe(false)
            expect(result.error).toContain('failed')
            expect(site.storage.names.has(OLD.key)).toBe(false)
        }
    )

    test('after a takedown, deletes the files that no note uses also when a used file is missing', async () => {
        const site = fixture({ stored: [PHOTO.key, OLD.key], overrides: { takedown: true } })
        const result = await deployRelease(site.run)
        expect(result).toMatchObject({ build: 'skipped', deleted: 1 })
        expect(result.error).toContain(PLAN.key)
        expect(site.events).toEqual(['list', `remove ${OLD.key}`])
    })

    test('waits a bounded time for the host to give its record, then warns and still succeeds', async () => {
        const site = fixture({
            stored: [PHOTO.key, PLAN.key],
            overrides: {
                live: {
                    read: () => Promise.resolve({ contentRevision: 'e'.repeat(40) }),
                    checks: 3,
                    pause: 1000
                }
            }
        })
        const result = await deployRelease(site.run)
        expect(result).toMatchObject({ build: 'ok', deploy: 'ok', live: false, error: null })
        expect(result.warnings.join('\n')).toContain(
            'https://preview.notes.example/-/deployment.json'
        )
        expect(site.events.filter((event) => event.startsWith('wait'))).toEqual([
            'wait 1000',
            'wait 1000'
        ])
    })

    test('is live at the check where the host gives its record, after an old record and a failure', async () => {
        const site = fixture({ stored: [PHOTO.key, PLAN.key] })
        const read = site.run.live?.read
        let calls = 0
        const result = await deployRelease({
            ...site.run,
            live: {
                read: () => {
                    calls += 1
                    if (calls === 1) {
                        return Promise.resolve({ contentRevision: 'e'.repeat(40) })
                    }
                    if (calls === 2 || read === undefined) {
                        return Promise.reject(new Error('offline'))
                    }
                    return read()
                },
                checks: 5,
                pause: 1000
            }
        })
        expect(result.live).toBe(true)
        expect(result.warnings).toEqual([])
        expect(calls).toBe(3)
    })

    test('leaves a name of the storage that is not a key, with a warning', async () => {
        const site = fixture({ stored: [PHOTO.key, PLAN.key, 'notes/readme.txt'] })
        const result = await deployRelease(site.run)
        expect(result.deleted).toBe(0)
        expect(result.warnings).toEqual([
            'the attachment storage has a file that is not a key, left as it is: notes/readme.txt'
        ])
        expect(site.storage.names.has('notes/readme.txt')).toBe(true)
    })

    test('warns when the cleanup fails after a deployment that succeeded', async () => {
        const site = fixture({ stored: [PHOTO.key, PLAN.key, OLD.key] })
        const result = await deployRelease({
            ...site.run,
            storage: { ...site.storage, remove: () => Promise.reject(new Error('refused')) }
        })
        expect(result).toMatchObject({ deploy: 'ok', live: true, deleted: 0, error: null })
        expect(result.warnings.join('\n')).toContain('refused')
    })

    test('fails when the cleanup of a takedown fails', async () => {
        const site = fixture({ stored: [PHOTO.key, PLAN.key, OLD.key] })
        const result = await deployRelease({
            ...site.run,
            takedown: true,
            storage: { ...site.storage, remove: () => Promise.reject(new Error('refused')) }
        })
        expect(result).toMatchObject({ deploy: 'ok', live: true })
        expect(result.error).toContain('refused')
    })

    test('without an object storage (a dry run), builds and deploys and touches no storage', async () => {
        const site = fixture()
        const { storage: _storage, live: _live, ...run } = site.run
        const result = await deployRelease(run)
        expect(result).toMatchObject({ build: 'ok', deploy: 'ok', live: false, error: null })
        expect(site.events).toEqual(['build', 'deploy'])
    })
})

describe('the result line of a deployment', () => {
    test('is one line of JSON after its mark', () => {
        const line = resultLine({ ...OK, uploaded: 2, deleted: 1, warnings: ['a\nb'] })
        expect(line.startsWith('DEPLOY-RESULT {')).toBe(true)
        expect(line).not.toContain('\n')
        expect(JSON.parse(line.slice('DEPLOY-RESULT '.length))).toEqual({
            ...OK,
            uploaded: 2,
            deleted: 1,
            warnings: ['a\nb']
        })
    })
})
