import { describe, expect, test } from 'bun:test'
import { attachmentPath, backlinksPath, canonicalPath, tagPath } from './url.ts'

// URL-01 of the spec: the canonical URL of a note is the URL that it has
// today. Each segment of the vault path is percent-encoded, then `%20` is
// written as `+`. A literal `+` in a name is `%2B`.
//
// The expected paths are written by hand, with the UTF-8 bytes of each
// character.
describe('canonical path of a note', () => {
    test.each([
        [
            'a note in a folder',
            '10 Garden/Frost dates explained.md',
            '/10+Garden/Frost+dates+explained'
        ],
        ['a note at the root', 'Welcome.md', '/Welcome'],
        [
            'a folder with a dot',
            '20 Library/20.02 Recipes/Mint.md',
            '/20+Library/20.02+Recipes/Mint'
        ],
        ['a literal plus', 'Salt + pepper crust.md', '/Salt+%2B+pepper+crust'],
        ['a percent sign', '100% rye bread.md', '/100%25+rye+bread'],
        ['an ampersand', 'Bread & butter pickles.md', '/Bread+%26+butter+pickles'],
        [
            'accents and an apostrophe',
            "Crème brûlée à l'érable.md",
            "/Cr%C3%A8me+br%C3%BBl%C3%A9e+%C3%A0+l'%C3%A9rable"
        ],
        ['an ending like a file extension', 'Sprout.js.md', '/Sprout.js'],
        ['a name with no ASCII letter', '日本の庭.md', '/%E6%97%A5%E6%9C%AC%E3%81%AE%E5%BA%AD'],
        ['a character above U+FFFF', '🌱 Seedlings.md', '/%F0%9F%8C%B1+Seedlings']
    ])('%s', (_case, vaultPath, expected) => {
        expect(canonicalPath(vaultPath)).toBe(expected)
    })

    test('is refused for a path that is not a note', () => {
        expect(() => canonicalPath('Attachments/garden-plan.png')).toThrow('note')
    })
})

// URL-15 of the spec, first part: the content-hashed URL of an attachment,
// which pages use. It keeps the readable name of the file. The stable URL
// that follows the vault path comes with the slice of the URL contract.
describe('hashed path of an attachment', () => {
    const KEY = 'a9526809f9da4f3a083bceb07247ac2633b41de1ddf9cad8d37e0a518b550a33'

    test.each([
        ['a plain name', 'Attachments/garden-plan.png', `/-/attachments/${KEY}/garden-plan.png`],
        ['a name with a space', 'Pond video.mp4', `/-/attachments/${KEY}/Pond%20video.mp4`],
        [
            'a literal plus and a percent sign',
            'a+b 100%.pdf',
            `/-/attachments/${KEY}/a%2Bb%20100%25.pdf`
        ],
        ['a name outside ASCII', 'Plans/Étang.webp', `/-/attachments/${KEY}/%C3%89tang.webp`]
    ])('%s', (_case, vaultPath, expected) => {
        expect(attachmentPath(`sha256:${KEY}`, vaultPath)).toBe(expected)
    })

    test('is refused for a hash in another form', () => {
        expect(() => attachmentPath('sha256:../../etc', 'a.png')).toThrow('hash')
        expect(() => attachmentPath(KEY, 'a.png')).toThrow('hash')
    })
})

// The page of a tag (NAV-04): a tag of the text of a note and a tag of its
// properties lead to the same path, in small letters, one segment per level.
describe('path of the page of a tag', () => {
    test.each([
        ['a plain tag', 'garden', '/-/tags/garden'],
        ['a tag with levels', 'topic/water', '/-/tags/topic/water'],
        ['capital letters', 'Topic/Water', '/-/tags/topic/water'],
        ['a letter outside ASCII', 'ÉTÉ', '/-/tags/%C3%A9t%C3%A9'],
        ['an underscore and a hyphen', 'type/permanent_note-v2', '/-/tags/type/permanent_note-v2']
    ])('%s', (_case, tag, expected) => {
        expect(tagPath(tag)).toBe(expected)
    })
})

// The page with every backlink of a note (PAGE-03): a generated page, named
// by the identity of the note.
describe('path of the page with the backlinks of a note', () => {
    test('is under the prefix of the generated pages, with the identity of the note', () => {
        expect(backlinksPath('203d446940c02032')).toBe('/-/backlinks/203d446940c02032')
    })

    test('is refused for a text that is not the identity of a note', () => {
        expect(() => backlinksPath('../203d446940c02032')).toThrow('identity')
        expect(() => backlinksPath('Garden')).toThrow('identity')
    })
})
