import { copyFile, mkdir, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
    isInside,
    prepareOutputFolder,
    realPathOf,
    writeMarker,
    type OutputOptions
} from './output-folder.ts'

// The command that copies the published corpus (issue 64): the notes that are
// published today, with their attachments, from the vault of the author into
// an ignored folder. Prototypes and budget measurements then run on the real
// published notes, on the machines of the author only.
//
//   bun run corpus:published --vault <folder of the vault> --list <file>
//
// The list names the published files, as vault paths. A file that ends in
// `.json` is the site cache of Obsidian Publish (a JSON object whose keys are
// the paths) or a JSON list. Every other file is text, with one path per line.
//
// The path of the vault and the list are inputs. Neither is stored in this
// repository, and the output is never committed. The command never writes
// into the vault, and it never reads a file outside the vault: a symbolic
// link that leaves the vault is not followed.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads the vault paths of the list. */
async function readList(file: string): Promise<string[]> {
    const text = await Bun.file(file).text()
    if (!file.toLowerCase().endsWith('.json')) {
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

async function isFolder(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isDirectory()
    } catch {
        return false
    }
}

/**
 * The real path of a file of the list, or `undefined` when the path does not
 * name a file inside the vault. A list never makes the command read another
 * place, also not through a symbolic link.
 */
async function sourceOf(vault: string, path: string): Promise<string | undefined> {
    if (path === '' || isAbsolute(path) || path.includes('\\')) {
        return undefined
    }
    if (!isInside(vault, resolve(vault, path))) {
        return undefined
    }
    try {
        const real = await realpath(resolve(vault, path))
        return isInside(vault, real) && (await stat(real)).isFile() ? real : undefined
    } catch {
        return undefined
    }
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        args: Bun.argv.slice(2),
        options: {
            vault: { type: 'string' },
            list: { type: 'string' },
            out: { type: 'string', default: join(ROOT, '.cache', 'published') }
        },
        strict: true
    })
    if (values.vault === undefined || values.list === undefined) {
        throw new Error('give the folder of the vault with --vault and the list with --list')
    }
    // Every input is checked before the earlier output is removed.
    if (!(await isFolder(values.vault))) {
        throw new Error(`the vault is not a folder: "${values.vault}"`)
    }
    const vault = await realPathOf(resolve(values.vault))
    const paths = await readList(values.list)
    if (paths.length === 0) {
        throw new Error(`"${values.list}" names no file`)
    }
    const options: OutputOptions = {
        marker: 'published.json',
        tool: 'corpus:published',
        inputs: [vault]
    }
    const out = await prepareOutputFolder(resolve(values.out), options)

    const folders = new Set<string>()
    const copied = new Set<string>()
    const missing: string[] = []
    for (const path of paths) {
        const source = await sourceOf(vault, path)
        if (source === undefined) {
            missing.push(path)
            continue
        }
        // The same file can be in the list two times, in two spellings.
        const name = relative(vault, resolve(vault, path)).split(sep).join('/')
        if (copied.has(name)) {
            continue
        }
        const target = join(out, 'vault', name)
        try {
            if (!folders.has(dirname(target))) {
                await mkdir(dirname(target), { recursive: true })
                folders.add(dirname(target))
            }
            await copyFile(source, target)
            copied.add(name)
        } catch {
            // A file that cannot be read is reported, and the command goes on.
            missing.push(path)
        }
    }

    const notes = [...copied].filter((name) => name.toLowerCase().endsWith('.md')).length
    const attachments = copied.size - notes
    if (missing.length > 0) {
        await Bun.write(join(out, 'missing.txt'), `${missing.join('\n')}\n`)
    }
    await writeMarker(out, options, { notes, attachments, missing: missing.length })
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
