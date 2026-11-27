import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    FIXTURE_NOTE_TYPES,
    copyFixtureVault,
    makeContentStoreCopy,
    makeTestStores,
    testSealKey
} from '@dsebastien-website/testing'
import { fileNoteTypes, nodeDevice } from '../../plugin/src/publishing/node/device.ts'
import { plan, publish } from '../../plugin/src/publishing/tool.ts'
import type { UrlTable, UrlTableNote } from './url-table.ts'

// The site of the URL table (issue 43, SEAM-04 of the spec): the publishing
// tool publishes the notes of the table from a copy of the fixture vault,
// moves the ones with former paths, unpublishes the ones of `removed`, and
// the site is built from that content store. The test of the URL table and
// the command that runs the table on a host (`scripts/url-table.ts`) both
// build it here, so both check the same site.

const SITE = fileURLToPath(new URL('..', import.meta.url))

/** The built site of the URL table, with the content store that it was built from. */
export interface BuiltUrlTableSite {
    /** The exit code of the build of the site. 0 when the site is built. */
    readonly exitCode: number
    /** The copy of the content store. */
    readonly contentStore: string
    /** The cleaned note of the content store, by its vault path. */
    readonly markdownOf: (path: string) => Promise<string>
    /** Removes the stores and the vault of the build. The output stays: the caller made its folder. */
    readonly remove: () => Promise<void>
}

/**
 * Publishes the notes of the table and builds their site.
 *
 * @param outDir the folder of the output. It must be on the file system of
 * the site, in a folder that git ignores: Astro moves files into it
 */
export async function buildUrlTableSite(
    table: UrlTable,
    outDir: string
): Promise<BuiltUrlTableSite> {
    const stores = await makeTestStores()
    try {
        const vault = await copyFixtureVault(stores)
        // An invented note of the table that is not in the fixture vault
        // (issue 44: an unpublished namesake of a live note) goes into the copy.
        for (const note of [...table.notes, ...table.removed]) {
            if (note.text !== undefined) {
                await mkdir(dirname(join(vault, note.path)), { recursive: true })
                await writeFile(join(vault, note.path), note.text)
            }
        }
        const contentStore = await makeContentStoreCopy(stores)
        const device = {
            ...nodeDevice({
                noteTypes: fileNoteTypes(FIXTURE_NOTE_TYPES),
                vault,
                contentStore,
                attachmentStorage: stores.attachmentStorage
            }),
            // The invented store is sealed with the key of the tests (R104).
            seal: { environment: () => testSealKey(), envFile: () => Promise.resolve(undefined) }
        }
        const removed = table.removed.map((note) => note.path)
        // A note with former paths is published at its first one, then moved
        // by a line of a rename journal, as the plugin writes it (R66).
        const moved = [...table.notes, ...table.removed].flatMap((note) => {
            const [former] = note.formerPaths ?? []
            return former === undefined ? [] : [{ from: former, to: note.path }]
        })
        const move = async (from: string, to: string): Promise<void> => {
            await mkdir(dirname(join(vault, to)), { recursive: true })
            await rename(join(vault, from), join(vault, to))
        }
        for (const { from, to } of moved) {
            await move(to, from)
        }
        const first = (note: UrlTableNote): string => note.formerPaths?.[0] ?? note.path
        const planned = await plan(device, {
            include: [...table.notes.map(first), ...table.removed.map(first)]
        })
        await publish(device, planned.id, {
            time: '2031-04-01T08:00:00Z',
            device: 'garden-shed',
            face: 'plugin'
        })
        const journals = join(vault, '.obsidian', 'plugins', 'dsebastien-vault-publish', 'renames')
        await mkdir(journals, { recursive: true })
        for (const { from, to } of moved) {
            await move(from, to)
        }
        await writeFile(
            join(journals, '00000000000000ab.jsonl'),
            moved
                .map(({ from, to }) =>
                    JSON.stringify({ from, kind: 'note', time: '2031-04-01T09:00:00Z', to })
                )
                .map((line) => `${line}\n`)
                .join('')
        )
        // The notes of `removed` are unpublished by a second publication
        // (URL-27), which also applies the moves.
        const unpublish = await plan(device, { include: [], remove: removed })
        await publish(device, unpublish.id, {
            time: '2031-04-02T08:00:00Z',
            device: 'garden-shed',
            face: 'plugin'
        })
        // The redirect list of the table, as the author writes it into the
        // content store (issue 44). The build reads the file as it is.
        if (table.redirects !== undefined) {
            await writeFile(
                join(contentStore, 'redirects.json'),
                `${JSON.stringify(table.redirects, null, 4)}\n`
            )
        }
        const child = Bun.spawn(['bun', 'run', 'build', '--outDir', outDir], {
            cwd: SITE,
            env: { ...process.env, CONTENT_STORE: contentStore },
            stdout: 'ignore',
            stderr: 'ignore'
        })
        return {
            exitCode: await child.exited,
            contentStore,
            markdownOf: (path) => readFile(join(contentStore, 'notes', path), 'utf8'),
            remove: () => stores.remove()
        }
    } catch (error) {
        await stores.remove()
        throw error
    }
}
