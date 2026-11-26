import { describe, expect, test } from 'bun:test'
import { errorFormat, errorText } from './errors.ts'

// The form of an error answer (NAV-21, decision R64): an agent that asks for
// the Markdown form gets a short text, a browser gets the page.
describe('form of an error answer', () => {
    test.each([
        ['no Accept header', '/Nothing', null, 'html'],
        [
            'the header of a browser',
            '/Nothing',
            'text/html,application/xhtml+xml,*/*;q=0.8',
            'html'
        ],
        ['any type', '/Nothing', '*/*', 'html'],
        ['any text', '/Nothing', 'text/*', 'html'],
        ['Markdown alone', '/Nothing', 'text/markdown', 'markdown'],
        ['Markdown before HTML', '/Nothing', 'text/markdown, text/html;q=0.9', 'markdown'],
        [
            'Markdown and HTML with the same weight',
            '/Nothing',
            'text/html, text/markdown',
            'markdown'
        ],
        ['HTML before Markdown', '/Nothing', 'text/html, text/markdown;q=0.5', 'html'],
        ['any text before Markdown', '/Nothing', 'text/*, text/markdown;q=0.5', 'html'],
        ['Markdown refused', '/Nothing', 'text/markdown;q=0', 'html'],
        [
            'Markdown in capital letters, with spaces',
            '/Nothing',
            ' Text/Markdown ; Q=1 ',
            'markdown'
        ],
        ['Markdown with a character set', '/Nothing', 'text/markdown; charset=utf-8', 'markdown'],
        ['a weight that is not a number', '/Nothing', 'text/markdown;q=high', 'html'],
        ['a weight above 1', '/Nothing', 'text/markdown;q=2', 'html'],
        ['XHTML before Markdown', '/Nothing', 'application/xhtml+xml, text/markdown;q=0.9', 'html'],
        [
            'Markdown before XHTML',
            '/Nothing',
            'application/xhtml+xml;q=0.5, text/markdown',
            'markdown'
        ],
        [
            'a quoted parameter with a comma and a semicolon',
            '/Nothing',
            'text/html;q=0.1;x="a,b;q=1", text/markdown',
            'markdown'
        ],
        [
            'a range with a parameter of another character set',
            '/Nothing',
            'text/markdown;charset=latin1;q=0, text/markdown',
            'markdown'
        ],
        [
            'a range of the same character set wins over the bare range',
            '/Nothing',
            'text/markdown;charset=UTF-8;q=0, text/markdown',
            'html'
        ],
        [
            'the bare range wins over the group',
            '/Nothing',
            'text/*;q=0.1, text/markdown;q=0.2, text/html;q=0.1',
            'markdown'
        ],
        ['Markdown of a variant (RFC 7763)', '/Nothing', 'text/markdown;variant=GFM', 'markdown'],
        [
            'Markdown of a variant in UTF-8',
            '/Nothing',
            'text/markdown; variant=CommonMark; charset=UTF-8',
            'markdown'
        ],
        ['UTF-8 written without its dash', '/Nothing', 'text/markdown;charset=utf8', 'markdown'],
        [
            'a parameter after the weight is no parameter of the type',
            '/Nothing',
            'text/markdown;q=0.5;charset=latin1',
            'markdown'
        ],
        [
            'a Markdown range of another character set gives no weight to Markdown',
            '/Nothing',
            'text/markdown;charset=latin1;q=0.5, */*;q=0.4',
            'html'
        ],
        ['the old name of Markdown', '/Nothing', 'text/x-markdown', 'markdown'],
        [
            'the old name of Markdown after HTML',
            '/Nothing',
            'text/html, text/x-markdown;q=0.5',
            'html'
        ],
        [
            'the old name of Markdown refused before the new name',
            '/Nothing',
            'text/x-markdown;q=0, text/markdown',
            'markdown'
        ],
        [
            'the new name of Markdown refused: the old name does not count',
            '/Nothing',
            'text/markdown;q=0, text/x-markdown',
            'html'
        ],
        [
            'the weight of the new name, not the higher weight of the old name',
            '/Nothing',
            'text/markdown;q=0.5, text/x-markdown, text/html;q=0.8',
            'html'
        ],
        [
            'the old name of Markdown, refused, with any text',
            '/Nothing',
            'text/x-markdown;q=0, text/*',
            'html'
        ],
        [
            'both names of Markdown refused',
            '/Nothing',
            'text/markdown;q=0, text/x-markdown;q=0',
            'html'
        ],
        ['a Markdown path', '/-/md/Nothing.md', null, 'markdown'],
        ['a Markdown path, asked as HTML', '/-/md/Nothing.md', 'text/html', 'markdown']
    ] as const)('%s', (_name, path, accept, format) => {
        expect(errorFormat(path, accept)).toBe(format)
    })
})

describe('short text of an error answer', () => {
    const ORIGIN = 'https://notes.example.invalid'

    test('says what happened and where to go on, with absolute addresses', () => {
        expect(errorText(404, ORIGIN)).toBe(
            '# Not found\n\nNo note has this address. It may have moved, or it was never published.\n\n' +
                'Start at the home page: [https://notes.example.invalid/](<https://notes.example.invalid/>)\n\n' +
                'Search the notes in a browser: [https://notes.example.invalid/-/search](<https://notes.example.invalid/-/search>)\n'
        )
        expect(errorText(410, ORIGIN)).toBe(
            '# Removed\n\nThe note that had this address was removed. It is no longer published.\n\n' +
                'Start at the home page: [https://notes.example.invalid/](<https://notes.example.invalid/>)\n\n' +
                'Search the notes in a browser: [https://notes.example.invalid/-/search](<https://notes.example.invalid/-/search>)\n'
        )
        // The sentence of the server error page.
        expect(errorText(500, ORIGIN)).toBe(
            '# Server error\n\nThe site could not give this page. Try again in a moment.\n\n' +
                'Start at the home page: [https://notes.example.invalid/](<https://notes.example.invalid/>)\n'
        )
    })

    // A file name or an alias of several notes (URL-04, R47).
    test('names the notes of a name of several notes', () => {
        expect(errorText(404, ORIGIN, ['/Garden/Mint', '/Kitchen/Mint'])).toBe(
            '# Not found\n\nNo note has this address. It may have moved, or it was never published.\n\n' +
                'These notes have this name:\n\n' +
                '- [https://notes.example.invalid/Garden/Mint](<https://notes.example.invalid/Garden/Mint>)\n' +
                '- [https://notes.example.invalid/Kitchen/Mint](<https://notes.example.invalid/Kitchen/Mint>)\n\n' +
                'Start at the home page: [https://notes.example.invalid/](<https://notes.example.invalid/>)\n\n' +
                'Search the notes in a browser: [https://notes.example.invalid/-/search](<https://notes.example.invalid/-/search>)\n'
        )
    })

    // A note name with a parenthesis or a mark of emphasis (canonicalPath
    // leaves `(`, `)`, `*` and `_` as they are).
    test('keeps each link whole and its text plain', () => {
        const text = errorText(404, ORIGIN, ['/Mint+(fresh', '/Mint)_*bold*'])
        expect(text).toContain(
            '- [https://notes.example.invalid/Mint+\\(fresh](<https://notes.example.invalid/Mint+(fresh>)\n'
        )
        expect(text).toContain(
            '- [https://notes.example.invalid/Mint\\)\\_\\*bold\\*](<https://notes.example.invalid/Mint)_*bold*>)\n'
        )
    })

    // A character reference of the text would show as another character.
    test('keeps an & of the text plain', () => {
        expect(errorText(404, 'https://a.invalid', ['/Mint&amp;'])).toContain(
            '- [https://a.invalid/Mint\\&amp;](<https://a.invalid/Mint\\&amp;>)\n'
        )
    })
})
