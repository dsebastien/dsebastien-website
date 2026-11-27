import { describe, expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { SOUNDS_FOLDER, SOUNDS_VERSION } from './sounds.ts'
import { installedSounds } from './sounds-integration.ts'

describe('the instrument files of the music', () => {
    test('their folder names the installed version of the pinned package', () => {
        const manifest: unknown = createRequire(import.meta.url)(
            '@dsebastien/music-notation-sounds/package.json'
        )
        expect(manifest).toMatchObject({ version: SOUNDS_VERSION })
        expect(SOUNDS_FOLDER).toBe(`_astro/music-notation-sounds-${SOUNDS_VERSION}/generaluser`)
    })

    test('the installed folder has the index of the instruments', async () => {
        expect(await Bun.file(join(installedSounds(), 'index.json')).exists()).toBe(true)
    })
})
