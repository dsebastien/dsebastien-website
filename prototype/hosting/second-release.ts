import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

// PROTOTYPE (issue 21, hosting). Throwaway code.
//
// Makes a second release from a copy of a built site: it changes 5 notes
// (their page and their Markdown) and 290 more pages, 300 files in all
// (check 5 of the hosting research). Run it on a copy made with
// `cp -al <dist> <copy>`: it writes each changed file as a new file, so the
// first release keeps its bytes.
//
//     bun prototype/hosting/second-release.ts --dist <copy> [--mark <text>]
//
// It prints the canonical paths of the 5 notes and the mark as JSON.

const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { dist: { type: 'string' }, mark: { type: 'string', default: 'release-2' } },
    strict: true
})
if (values.dist === undefined) {
    throw new Error('--dist is required')
}
const dist = values.dist
const map = (await Bun.file(join(dist, '-/resolver-map.json')).json()) as {
    pages: Record<string, string>
    files: Record<string, { file: string; type: string }>
}

/** Writes a changed copy of a file in its place, as a new file. */
async function change(file: string, end: string): Promise<void> {
    const path = join(dist, file)
    const text = await readFile(path, 'utf8')
    await Bun.file(path).delete()
    await writeFile(path, `${text}${end}`)
}

const notes = Object.entries(map.pages).filter(([, file]) => file.startsWith('-/note/'))
const changed: string[] = []
let count = 0
for (const [path, file] of notes.slice(0, 5)) {
    await change(file, `<!-- ${values.mark} -->\n`)
    const markdown = map.files[`/-/md${path}.md`]
    if (markdown === undefined) {
        throw new Error(`no Markdown for ${path}`)
    }
    await change(markdown.file, `\n<!-- ${values.mark} -->\n`)
    changed.push(path)
    count += 2
}
for (const [, file] of notes.slice(5, 295)) {
    await change(file, `<!-- ${values.mark} -->\n`)
    count += 1
}
process.stdout.write(
    `${JSON.stringify({ mark: values.mark, files: count, notes: changed }, null, 2)}\n`
)
