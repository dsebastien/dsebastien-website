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
        ['a Markdown path', '/-/md/Nothing.md', null, 'markdown'],
        ['a Markdown path, asked as HTML', '/-/md/Nothing.md', 'text/html', 'markdown']
    ] as const)('%s', (_name, path, accept, format) => {
        expect(errorFormat(path, accept)).toBe(format)
    })
})

describe('short text of an error answer', () => {
    test('says what happened and where to go on', () => {
        expect(errorText(404)).toBe(
            '# Not found\n\nNo note has this address. It may have moved, or it was never published.\n\n' +
                'Search the notes at /-/search, or start at the home page: /\n'
        )
        expect(errorText(410)).toBe(
            '# Removed\n\nThe note that had this address was removed. It is no longer published.\n\n' +
                'Search the notes at /-/search, or start at the home page: /\n'
        )
        expect(errorText(500)).toBe(
            '# Server error\n\nThe site could not give this answer. Try again later.\n\n' +
                'The home page: /\n'
        )
    })

    // A file name or an alias of several notes (URL-04, R47).
    test('names the notes of a name of several notes', () => {
        expect(errorText(404, ['/Garden/Mint', '/Kitchen/Mint'])).toBe(
            '# Not found\n\nNo note has this address. It may have moved, or it was never published.\n\n' +
                'These notes have this name:\n\n- /Garden/Mint\n- /Kitchen/Mint\n\n' +
                'Search the notes at /-/search, or start at the home page: /\n'
        )
    })
})
