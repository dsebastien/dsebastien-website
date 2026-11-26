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

// The paths of the palette are the paths of the resolver and of the search:
// every export of `site-paths.ts` has its twin here, so a new one needs a check.
const TWINS: Record<string, string> = {
    HOME: '/',
    SEARCH_PAGE: SEARCH_PATH,
    TITLES: TITLES_FOLDER,
    FULL_TEXT: FULL_TEXT_BASE,
    RECENT_ADDED: recentPath('added', 1),
    RECENT_UPDATED: recentPath('updated', 1),
    LIBRARY: LIBRARY_PATH
}

describe('the paths of the palette', () => {
    test('every export is a path of the resolver or of the files of the search', () => {
        expect(Object.keys(paths).sort()).toEqual([...Object.keys(TWINS), 'markdownOf'].sort())
        for (const [name, value] of Object.entries(paths)) {
            if (typeof value === 'function') {
                for (const note of ['10 Garden/Rain barrel.md', 'Ça + ça/Été 2024.md']) {
                    expect(value(canonicalPath(note)), name).toBe(markdownPath(note))
                }
            } else {
                expect(value, name).toBe(TWINS[name] ?? '')
            }
        }
    })
})
