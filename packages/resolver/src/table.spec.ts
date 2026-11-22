import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { resolve, type Resolution } from './resolver.ts'
import { resolverMapOf, type SiteFiles } from './site.ts'
import { canonicalPath } from './url.ts'

// The URL table of the site (issue 43, section 10 of the spec), on the
// resolver as a pure function. The test of the plain local server runs the
// same table over HTTP (`apps/site/src/urls-page.spec.ts`).
const TABLE = fileURLToPath(new URL('../../../fixtures/urls.json', import.meta.url))

interface Case {
    name: string
    request: string
    status: number
    page?: string
    canonical?: string
    file?: string
    location?: string
    cacheControl?: string
    suggestions?: string[]
}

interface Table {
    notes: { path: string; aliases: string[]; formerPaths?: string[] }[]
    removed: { path: string; aliases: string[]; formerPaths?: string[] }[]
    cases: Case[]
}

// The file is test data of this repository. The cast is the boundary: a wrong
// shape fails the tests that read it.
const table = (await Bun.file(TABLE).json()) as Table

// The files of the build, named so that the test sees which page is served.
const FILES: SiteFiles = {
    home: 'index.html',
    notFound: '404.html',
    gone: '410.html',
    robots: 'robots.txt',
    page: (path) => `page:${path}`,
    markdown: (path) => `markdown:${path}`,
    folder: (path) => `folder:${path}`,
    // The name only: the expected file comes from the canonical paths of the table.
    choice: (paths) => `choice:${paths.map(canonicalPath).join('|')}`
}

const map = resolverMapOf(table.notes, FILES, {}, {}, table.removed)

/** The answer that a case states, as the resolver gives it. */
function expected(entry: Case): Resolution {
    if (entry.status === 410) {
        return { kind: 'gone', file: FILES.gone }
    }
    if (entry.status === 404) {
        const suggestions = entry.suggestions ?? []
        return {
            kind: 'not-found',
            suggestions,
            file: suggestions.length > 1 ? `choice:${suggestions.join('|')}` : FILES.notFound
        }
    }
    if (entry.location !== undefined) {
        return {
            kind: 'redirect',
            status: entry.status === 302 ? 302 : 301,
            location: entry.location,
            cacheControl: entry.cacheControl ?? ''
        }
    }
    if (entry.file !== undefined) {
        const [kind = '', path = ''] = entry.file.split(/:(.*)/su)
        return kind === 'markdown'
            ? { kind: 'file', file: FILES.markdown(path), type: 'markdown' }
            : { kind: 'file', file: FILES.robots, type: 'text' }
    }
    const [kind = '', path = ''] = (entry.page ?? '').split(/:(.*)/su)
    const file =
        kind === 'note' ? FILES.page(path) : kind === 'folder' ? FILES.folder(path) : FILES.home
    return { kind: 'page', file }
}

describe('URL table of the site', () => {
    test.each(table.cases.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
        const at = entry.request.indexOf('?')
        const path = at < 0 ? entry.request : entry.request.slice(0, at)
        const query = at < 0 ? '' : entry.request.slice(at)
        expect(resolve(path, map, query)).toEqual(expected(entry))
    })

    // URL-05: a redirect target never redirects. Every variant reaches a
    // page with status 200 in one hop, and an old Markdown path the Markdown
    // of its note.
    test.each(
        table.cases
            .filter((entry) => entry.location !== undefined)
            .map((entry) => [entry.name, entry] as const)
    )('the target of "%s" is a page', (_name, entry) => {
        const location = entry.location ?? ''
        const at = location.indexOf('?')
        const resolution = resolve(at < 0 ? location : location.slice(0, at), map)
        expect(resolution.kind).toBe(location.startsWith('/-/md/') ? 'file' : 'page')
    })

    test('the table has a case of each kind', () => {
        const statuses = new Set(table.cases.map((entry) => entry.status))
        expect([...statuses].sort()).toEqual([200, 301, 302, 404, 410])
        expect(table.cases.length).toBeGreaterThan(50)
    })
})
