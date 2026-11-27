import { describe, expect, test } from 'bun:test'
import { musicProperties, propertiesText } from './page.ts'

describe('musicProperties', () => {
    test('keeps only the properties that an empty block draws from', () => {
        expect(
            musicProperties({
                tags: ['type/music/guitar/chord'],
                chord_symbol: 'Am',
                frets: 'x02210',
                rating: 4
            })
        ).toEqual({ tags: ['type/music/guitar/chord'], chord_symbol: 'Am', frets: 'x02210' })
    })

    test('a note with nothing but its tags gives none', () => {
        expect(musicProperties({ tags: ['type/song'], created: '2031-03-11' })).toBeUndefined()
    })
})

describe('propertiesText', () => {
    test('no text of a property ends the data block early', () => {
        const text = propertiesText({ chord_symbol: '</script><b>' })
        expect(text).not.toContain('<')
        expect(JSON.parse(text)).toEqual({ chord_symbol: '</script><b>' })
    })
})
