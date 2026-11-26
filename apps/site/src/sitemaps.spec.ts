import { describe, expect, test } from 'bun:test'
import {
    entriesOf,
    locsOf,
    sitemapEntriesOf,
    sitemapGroupOf,
    sitemapGroupsOf,
    sitemapIndexXml,
    sitemapXml
} from './sitemaps.ts'

const ORIGIN = 'https://notes.example'

describe('the groups of the sitemaps', () => {
    test('put a note into the group of its note type, or into the notes', () => {
        expect(sitemapGroupOf('movies')).toBe('movies')
        expect(sitemapGroupOf('anime')).toBe('tv')
        expect(sitemapGroupOf('persons')).toBe('people')
        expect(sitemapGroupOf('own-poems')).toBe('notes')
        expect(sitemapGroupOf(undefined)).toBe('notes')
    })

    test('have a file for each group of the notes, then the generated pages', () => {
        expect(sitemapGroupsOf(['movies', undefined, 'anime', 'movies'])).toEqual([
            'movies',
            'notes',
            'tv',
            'generated'
        ])
        expect(sitemapGroupsOf([])).toEqual(['generated'])
    })
})

describe('a sitemap file', () => {
    test('lists absolute URLs in the order of their paths, with their dates', () => {
        const xml = sitemapXml(
            [
                { path: '/Zebra', lastmod: '2031-03-14T07:30:00Z' },
                { path: '/', lastmod: undefined }
            ],
            ORIGIN
        )
        expect(xml).toBe(
            '<?xml version="1.0" encoding="UTF-8"?>\n' +
                '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
                '  <url><loc>https://notes.example/</loc></url>\n' +
                '  <url><loc>https://notes.example/Zebra</loc><lastmod>2031-03-14T07:30:00Z</lastmod></url>\n' +
                '</urlset>\n'
        )
        expect(xml).not.toContain('priority')
        expect(xml).not.toContain('changefreq')
    })

    // seo item 39: a path with `&` or an apostrophe stays a valid XML file.
    test('escapes the characters of XML, and reads back the same URLs', () => {
        const xml = sitemapXml([{ path: "/Tom+%26+Jerry's", lastmod: '2031-01-01' }], ORIGIN)
        expect(xml).toContain('<loc>https://notes.example/Tom+%26+Jerry&apos;s</loc>')
        expect(entriesOf(xml)).toEqual([
            { loc: "https://notes.example/Tom+%26+Jerry's", lastmod: '2031-01-01' }
        ])
        const raw = sitemapXml([{ path: '/a&b' }], ORIGIN)
        expect(raw).toContain('/a&amp;b')
        expect(locsOf(raw)).toEqual(['https://notes.example/a&b'])
    })
})

describe('the sitemap index', () => {
    test('names each file of a group, with the newest date of the group', () => {
        const xml = sitemapIndexXml(
            new Map([
                [
                    'movies',
                    [
                        { path: '/A', lastmod: '2031-01-02T00:00:00Z' },
                        { path: '/B', lastmod: '2031-03-01T00:00:00Z' }
                    ]
                ],
                ['generated', [{ path: '/' }]]
            ]),
            ORIGIN
        )
        expect(xml).toContain('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')
        expect(xml).toContain(
            '<sitemap><loc>https://notes.example/sitemap-movies.xml</loc><lastmod>2031-03-01T00:00:00Z</lastmod></sitemap>'
        )
        expect(xml).toContain(
            '<sitemap><loc>https://notes.example/sitemap-generated.xml</loc></sitemap>'
        )
        expect(locsOf(xml)).toEqual([
            'https://notes.example/sitemap-movies.xml',
            'https://notes.example/sitemap-generated.xml'
        ])
    })
})

describe('the entries of the sitemaps', () => {
    test('hold every note in its group, and the indexed generated pages only', () => {
        const groups = sitemapEntriesOf({
            notes: [
                { path: '/Alien', noteType: 'movies', lastmod: '2031-01-01T00:00:00Z' },
                { path: '/Loose+note', lastmod: undefined }
            ],
            lists: [
                {
                    pages: [
                        { path: '/-/types/movies', indexed: true },
                        { path: '/-/recent/added.2', indexed: false }
                    ]
                }
            ],
            library: { path: '/-/library', indexed: false }
        })
        expect([...groups.keys()]).toEqual(['movies', 'notes', 'generated'])
        expect(groups.get('movies')).toEqual([{ path: '/Alien', lastmod: '2031-01-01T00:00:00Z' }])
        expect(groups.get('notes')).toEqual([{ path: '/Loose+note', lastmod: undefined }])
        expect(groups.get('generated')).toEqual([{ path: '/' }, { path: '/-/types/movies' }])
    })
})
