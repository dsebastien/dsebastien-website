import { describe, expect, test } from 'bun:test'
import { canonicalPath } from './url.ts'

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
