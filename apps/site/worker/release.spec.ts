import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rejectionOf } from '@dsebastien-website/testing'
import type { AttachmentStorage } from '../../plugin/src/publishing/ports.ts'
import {
    deployRelease,
    readHostRecord,
    resultLine,
    revertRelease,
    stoppedResult,
    type DeployResult,
    type DeployRun,
    type RevertRun
} from './release.ts'

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
        descendsFrom: () => Promise.resolve(true),
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
            checks: 5,
            pause: 1000,
            inARow: 3
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

describe('a deployment that stops before its first step', () => {
    test('says why, with the host when it is known', () => {
        expect(
            stoppedResult(
                new Error('the copy has changes'),
                'https://preview.notes.example/',
                false
            )
        ).toEqual({
            build: 'skipped',
            deploy: 'skipped',
            live: false,
            url: 'https://preview.notes.example/',
            contentRevision: null,
            uploaded: 0,
            deleted: 0,
            warnings: [],
            error: 'the copy has changes'
        })
    })

    // The takedown of the tool says it too: the files of the takedown stay.
    test('after a takedown, warns that a file can still be public', () => {
        expect(
            stoppedResult(new Error('the copy is behind origin/main'), '', true).warnings
        ).toEqual([
            'a file can still be public: the deployment stopped before its first step, so no file of the takedown was deleted'
        ])
    })
})

describe('a deployment', () => {
    test('uploads the used files that the storage lacks before the build, then cleans the storage once live', async () => {
        const site = fixture({ stored: [PHOTO.key, OLD.key], folder: [PHOTO, PLAN] })
        const result = await deployRelease(site.run)
        expect(result).toEqual({ ...OK, uploaded: 1, deleted: 1, warnings: [] })
        expect(site.events).toEqual([
            'live?',
            'list',
            `put ${PLAN.key}`,
            'build',
            'live?',
            'deploy',
            'live?',
            'wait 1000',
            'live?',
            'wait 1000',
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
        ).toEqual({
            contentRevision: CONTENT,
            siteRevision: SITE,
            builtAt: '2031-04-01T08:00:00Z',
            previous: null
        })
        expect(await readFile(join(site.dist(), '_headers'), 'utf8')).toBe(
            '/*\n  X-Robots-Tag: noindex\n'
        )
    })

    test('records the time when the build ended', async () => {
        let time = new Date('2031-04-01T08:00:00Z')
        const site = fixture({ stored: [PHOTO.key, PLAN.key] })
        const build = site.run.build
        await deployRelease({
            ...site.run,
            now: () => time,
            build: async () => {
                const dist = await build()
                time = new Date('2031-04-01T08:04:30Z')
                return dist
            }
        })
        const record: unknown = JSON.parse(
            await readFile(join(site.dist(), '-', 'deployment.json'), 'utf8')
        )
        expect(record).toMatchObject({ builtAt: '2031-04-01T08:04:30Z' })
    })

    test('stops before the build when a used file is in neither place, and names its key', async () => {
        const site = fixture({ stored: [OLD.key], folder: [PHOTO] })
        const result = await deployRelease(site.run)
        expect(result).toMatchObject({ build: 'skipped', deploy: 'skipped', live: false })
        expect(result.uploaded).toBe(0)
        expect(result.deleted).toBe(0)
        expect(result.error).toContain(PLAN.key)
        expect(result.error).not.toContain(PHOTO.key)
        expect(site.events).toEqual(['live?', 'list'])
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

    test('stops before the build when an upload fails, after the uploads that run end, and counts them', async () => {
        const site = fixture({ folder: [PHOTO, PLAN] })
        let running = 0
        const result = await deployRelease({
            ...site.run,
            storage: {
                ...site.storage,
                put: async (key, bytes) => {
                    running += 1
                    if (key === PHOTO.key) {
                        running -= 1
                        throw new Error('the object storage refused to store it')
                    }
                    await Bun.sleep(5)
                    await site.storage.put(key, bytes)
                    running -= 1
                }
            }
        })
        expect(result).toMatchObject({ build: 'skipped', deploy: 'skipped', uploaded: 1 })
        expect(result.error).toContain('refused')
        expect(running).toBe(0)
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
        expect(site.events).toEqual(['live?', 'list', 'build'])
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

    // Decision 4 of the comment of 2026-11-25 on issue 32: the files of a takedown
    // leave the storage also when the release fails.
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

    // Two machines that deploy one target: a newer release can go live during
    // a takedown deploy that fails (issue 125 holds the lock on the host).
    test('after a takedown whose deployment failed, deletes nothing when another release went live meanwhile', async () => {
        const newer = {
            contentRevision: 'e'.repeat(40),
            siteRevision: SITE,
            builtAt: '2031-04-01T09:00:00Z'
        }
        let reads = 0
        const site = fixture({
            stored: [PHOTO.key, PLAN.key, OLD.key],
            overrides: {
                takedown: true,
                deploy: () => Promise.reject(new Error('wrangler failed')),
                live: {
                    read: () => {
                        reads += 1
                        // No release at the start and before the switch; then a newer one.
                        return Promise.resolve(reads <= 2 ? undefined : newer)
                    },
                    checks: 5,
                    pause: 1000,
                    inARow: 3
                }
            }
        })
        const result = await deployRelease(site.run)
        expect(result).toMatchObject({ deploy: 'failed', deleted: 0 })
        expect(site.storage.names.has(OLD.key)).toBe(true)
        expect(result.warnings).toContain(
            'a file can still be public: another release went live during this deployment, from another machine, so no file of the takedown was deleted: deploy again'
        )
    })

    test('after a takedown, deletes the files that no note uses also when a used file is missing', async () => {
        const site = fixture({ stored: [PHOTO.key, OLD.key], overrides: { takedown: true } })
        const result = await deployRelease(site.run)
        expect(result).toMatchObject({ build: 'skipped', deleted: 1 })
        expect(result.error).toContain(PLAN.key)
        // The live record is read again before the cleanup of the failure.
        expect(site.events).toEqual(['live?', 'list', 'live?', `remove ${OLD.key}`])
    })

    test('waits a bounded time for the host to give its record, then warns and still succeeds', async () => {
        const site = fixture({
            stored: [PHOTO.key, PLAN.key],
            overrides: {
                live: {
                    read: () => Promise.resolve(undefined),
                    checks: 3,
                    pause: 1000,
                    inARow: 3
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

    // The release before can still be live: it may use the files that the new one does not.
    test('deletes nothing when the host does not give the record of this build, but after a takedown', async () => {
        const notLive = {
            read: () => Promise.resolve(undefined),
            checks: 2,
            pause: 1000,
            inARow: 3
        }
        const site = fixture({
            stored: [PHOTO.key, PLAN.key, OLD.key],
            overrides: { live: notLive }
        })
        const result = await deployRelease(site.run)
        expect(result).toMatchObject({ deploy: 'ok', live: false, deleted: 0, error: null })
        expect(result.warnings.join('\n')).toContain('no file was deleted')
        expect(site.storage.names.has(OLD.key)).toBe(true)

        const takedown = fixture({
            stored: [PHOTO.key, PLAN.key, OLD.key],
            overrides: { live: notLive, takedown: true }
        })
        const removed = await deployRelease(takedown.run)
        expect(removed).toMatchObject({ deploy: 'ok', live: false, deleted: 1, error: null })
        expect(takedown.storage.names.has(OLD.key)).toBe(false)
    })

    test('counts only the files that the storage still had', async () => {
        const site = fixture({ stored: [PHOTO.key, PLAN.key, OLD.key] })
        const result = await deployRelease({
            ...site.run,
            storage: { ...site.storage, remove: () => Promise.resolve(false) }
        })
        expect(result.deleted).toBe(0)
    })

    // After a switch, the old and the new release answer in turn for some seconds.
    test('is live once the host gives the record of this build three times in a row', async () => {
        const site = fixture({ stored: [PHOTO.key, PLAN.key] })
        const read = site.run.live?.read
        const OLD_RECORD = {
            contentRevision: 'e'.repeat(40),
            siteRevision: SITE,
            builtAt: '2031-03-01T08:00:00Z'
        }
        // The two checks before the deployment, then: old, a failure, new, old, new, new, new.
        const plan = ['none', 'none', 'old', 'fail', 'new', 'old', 'new', 'new', 'new']
        let calls = 0
        const result = await deployRelease({
            ...site.run,
            live: {
                read: () => {
                    const step = plan[calls] ?? 'new'
                    calls += 1
                    if (step === 'fail' || read === undefined) {
                        return Promise.reject(new Error('offline'))
                    }
                    if (step === 'none') {
                        return Promise.resolve(undefined)
                    }
                    return step === 'old' ? Promise.resolve(OLD_RECORD) : read()
                },
                checks: 8,
                pause: 1000,
                inARow: 3
            }
        })
        expect(result.live).toBe(true)
        expect(result.warnings).toEqual([])
        expect(calls).toBe(9)
    })

    test('is not live while the old and the new release answer in turn', async () => {
        const site = fixture({ stored: [PHOTO.key, PLAN.key, OLD.key] })
        const read = site.run.live?.read
        let calls = 0
        const result = await deployRelease({
            ...site.run,
            live: {
                read: () => {
                    calls += 1
                    return calls % 2 === 0 || read === undefined
                        ? Promise.resolve(undefined)
                        : read()
                },
                checks: 6,
                pause: 1000,
                inARow: 3
            }
        })
        expect(result).toMatchObject({ live: false, deleted: 0, error: null })
    })

    test('leaves a name of the storage that is not a key, with a warning', async () => {
        const site = fixture({ stored: [PHOTO.key, PLAN.key, 'notes/readme.txt'] })
        const result = await deployRelease(site.run)
        expect(result.deleted).toBe(0)
        // The name can be a path of the vault: only the count goes into the result.
        expect(result.warnings).toEqual([
            'the attachment storage has 1 file(s) that are not keys, left as they are'
        ])
        expect(site.storage.names.has('notes/readme.txt')).toBe(true)
    })

    // As the takedown of the tool: a name that is not a key can be a file of the takedown.
    test('after a takedown, fails on a name of the storage that is not a key, after the cleanup', async () => {
        const site = fixture({
            stored: [PHOTO.key, PLAN.key, OLD.key, 'notes/readme.txt'],
            overrides: { takedown: true }
        })
        const result = await deployRelease(site.run)
        expect(result).toMatchObject({ deploy: 'ok', live: true, deleted: 1 })
        expect(result.error).toBe(
            'after a takedown, the attachment storage has 1 file(s) that are not keys'
        )
        expect(JSON.stringify(result)).not.toContain('notes/readme.txt')
        expect(result.warnings.join('\n')).toContain('can still be public')
        expect(site.storage.names.has('notes/readme.txt')).toBe(true)
    })

    test('after a takedown, fails with a warning when the storage cannot be listed', async () => {
        const site = fixture({ stored: [PHOTO.key, PLAN.key], overrides: { takedown: true } })
        const result = await deployRelease({
            ...site.run,
            storage: { ...site.storage, list: () => Promise.reject(new Error('offline')) }
        })
        expect(result).toMatchObject({ build: 'skipped', deploy: 'skipped', deleted: 0 })
        expect(result.error).toContain('offline')
        expect(result.warnings.join('\n')).toContain('can still be public')
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

    // A dry run never counts as a deployment.
    test('in a dry run, builds and checks the bundle, touches no storage and deploys nothing', async () => {
        const site = fixture()
        const { storage: _storage, live: _live, ...run } = site.run
        const result = await deployRelease({ ...run, dryRun: true })
        expect(result).toMatchObject({ build: 'ok', deploy: 'skipped', live: false, error: null })
        expect(site.events).toEqual(['build', 'deploy'])
    })
})

// BUILD-07: one command goes back to the release before.
describe('a revert', () => {
    const BEFORE = {
        contentRevision: 'b'.repeat(40),
        siteRevision: SITE,
        builtAt: '2031-04-01T08:00:00Z'
    }
    const LIVE = {
        contentRevision: 'a'.repeat(40),
        siteRevision: SITE,
        builtAt: '2031-04-02T08:00:00Z',
        previous: BEFORE
    }

    /** A host that gives the live record, then these records once rolled back. */
    function host(
        live: unknown,
        after: unknown[]
    ): { events: string[]; run: Omit<RevertRun, 'takedownsBetween'> } {
        const events: string[] = []
        return {
            events,
            run: {
                rollback: () => {
                    events.push('rollback')
                    return Promise.resolve()
                },
                live: {
                    checks: 5,
                    pause: 1000,
                    inARow: 2,
                    read: () => {
                        events.push('live?')
                        return Promise.resolve(
                            events.includes('rollback') ? (after.shift() ?? BEFORE) : live
                        )
                    }
                },
                wait: (milliseconds) => {
                    events.push(`wait ${String(milliseconds)}`)
                    return Promise.resolve()
                }
            }
        }
    }

    test('rolls back, then gives the record of the release before once the host gives it in a row', async () => {
        const site = host(LIVE, [LIVE, BEFORE, BEFORE])
        const asked: string[] = []
        const result = await revertRelease({
            ...site.run,
            takedownsBetween: (from, to) => {
                asked.push(`${from}..${to}`)
                return Promise.resolve([])
            }
        })
        expect(result).toEqual({ before: LIVE, after: BEFORE, changed: true })
        expect(asked).toEqual([`${BEFORE.contentRevision}..${LIVE.contentRevision}`])
        expect(site.events).toEqual([
            'live?',
            'rollback',
            'live?',
            'wait 1000',
            'live?',
            'wait 1000',
            'live?'
        ])
    })

    // The takedown would come back.
    test('refuses when a takedown lies between the release before and the live one', async () => {
        const site = host(LIVE, [])
        const message = await rejectionOf(
            revertRelease({
                ...site.run,
                takedownsBetween: () => Promise.resolve(['Takedown: 1 note'])
            })
        )
        expect(message).toContain('Takedown: 1 note')
        expect(message).toContain('deploy a new release instead')
        expect(site.events).not.toContain('rollback')
    })

    test('refuses when the copy does not know the two revisions', async () => {
        const site = host(LIVE, [])
        const message = await rejectionOf(
            revertRelease({ ...site.run, takedownsBetween: () => Promise.resolve(undefined) })
        )
        expect(message).toContain('does not know')
        expect(site.events).not.toContain('rollback')
    })

    test.each([
        ['no record', undefined],
        ['no release before it', { ...LIVE, previous: null }],
        ['a record from before the release before was named', { ...BEFORE }]
    ])('refuses when the host gives %s', async (_case, live) => {
        const site = host(live, [])
        const message = await rejectionOf(
            revertRelease({ ...site.run, takedownsBetween: () => Promise.resolve([]) })
        )
        expect(message).toContain('deploy a new release instead')
        expect(site.events).not.toContain('rollback')
    })

    test('says that the host does not give the release before after a bounded wait', async () => {
        const site = host(LIVE, [LIVE, LIVE, LIVE, LIVE, LIVE])
        const result = await revertRelease({
            ...site.run,
            takedownsBetween: () => Promise.resolve([])
        })
        expect(result).toEqual({ before: LIVE, after: LIVE, changed: false })
    })
})

// Issue 32: a takedown must never come back with
// older content. A release whose content is not a descendant of the live
// one is refused, before anything and again right before the deployment.
describe('the release that is live', () => {
    const LIVE = {
        contentRevision: 'a'.repeat(40),
        siteRevision: SITE,
        builtAt: '2031-03-01T08:00:00Z'
    }

    /** A run whose host gives these answers in turn before the deployment. */
    function liveAnswers(answers: unknown[], overrides: Partial<DeployRun> = {}): Fixture {
        const site = fixture({ stored: [PHOTO.key, PLAN.key, OLD.key], overrides })
        const read = site.run.live?.read
        let calls = 0
        return {
            ...site,
            run: {
                ...site.run,
                live: {
                    checks: 5,
                    pause: 1000,
                    inARow: 1,
                    read: () => {
                        site.events.push('live?')
                        calls += 1
                        if (calls > answers.length) {
                            return read === undefined ? Promise.resolve(undefined) : read()
                        }
                        const answer = answers[calls - 1]
                        return answer instanceof Error
                            ? Promise.reject(answer)
                            : Promise.resolve(answer)
                    }
                }
            }
        }
    }

    test('is replaced by a release of a copy that holds its content revision', async () => {
        const asked: string[] = []
        const site = liveAnswers([LIVE, LIVE], {
            descendsFrom: (revision) => {
                asked.push(revision)
                return Promise.resolve(true)
            }
        })
        const result = await deployRelease(site.run)
        expect(result).toMatchObject({ deploy: 'ok', live: true, error: null })
        expect(asked).toEqual([LIVE.contentRevision])
    })

    // A revert goes back to it.
    test('is named in the record of the release that replaces it', async () => {
        const site = liveAnswers([{ ...LIVE, previous: null }, LIVE])
        await deployRelease(site.run)
        const record: unknown = JSON.parse(
            await readFile(join(site.dist(), '-', 'deployment.json'), 'utf8')
        )
        expect(record).toMatchObject({ previous: LIVE })
    })

    test('refuses right before the deployment when another release went live during the build', async () => {
        const site = liveAnswers([undefined, LIVE])
        const result = await deployRelease(site.run)
        expect(result).toMatchObject({ build: 'ok', deploy: 'skipped' })
        expect(result.error).toContain('during the build')
    })

    test('is never replaced by older content, and nothing is touched, also after a takedown', async () => {
        const site = liveAnswers([LIVE], {
            takedown: true,
            descendsFrom: () => Promise.resolve(false)
        })
        const result = await deployRelease(site.run)
        expect(result).toMatchObject({
            build: 'skipped',
            deploy: 'skipped',
            live: false,
            deleted: 0
        })
        expect(result.error).toContain(LIVE.contentRevision)
        expect(result.error).toContain('not in the history')
        expect(site.events.filter((event) => event !== 'live?')).toEqual([])
    })

    test('refuses a live revision that the copy does not know', async () => {
        const site = liveAnswers([LIVE], { descendsFrom: () => Promise.resolve(undefined) })
        const result = await deployRelease(site.run)
        expect(result).toMatchObject({ build: 'skipped', deploy: 'skipped' })
        expect(result.error).toContain('does not know')
    })

    test('refuses when the record of the live release cannot be read', async () => {
        const site = liveAnswers([new Error('the host answers 503')])
        const result = await deployRelease(site.run)
        expect(result).toMatchObject({ build: 'skipped', deploy: 'skipped' })
        expect(result.error).toContain('503')
    })

    test('refuses a record of the live release that is not a record', async () => {
        const site = liveAnswers([{ contentRevision: 'latest' }])
        expect((await deployRelease(site.run)).error).toContain('cannot be read')
    })

    test('refuses right before the deployment when a newer release went live during the build', async () => {
        const NEWER = { ...LIVE, contentRevision: 'b'.repeat(40) }
        const site = liveAnswers([LIVE, NEWER], {
            takedown: true,
            descendsFrom: (revision) => Promise.resolve(revision === LIVE.contentRevision)
        })
        const result = await deployRelease(site.run)
        expect(result).toMatchObject({ build: 'ok', deploy: 'skipped', live: false, deleted: 0 })
        expect(result.error).toContain(NEWER.contentRevision)
        expect(result.warnings.join('\n')).toContain('can still be public')
        expect(site.events).not.toContain('deploy')
        expect(site.storage.names.has(OLD.key)).toBe(true)
    })

    test('refuses right before the deployment when the copy changed during the build', async () => {
        const site = liveAnswers([], {
            takedown: true,
            beforeDeploy: () =>
                Promise.reject(new Error('the copy of the content store has changes'))
        })
        const result = await deployRelease(site.run)
        expect(result).toMatchObject({ build: 'ok', deploy: 'skipped', deleted: 0 })
        expect(result.error).toContain('has changes')
        expect(site.events).not.toContain('deploy')
    })

    test('lets an output built elsewhere replace no release of the content store', async () => {
        const dist = liveAnswers([LIVE], { contentRevision: null })
        const refused = await deployRelease(dist.run)
        expect(refused).toMatchObject({ build: 'skipped', deploy: 'skipped' })
        expect(refused.error).toContain('--dist')

        const first = liveAnswers([undefined, undefined], { contentRevision: null })
        expect(await deployRelease(first.run)).toMatchObject({ deploy: 'ok', error: null })

        const over = liveAnswers(
            [
                { ...LIVE, contentRevision: null },
                { ...LIVE, contentRevision: null }
            ],
            {
                contentRevision: null
            }
        )
        expect(await deployRelease(over.run)).toMatchObject({ deploy: 'ok', error: null })
    })
})

describe('the record that a host gives', () => {
    test('is read at its path, never from a cache', async () => {
        const asked: string[] = []
        const record = await readHostRecord('https://preview.notes.example/', (url, init) => {
            asked.push(`${url.href} ${String(init.cache)}`)
            return Promise.resolve(Response.json({ contentRevision: CONTENT }))
        })
        expect(record).toEqual({ contentRevision: CONTENT })
        expect(asked).toEqual(['https://preview.notes.example/-/deployment.json no-store'])
    })

    test('fails when the host fails', async () => {
        expect(
            await rejectionOf(
                readHostRecord('https://preview.notes.example/', () =>
                    Promise.resolve(new Response('upstream', { status: 503 }))
                )
            )
        ).toContain('503')
    })

    test('is none when the host answers no record', async () => {
        expect(
            await readHostRecord('https://preview.notes.example/', () =>
                Promise.resolve(new Response('Not found', { status: 404 }))
            )
        ).toBeUndefined()
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
