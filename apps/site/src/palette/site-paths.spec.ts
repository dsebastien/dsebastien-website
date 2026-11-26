import { describe, expect, test } from 'bun:test'
import {
    canonicalPath,
    LIBRARY_PATH,
    markdownPath,
    recentPath,
    SEARCH_PATH
} from '@dsebastien-website/resolver'
import { FULL_TEXT_BASE, TITLES_FOLDER } from '../search/paths.ts'
import * as paths from './site-paths.ts'

// The paths of the palette are the paths of the resolver and of the search.
describe('the paths of the palette', () => {
    test('are the paths of the resolver and of the files of the search', () => {
        expect(paths.SEARCH_PAGE).toBe(SEARCH_PATH)
        expect(paths.TITLES).toBe(TITLES_FOLDER)
        expect(paths.FULL_TEXT).toBe(FULL_TEXT_BASE)
        expect(paths.RECENT_ADDED).toBe(recentPath('added', 1))
        expect(paths.RECENT_UPDATED).toBe(recentPath('updated', 1))
        expect(paths.LIBRARY).toBe(LIBRARY_PATH)
        for (const note of ['10 Garden/Rain barrel.md', 'Ça + ça/Été 2024.md']) {
            expect(paths.markdownOf(canonicalPath(note))).toBe(markdownPath(note))
        }
    })
})
