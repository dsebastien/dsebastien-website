import { copyFile, mkdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { prepareOutputFolder } from './output-folder.ts'

// The command that copies the published corpus (issue 64): the notes that are
// published today, with their attachments, from the vault of the author into
// an ignored folder. Prototypes and budget measurements then run on the real
// published notes, on the machines of the author only.
//
//   bun run corpus:published --vault <folder of the vault> --list <file>
//
// The list names the published files, as vault paths. It can be the site cache
// of Obsidian Publish (a JSON object whose keys are the paths), a JSON list,
// or a text file with one path per line.
//
// The path of the vault and the list are inputs. Neither is stored in this
// repository, and the output is never committed.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The file that marks a folder as the output of this command. It holds counts only. */
const MARKER = 'published.json'

const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
        vault: { type: 'string' },
        list: { type: 'string' },
        out: { type: 'string', default: join(ROOT, '.cache', 'published') }
    },
    strict: true
})

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads the vault paths of the list, in one of its three forms. */
async function readList(file: string): Promise<string[]> {
    const text = await Bun.file(file).text()
    const start = text.trimStart().charAt(0)
    if (start !== '{' && start !== '[') {
        return text
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '')
    }
    const list: unknown = JSON.parse(text)
    if (Array.isArray(list) && list.every((path) => typeof path === 'string')) {
        return list
    }
    if (isRecord(list)) {
        return Object.keys(list)
    }
    throw new Error(`"${file}" is not a list of paths`)
}

/** True when the path stays inside the vault. A list never makes the command read another place. */
function isInside(vault: string, file: string): boolean {
    const fromVault = relative(vault, file)
    return fromVault !== '' && !fromVault.startsWith('..') && !isAbsolute(fromVault)
}

async function isFile(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isFile()
    } catch {
        return false
    }
}

async function main(): Promise<void> {
    if (values.vault === undefined || values.list === undefined) {
        throw new Error('give the folder of the vault with --vault and the list with --list')
    }
    const vault = resolve(values.vault)
    const out = resolve(values.out)
    const paths = await readList(values.list)
    await prepareOutputFolder(out, MARKER)
    // The marker comes first: a run that stops halfway leaves a folder that
    // the next run can write over.
    await Bun.write(join(out, MARKER), '{}\n')

    const folders = new Set<string>()
    const missing: string[] = []
    let notes = 0
    let attachments = 0
    for (const path of paths) {
        const source = resolve(vault, path)
        if (isAbsolute(path) || !isInside(vault, source) || !(await isFile(source))) {
            missing.push(path)
            continue
        }
        const target = join(out, 'vault', relative(vault, source))
        const folder = dirname(target)
        if (!folders.has(folder)) {
            await mkdir(folder, { recursive: true })
            folders.add(folder)
        }
        await copyFile(source, target)
        if (path.toLowerCase().endsWith('.md')) {
            notes += 1
        } else {
            attachments += 1
        }
    }

    if (missing.length > 0) {
        await Bun.write(join(out, 'missing.txt'), `${missing.join('\n')}\n`)
    }
    const counts = { notes, attachments, missing: missing.length }
    await Bun.write(join(out, MARKER), `${JSON.stringify(counts, null, 4)}\n`)
    console.error(
        `Copied ${String(notes)} notes and ${String(attachments)} attachments to ${join(out, 'vault')}, ${String(missing.length)} missing` +
            (missing.length > 0 ? ` (see ${join(out, 'missing.txt')})` : '')
    )
}

try {
    await main()
} catch (error) {
    console.error(error instanceof Error ? `error: ${error.message}` : error)
    process.exitCode = 1
}
