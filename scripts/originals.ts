import { readFile } from 'node:fs/promises'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { SITE_ORIGIN } from '@dsebastien-website/resolver'
import { readPublishedNotes } from '../apps/site/src/content-store.ts'
import { originalFindings, type OriginalNote } from '../apps/site/src/original-check.ts'
import {
    CHECK_TIME_LIMIT,
    hasOriginal,
    postUrlOf
} from '../apps/plugin/src/publishing/originals.ts'
import { httpsMainSite, requestWith } from '../apps/plugin/src/publishing/node/main-site.ts'

// The check of the originals between the two sites (IDX-15, the switch gate
// of ADR 0010, issue 55): for each published note of a type that the main
// site also publishes, the notes page names the post in its canonical link,
// and the post on the live main site names itself.
//
//     bun run originals --content-store <folder> (--dist <folder> | --base <address>)
//
// `--content-store` is a copy of the content store: its manifest says which
// notes to check and which post the tool verified (else the property `url`
// of the cleaned note names it). `--dist` reads the notes pages from a built
// site (`-/note/<id>.html`); `--base` asks a host for them (the preview host,
// or the real host after the switch), at the canonical path of each note. It
// only reads, with `GET`. It prints one line per note for which the two
// sites do not name the same URL, and ends with the code 1 when there is
// one.

const { values } = parseArgs({
    options: {
        'content-store': { type: 'string' },
        'dist': { type: 'string' },
        'base': { type: 'string' }
    },
    strict: true
})

const store = values['content-store']
const dist = values.dist
const base = values.base?.replace(/\/+$/u, '')
if (store === undefined || (dist === undefined) === (base === undefined)) {
    console.error(
        'usage: bun run originals --content-store <folder> (--dist <folder> | --base <address>)'
    )
    process.exit(2)
}

const published = await readPublishedNotes(resolve(store))
const notes: (OriginalNote & { readonly file: string })[] = []
for (const note of published) {
    if (!hasOriginal(note.noteType)) {
        continue
    }
    const cleaned = await readFile(join(resolve(store), 'notes', note.vaultPath), 'utf8')
    const post = note.original ?? postUrlOf(cleaned)
    notes.push({
        vaultPath: note.vaultPath,
        pageUrl: `${base ?? SITE_ORIGIN}${note.path}`,
        file: note.file,
        ...(post === undefined ? {} : { post })
    })
}

const request = requestWith(base?.startsWith('http://') === true ? httpGet : httpsGet)
const files = new Map(notes.map((note) => [note.vaultPath, note.file]))
const notesPage = async (note: OriginalNote): Promise<string> => {
    if (dist !== undefined) {
        return await readFile(join(resolve(dist), files.get(note.vaultPath) ?? ''), 'utf8')
    }
    const answer = await request(note.pageUrl, CHECK_TIME_LIMIT)
    if (answer.status !== 200) {
        throw new Error(`it answers ${String(answer.status)}`)
    }
    return answer.body
}

const findings = await originalFindings(notes, notesPage, httpsMainSite())
for (const finding of findings) {
    console.error(`${finding.path}: ${finding.message}`)
}
console.error(
    `${String(notes.length)} notes that also exist on the main site, ${String(findings.length)} where the two sites do not name the same URL`
)
process.exit(findings.length === 0 ? 0 : 1)
