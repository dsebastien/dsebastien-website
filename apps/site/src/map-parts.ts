import type { AstroIntegration } from 'astro'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    MAP_HEAD_FILE,
    MAP_PARTS_FOLDER,
    mapPartFile,
    mapPartsOf,
    PART_BYTES,
    RESOLVER_MAP_FILE,
    resolverMapFrom
} from '@dsebastien-website/resolver'

// The resolver map in parts (issue 121, R94): after each build, the whole map
// that the build wrote (`-/resolver-map.json`) is cut into a head and parts
// (`-/resolver-map/`). The hosts read the parts; the checks of the build and
// the tests read the whole map, which the deployment does not upload.

/** Writes the head and the parts of the resolver map of an output, in place of the ones before. */
export async function writeMapParts(output: string, bytes = PART_BYTES): Promise<void> {
    const map = resolverMapFrom(JSON.parse(await readFile(join(output, RESOLVER_MAP_FILE), 'utf8')))
    const { head, parts } = mapPartsOf(map, bytes)
    const folder = join(output, ...MAP_PARTS_FOLDER.split('/'))
    await rm(folder, { recursive: true, force: true })
    await mkdir(folder, { recursive: true })
    await writeFile(join(output, ...MAP_HEAD_FILE.split('/')), `${JSON.stringify(head)}\n`)
    for (const [index, part] of parts.entries()) {
        await writeFile(join(output, ...mapPartFile(index).split('/')), `${JSON.stringify(part)}\n`)
    }
}

/** The Astro integration that writes the resolver map in parts after each build. */
export function resolverMapParts(): AstroIntegration {
    return {
        name: 'resolver-map-parts',
        hooks: {
            'astro:build:done': async ({ dir }) => {
                await writeMapParts(fileURLToPath(dir))
            }
        }
    }
}
