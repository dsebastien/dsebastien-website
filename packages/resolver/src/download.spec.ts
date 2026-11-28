import { describe, expect, test } from 'bun:test'
import {
    contentDisposition,
    downloadName,
    downloadNameOf,
    markdownDownloadPath
} from './download.ts'

// The download of the Markdown form of a note (issue 137): the file name that
// every file system takes, and the address of the download.

describe('the file name of a download', () => {
    test('is the title of the note with .md', () => {
        expect(downloadName('Rain barrel')).toBe('Rain barrel.md')
        expect(downloadName('Été à Liège 🌧')).toBe('Été à Liège 🌧.md')
    })

    test('has a hyphen for each character that a file system refuses', () => {
        expect(downloadName('a<b>c:d"e/f\\g|h?i*j')).toBe('a-b-c-d-e-f-g-h-i-j.md')
        expect(downloadName('tab\there\u0000\u001f\u007f')).toBe('tab-here---.md')
    })

    test('has a hyphen for each mark that turns the direction of the text, and keeps a joiner', () => {
        expect(downloadName('a‮b‎c⁦d‏e‪f⁩g')).toBe('a-b-c-d-e-f-g.md')
        expect(downloadName('Farmer \u{1f469}‍\u{1f33e}')).toBe('Farmer \u{1f469}‍\u{1f33e}.md')
    })

    test('has a hyphen for a dot or a space at the end of the title', () => {
        expect(downloadName('Why not.')).toBe('Why not-.md')
        expect(downloadName('Wait...')).toBe('Wait---.md')
        expect(downloadName('Space ')).toBe('Space-.md')
    })

    test('gives a reserved name of Windows a suffix, in any case and with a dot after it', () => {
        expect(downloadName('CON')).toBe('CON-note.md')
        expect(downloadName('nul')).toBe('nul-note.md')
        expect(downloadName('Com1')).toBe('Com1-note.md')
        expect(downloadName('LPT9.old')).toBe('LPT9-note.old.md')
        expect(downloadName('CON .txt')).toBe('CON-note .txt.md')
        expect(downloadName('conin$')).toBe('conin$-note.md')
        expect(downloadName('CONOUT$.log')).toBe('CONOUT$-note.log.md')
        expect(downloadName('CONTENT')).toBe('CONTENT.md')
        expect(downloadName('Console')).toBe('Console.md')
    })

    test('is "note.md" for a title with no text', () => {
        expect(downloadName('')).toBe('note.md')
        expect(downloadName('   ')).toBe('note.md')
    })

    test('stays inside 255 bytes of UTF-8, and never cuts a character', () => {
        const name = downloadName('é'.repeat(300))
        expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255)
        expect(name).toBe(`${'é'.repeat(126)}.md`)
        const emoji = downloadName('🌧'.repeat(100))
        expect(emoji).toBe(`${'🌧'.repeat(63)}.md`)
    })

    test('never cuts a group of characters that shows as one', () => {
        const farmer = '\u{1f469}‍\u{1f33e}'
        expect(downloadName(farmer.repeat(30))).toBe(`${farmer.repeat(22)}.md`)
    })

    test('does not change a name that it gave', () => {
        for (const title of ['Why not.', 'CON', 'a/b', 'é'.repeat(300), 'Rain barrel']) {
            const name = downloadName(title)
            expect(downloadName(name.slice(0, -'.md'.length))).toBe(name)
        }
    })
})

describe('the address of a download', () => {
    test('is the Markdown path with the file name in the query', () => {
        expect(markdownDownloadPath('10 Garden/Rain barrel.md', 'Rain barrel')).toBe(
            '/-/md/10+Garden/Rain+barrel.md?download=Rain%20barrel.md'
        )
        expect(markdownDownloadPath('A.md', 'R&D: 100% #1?')).toBe(
            '/-/md/A.md?download=R%26D-%20100%25%20%231-.md'
        )
    })
})

describe('the file name that a request asks for', () => {
    test('is the safe name of its query, or nothing without a download', () => {
        expect(downloadNameOf('/-/md/A.md', '')).toBeUndefined()
        expect(downloadNameOf('/-/md/A.md', '?ref=letter')).toBeUndefined()
        expect(downloadNameOf('/-/md/A.md', '?download=Rain%20barrel.md')).toBe('Rain barrel.md')
        expect(downloadNameOf('/-/md/A.md', '?ref=x&download=a%2Fb%3F')).toBe('a-b-.md')
    })

    test('is the file name of the path when the query names none', () => {
        expect(downloadNameOf('/-/md/10+Garden/Rain+barrel.md', '?download')).toBe('Rain barrel.md')
        expect(downloadNameOf('/-/md/100%25+rain%3F.md', '?download=')).toBe('100% rain-.md')
    })
})

describe('the header of a download', () => {
    test('says attachment, with an ASCII name first, then the name in UTF-8 with its marks encoded', () => {
        expect(contentDisposition("Été (l'an) *1*.md")).toBe(
            `attachment; filename="_t_ (l'an) *1*.md"; ` +
                "filename*=UTF-8''%C3%89t%C3%A9%20%28l%27an%29%20%2A1%2A.md"
        )
    })

    // RFC 6266, section 4.3: a client that does not read `filename*` reads `filename`.
    test('has a low line in the ASCII name for a quote, a backslash and each other character', () => {
        expect(contentDisposition('a"b\\c\u{1f327}.md')).toBe(
            `attachment; filename="a_b_c_.md"; filename*=UTF-8''a%22b%5Cc%F0%9F%8C%A7.md`
        )
    })
})
