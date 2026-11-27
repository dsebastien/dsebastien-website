import { cp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
    FIXTURE_VAULT,
    gitEnvironment,
    makeContentStoreCopy,
    makeTestStores,
    sealHead,
    testSealKey
} from '@dsebastien-website/testing'

// The invented stores are sealed with the key of the tests (R104): every
// device of this run, and every program that it starts, uses that key.
process.env['VAULT_PUBLISH_SEAL_KEY'] = testSealKey()

// A test vault for the check of the plugin by hand (issue 39, section 18.1 of
// the spec): a copy of the invented fixture vault, or of the invented corpus
// of full size (`bun run corpus` first), a local content store with its copy,
// an attachment storage, the development build of the plugin, and the build
// of the Obsidian Starter Kit plugin when its clone is on this machine. It
// never reads the real vault. It lives in `.cache/` and stays until you
// remove it.
//
//     bun run plugin:vault [--corpus] [--starter-kit <folder of its build>]
//
// Then open the printed vault in Obsidian, trust its plugins, paste the two
// printed folders into the settings of Vault Publish, and open the
// publication center. For the hot reload, run
// `VAULT_PUBLISH_DEV_VAULT=<vault> bun run dev:plugin`.

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PLUGIN_ID = 'dsebastien-vault-publish'
const STARTER_KIT_ID = 'obsidian-starter-kit'

const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
        'corpus': { type: 'boolean', default: false },
        'starter-kit': { type: 'string' }
    },
    strict: true
})

async function git(cwd: string, ...args: string[]): Promise<void> {
    const child = Bun.spawn(['git', ...args], {
        cwd,
        env: gitEnvironment(),
        stdout: 'ignore',
        stderr: 'pipe'
    })
    const errors = await new Response(child.stderr).text()
    if ((await child.exited) !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${errors.trim()}`)
    }
}

async function isFile(path: string): Promise<boolean> {
    return Bun.file(path).exists()
}

const corpus = join(ROOT, '.cache', 'corpus', 'vault')
if (values.corpus && !(await isFile(join(ROOT, '.cache', 'corpus', 'corpus.json')))) {
    console.error('No invented corpus: run `bun run corpus` first.')
    process.exit(1)
}

// The stores of the tests, kept: the check by hand needs them after this command.
const stores = await makeTestStores()
const vault = join(stores.root, 'vault')
await cp(values.corpus ? corpus : FIXTURE_VAULT, vault, { recursive: true, errorOnExist: true })
const copy = await makeContentStoreCopy(stores)
if (values.corpus) {
    // The corpus has no folder of the deny list of the fixture vault, and a
    // deny list entry that names no folder stops every run (GATE-38).
    await writeFile(join(copy, 'configuration.json'), '{\n    "denyList": []\n}\n')
    await git(copy, 'commit', '--quiet', '--all', '--message', 'An empty deny list for the corpus')
    await sealHead(copy)
    await git(copy, 'push', '--quiet', 'origin', 'HEAD:main')
}
// The plugin in Obsidian reads the seal key of the invented store from the
// .env file of the test vault (R104).
await writeFile(join(vault, '.env'), `VAULT_PUBLISH_SEAL_KEY=${testSealKey()}\n`)

const plugins = join(vault, '.obsidian', 'plugins')
await mkdir(plugins, { recursive: true })
const enabled = [PLUGIN_ID]
const starterKit =
    values['starter-kit'] ??
    join(
        process.env['WKS'] || join(process.env['HOME'] ?? '', 'wks'),
        'obsidian-starter-kit-plugin',
        'dist'
    )
if (await isFile(join(starterKit, 'main.js'))) {
    const target = join(plugins, STARTER_KIT_ID)
    await mkdir(target, { recursive: true })
    for (const file of ['main.js', 'manifest.json', 'styles.css']) {
        if (await isFile(join(starterKit, file))) {
            await Bun.write(join(target, file), Bun.file(join(starterKit, file)))
        }
    }
    enabled.unshift(STARTER_KIT_ID)
} else {
    console.error(
        `No build of the Obsidian Starter Kit plugin in ${starterKit}: every check stops until it is enabled in the vault (its batch API, recognizeNoteTypes). Give its build with --starter-kit <folder>.`
    )
}
await writeFile(
    join(vault, '.obsidian', 'community-plugins.json'),
    `${JSON.stringify(enabled, null, 2)}\n`
)

// One development build of the plugin, copied into the vault.
const build = Bun.spawn(['bun', 'scripts/build.ts', '--once'], {
    cwd: join(ROOT, 'apps', 'plugin'),
    env: { ...process.env, VAULT_PUBLISH_DEV_VAULT: vault },
    stdout: 'ignore',
    stderr: 'inherit'
})
if ((await build.exited) !== 0) {
    console.error('The build of the plugin failed.')
    process.exit(1)
}

process.stdout.write(`Test vault: ${vault}

Settings of Vault Publish (this device):
    Copy of the content store: ${copy}
    Attachment storage: ${stores.attachmentStorage}

The content store itself: ${stores.contentStore}
Remove it all with: rm -r '${stores.root}'
Hot reload: VAULT_PUBLISH_DEV_VAULT='${vault}' bun run dev:plugin
`)
