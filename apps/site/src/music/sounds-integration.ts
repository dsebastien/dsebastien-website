import { cp } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AstroIntegration } from 'astro'
import { SOUNDS_FOLDER } from './sounds.ts'

/** The `generaluser` folder of the installed package of the sounds. */
export function installedSounds(): string {
    const manifest = createRequire(import.meta.url).resolve(
        '@dsebastien/music-notation-sounds/package.json'
    )
    return join(dirname(manifest), 'generaluser')
}

/**
 * The Astro integration that copies the instrument files into the output
 * after each build (REN-07, PERF-21): the site serves them itself, and no
 * page names another host for them.
 */
export function soundsFolder(): AstroIntegration {
    return {
        name: 'music-sounds',
        hooks: {
            'astro:build:done': async ({ dir }) => {
                await cp(installedSounds(), join(fileURLToPath(dir), ...SOUNDS_FOLDER.split('/')), {
                    recursive: true
                })
            }
        }
    }
}
