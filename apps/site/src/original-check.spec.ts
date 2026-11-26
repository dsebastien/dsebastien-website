import { describe, expect, test } from 'bun:test'
import type { PageAnswer } from '../../plugin/src/publishing/ports.ts'
import { originalFindings, type OriginalNote } from './original-check.ts'

// The check of the originals between the two sites (IDX-15, the switch gate
// of ADR 0010): for each note that also exists on the main site, the notes
// page names the post, and the post names itself. The two sites are stubbed:
// no test reaches the real main site.

const POST = 'https://www.dsebastien.net/a-post/'
const PAGE = 'https://notes.dsebastien.net/Writing/A+post'

function head(canonical: string): string {
    return `<html><head><link rel="canonical" href="${canonical}"></head></html>`
}

function note(options: Partial<OriginalNote> = {}): OriginalNote {
    return { vaultPath: 'Writing/A post.md', pageUrl: PAGE, post: POST, ...options }
}

/** The main site of a test: the page of each URL, or no answer. */
function mainSite(pages: Record<string, PageAnswer>) {
    const asked: string[] = []
    return {
        asked,
        site: {
            page: (url: string) => {
                asked.push(url)
                const page = pages[url]
                return page === undefined
                    ? Promise.reject(new Error('no network'))
                    : Promise.resolve(page)
            }
        }
    }
}

const SELF = { [POST]: { status: 200, url: POST, body: head(POST) } }

describe('the check of the originals between the two sites', () => {
    test('finds nothing when the notes page names the post and the post names itself', async () => {
        const { site, asked } = mainSite(SELF)
        expect(await originalFindings([note()], () => Promise.resolve(head(POST)), site)).toEqual(
            []
        )
        expect(asked).toEqual([POST])
    })

    test('lists a notes page that names itself', async () => {
        const { site } = mainSite(SELF)
        const findings = await originalFindings([note()], () => Promise.resolve(head(PAGE)), site)
        expect(findings.map((finding) => finding.path)).toEqual(['Writing/A post.md'])
        expect(findings[0]?.message).toContain(`names ${PAGE}`)
    })

    test('lists a post that names the notes site: a loop', async () => {
        const { site } = mainSite({ [POST]: { status: 200, url: POST, body: head(PAGE) } })
        const findings = await originalFindings([note()], () => Promise.resolve(head(POST)), site)
        expect(findings).toHaveLength(1)
        expect(findings[0]?.message).toContain('loop')
    })

    test('lists a post that cannot be read', async () => {
        const { site } = mainSite({})
        const findings = await originalFindings([note()], () => Promise.resolve(head(POST)), site)
        expect(findings[0]?.message).toContain('no network')
    })

    test('lists a note without a post URL, and asks the main site nothing for it', async () => {
        const { site, asked } = mainSite(SELF)
        const { post: _post, ...without } = note()
        const findings = await originalFindings([without], () => Promise.resolve(head(PAGE)), site)
        expect(findings[0]?.message).toContain('no post URL')
        expect(asked).toEqual([])
    })

    test('lists a notes page that cannot be read', async () => {
        const { site } = mainSite(SELF)
        const findings = await originalFindings(
            [note()],
            () => Promise.reject(new Error('the notes page answers 404')),
            site
        )
        expect(findings[0]?.message).toContain('404')
    })

    test('lists the notes by path', async () => {
        const { site } = mainSite(SELF)
        const findings = await originalFindings(
            [note({ vaultPath: 'B.md' }), note({ vaultPath: 'A.md' })],
            () => Promise.resolve(head(PAGE)),
            site
        )
        expect(findings.map((finding) => finding.path)).toEqual(['A.md', 'B.md'])
    })
})
