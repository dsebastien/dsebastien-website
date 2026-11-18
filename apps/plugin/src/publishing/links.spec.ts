import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import {
    LinkIndex,
    linkPathOfDestination,
    linkPathsOf,
    linksOf,
    sameLinks,
    wikilinksOf
} from './links.ts'
import type { NoteLink } from './links.ts'

// The rules for the links of a note (documentation/Canonical Form.md, section
// "The links of a note"). The Rust implementation reads the same cases
// (`cli/src/links.rs`), so both must give the result that the file states.
const CASES = fileURLToPath(new URL('../../../../fixtures/canonical/links.json', import.meta.url))

interface Cases {
    linkPaths: { name: string; text: string; linkPaths: string[] }[]
    targets: {
        notes: string[]
        cases: { name: string; from: string; link: string; target: string | null }[]
    }
    links: {
        name: string
        notes: string[]
        ignored: string[]
        from: string
        text: string
        links: NoteLink[]
    }[]
}

// The file is test data of this repository. The cast is the boundary: a wrong
// shape fails the tests that read it.
const cases = (await Bun.file(CASES).json()) as Cases

describe('link paths of a note', () => {
    test.each(cases.linkPaths.map((entry) => [entry.name, entry] as const))(
        '%s',
        (_name, entry) => {
            expect(linkPathsOf(entry.text)).toEqual(entry.linkPaths)
        }
    )
})

// What the build reads to show a link. The build and the tool read a link in
// the same way, because both call these functions.
describe('wikilinks of a line', () => {
    test('each link has its place, its link path and the text that a reader sees', () => {
        expect(
            wikilinksOf('See [[Alpha]], ![[Beta#Part]] and [[Folder/Gamma|the third]].')
        ).toEqual([
            { start: 4, end: 13, linkPath: 'Alpha', text: 'Alpha', embed: false },
            { start: 15, end: 29, linkPath: 'Beta', text: 'Beta#Part', embed: true },
            { start: 34, end: 60, linkPath: 'Folder/Gamma', text: 'the third', embed: false }
        ])
    })

    test('a link into the note itself has an empty link path and its text', () => {
        expect(wikilinksOf('[[#Part one]]')).toEqual([
            { start: 0, end: 13, linkPath: '', text: '#Part one', embed: false }
        ])
    })

    test('a link in a table has its text without the backslash', () => {
        expect(wikilinksOf('| [[Alpha\\|a]] |')).toEqual([
            { start: 2, end: 14, linkPath: 'Alpha', text: 'a', embed: false }
        ])
    })

    test('a mark before a bracket that opens no link is no embed', () => {
        expect(wikilinksOf('![[[Alpha]]')).toEqual([
            { start: 2, end: 11, linkPath: 'Alpha', text: 'Alpha', embed: false }
        ])
        expect(wikilinksOf('[[Alpha]]![[Beta]]').map((link) => link.embed)).toEqual([false, true])
    })
})

describe('link path of a Markdown destination', () => {
    test('a file of the vault has its decoded path up to the hash', () => {
        expect(linkPathOfDestination('Folder/Beta%20one.md#part')).toBe('Folder/Beta one.md')
    })

    test.each(['', '#part', 'https://example.org/a.md', 'mailto:a@example.org'])(
        '"%s" is not a file of the vault',
        (destination) => {
            expect(linkPathOfDestination(destination)).toBeUndefined()
        }
    )
})

describe('target of a link path', () => {
    const index = new LinkIndex(cases.targets.notes)

    test.each(cases.targets.cases.map((entry) => [entry.name, entry] as const))(
        '%s',
        (_name, entry) => {
            expect(index.targetOf(entry.link, entry.from) ?? null).toBe(entry.target)
        }
    )

    test('the order in which the notes are given changes nothing', () => {
        const reversed = new LinkIndex([...cases.targets.notes].reverse())
        for (const entry of cases.targets.cases) {
            expect(reversed.targetOf(entry.link, entry.from) ?? null, entry.name).toBe(entry.target)
        }
    })

    test('every note of the list exists for a case to find', () => {
        for (const entry of cases.targets.cases) {
            expect(cases.targets.notes, entry.name).toContain(entry.from)
            if (entry.target !== null) {
                expect(cases.targets.notes, entry.name).toContain(entry.target)
            }
        }
    })
})

describe('links of a note', () => {
    test.each(cases.links.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
        const links = linksOf(
            entry.text,
            entry.from,
            new LinkIndex(entry.notes),
            new Set(entry.ignored)
        )
        expect(links).toEqual(entry.links)
    })

    test('two lists are the same only with the same items in the same order', () => {
        const one = { link: 'Alpha', path: 'Alpha.md' }
        const two = { link: 'Beta', path: 'Folder/Beta.md' }
        expect(sameLinks([], [])).toBe(true)
        expect(sameLinks([one, two], [{ ...one }, { ...two }])).toBe(true)
        expect(sameLinks([one, two], [two, one])).toBe(false)
        expect(sameLinks([one], [one, two])).toBe(false)
        expect(sameLinks([one], [{ link: 'Alpha', path: 'Other/Alpha.md' }])).toBe(false)
        expect(sameLinks([one], [{ link: 'alpha', path: 'Alpha.md' }])).toBe(false)
    })

    test('the shared file has cases of each kind', () => {
        expect(cases.linkPaths.length).toBeGreaterThan(12)
        expect(cases.targets.cases.length).toBeGreaterThan(25)
        expect(cases.links.length).toBeGreaterThan(2)
    })
})
