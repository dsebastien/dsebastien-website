import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { parseManifestEntry } from './manifest.ts'
import type { NoteType } from './note-types.ts'
import {
    CHECK_CONCURRENCY,
    canonicalLinksOf,
    checkOriginals,
    comparisonForm,
    GHOST_POST_PROPERTY,
    hasOriginal,
    judgePost,
    ORIGINAL_NOTE_TYPES,
    postOf,
    type Answer
} from './originals.ts'
import type { MainSite, PageAnswer } from './ports.ts'

// The check of the original on the main site (PUB-100, IDX-11 to IDX-13).
// The Rust implementation reads the same cases (`cli/src/originals.rs`).
const CASES = fileURLToPath(
    new URL('../../../../fixtures/canonical/originals.json', import.meta.url)
)

interface Cases {
    noteTypes: string[]
    ghostProperty: string
    forms: { name: string; text: string; form: string | null }[]
    properties: {
        name: string
        noteType: string | null
        note: string
        inScope: boolean
        url: string | null
    }[]
    canonicals: { name: string; page: string; html: string; links: string[] }[]
    entries: { name: string; original: string | null; valid: boolean }[]
    judged: { name: string; url: string; answer: Answer; verified: boolean }[]
}

// The file is test data of this repository. The cast is the boundary.
const cases = (await Bun.file(CASES).json()) as Cases

describe('the note types with an original', () => {
    test('are the types of the shared cases', () => {
        expect([...ORIGINAL_NOTE_TYPES]).toEqual(cases.noteTypes)
    })

    test('and the property of the Ghost Publish plugin are those of the shared cases', () => {
        expect(GHOST_POST_PROPERTY).toBe(cases.ghostProperty)
    })

    test('are known by their canonical name only', () => {
        expect(hasOriginal('own-articles')).toBe(true)
        expect(hasOriginal({ name: 'own-news', displayName: 'News' })).toBe(true)
        expect(hasOriginal('ai-wiki-articles')).toBe(false)
        expect(hasOriginal(undefined)).toBe(false)
    })
})

describe('the comparison form of a URL', () => {
    test.each(cases.forms.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
        expect(comparisonForm(entry.text) ?? null).toBe(entry.form)
    })
})

describe('the post of a note', () => {
    test.each(cases.properties.map((entry) => [entry.name, entry] as const))(
        '%s',
        (_name, entry) => {
            const post = postOf(entry.note, entry.noteType ?? undefined)
            expect(post.inScope).toBe(entry.inScope)
            expect(post.url ?? null).toBe(entry.url)
        }
    )
})

describe('the canonical links of a page', () => {
    test.each(cases.canonicals.map((entry) => [entry.name, entry] as const))(
        '%s',
        (_name, entry) => {
            expect(canonicalLinksOf(entry.html, entry.page)).toEqual(entry.links)
        }
    )
})

describe('the original of a manifest entry', () => {
    test.each(cases.entries.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
        const original = entry.original === null ? '' : `,"original":${entry.original}`
        const text = `{"aliases":[],"attachments":[],"cleanedHash":"sha256:00","cleaningVersion":4,"firstPublished":"2031-04-01T08:00:00Z","formerPaths":[],"id":"00000000000000aa","lastPublished":"2031-04-01T08:00:00Z","links":[]${original},"path":"A.md","sourceHash":"sha256:00","state":"published"}`
        const read = (): unknown => parseManifestEntry(text, 'manifest/00000000000000aa.json')
        if (entry.valid) {
            expect(read).not.toThrow()
        } else {
            expect(read).toThrow()
        }
    })
})

describe('the judgment of a post', () => {
    test.each(cases.judged.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
        const judged = judgePost(entry.url, entry.answer)
        expect(judged.verified).toBe(entry.verified)
        if (!judged.verified) {
            expect(judged.reason).toContain(entry.url)
        }
    })

    test('names a loop with the notes site', () => {
        const judged = judgePost('https://www.dsebastien.net/a-post/', {
            status: 200,
            url: 'https://www.dsebastien.net/a-post/',
            body: '<link rel="canonical" href="https://notes.dsebastien.net/A">'
        })
        expect(judged.verified ? '' : judged.reason).toContain('loop')
    })
})

const ARTICLE: NoteType = { name: 'own-articles', displayName: 'Own Articles' }
const TIME = '2031-04-01T08:00:00Z'

function note(path: string, url: string | undefined, noteType: NoteType | undefined = ARTICLE) {
    return {
        path,
        noteType,
        source: url === undefined ? 'Text\n' : `---\nurl: ${url}\n---\nText\n`
    }
}

function selfNaming(url: string): PageAnswer {
    return { status: 200, url, body: `<head><link rel="canonical" href="${url}"></head>` }
}

describe('the check of the originals of a publication', () => {
    test('records the post that names itself, with the time of the run', async () => {
        const asked: string[] = []
        const site: MainSite = {
            page: (url) => {
                asked.push(url)
                return Promise.resolve(selfNaming(url))
            }
        }
        const results = await checkOriginals(
            site,
            [
                note('A.md', 'https://www.dsebastien.net/a'),
                note('B.md', 'https://www.dsebastien.net/b/', {
                    name: 'book-notes',
                    displayName: 'Book Notes'
                })
            ],
            TIME
        )
        expect(asked).toEqual(['https://www.dsebastien.net/a/'])
        expect(results).toEqual(
            new Map([
                ['A.md', { original: { checked: TIME, url: 'https://www.dsebastien.net/a/' } }]
            ])
        )
    })

    test('gives a reason, never a throw, for a failed request', async () => {
        const site: MainSite = { page: () => Promise.reject(new Error('no network')) }
        const results = await checkOriginals(
            site,
            [note('A.md', 'https://www.dsebastien.net/a/')],
            TIME
        )
        const result = results.get('A.md')
        expect(result !== undefined && 'reason' in result ? result.reason : '').toContain(
            'no network'
        )
    })

    test('gives a reason for a note without a post URL, and asks nothing', async () => {
        let asked = 0
        const site: MainSite = {
            page: (url) => {
                asked += 1
                return Promise.resolve(selfNaming(url))
            }
        }
        const results = await checkOriginals(
            site,
            [note('A.md', undefined), note('B.md', 'https://notes.dsebastien.net/B')],
            TIME
        )
        expect(asked).toBe(0)
        expect([...results.keys()]).toEqual(['A.md', 'B.md'])
        expect([...results.values()].every((result) => 'reason' in result)).toBe(true)
    })

    test('checks nothing without the port of the main site', async () => {
        const results = await checkOriginals(
            undefined,
            [note('A.md', 'https://www.dsebastien.net/a/')],
            TIME
        )
        const result = results.get('A.md')
        expect(result !== undefined && 'reason' in result).toBe(true)
    })

    test('has at most a few requests at one time', async () => {
        let open = 0
        let most = 0
        const site: MainSite = {
            page: async (url) => {
                open += 1
                most = Math.max(most, open)
                await new Promise((resolve) => setTimeout(resolve, 5))
                open -= 1
                return selfNaming(url)
            }
        }
        const notes = Array.from({ length: 12 }, (_, index) =>
            note(`N${String(index)}.md`, `https://www.dsebastien.net/n${String(index)}/`)
        )
        const results = await checkOriginals(site, notes, TIME)
        expect(most).toBe(CHECK_CONCURRENCY)
        expect([...results.values()].every((result) => 'original' in result)).toBe(true)
    })
})

describe('the check of a note that the Ghost Publish plugin posted', () => {
    test('asks for the post of the property of the plugin, whatever the type of the note', async () => {
        const asked: string[] = []
        const site: MainSite = {
            page: (url) => {
                asked.push(url)
                return Promise.resolve(selfNaming(url))
            }
        }
        const results = await checkOriginals(
            site,
            [
                {
                    path: 'Tool.md',
                    noteType: { name: 'tools', displayName: 'Tools' },
                    source: '---\nurl: https://tool.example/\npublic_ghost_blog_news_url: https://www.dsebastien.net/a-tool/\n---\nText\n'
                }
            ],
            TIME
        )
        expect(asked).toEqual(['https://www.dsebastien.net/a-tool/'])
        expect(results.get('Tool.md')).toEqual({
            original: { checked: TIME, url: 'https://www.dsebastien.net/a-tool/' }
        })
    })
})
