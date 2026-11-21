import type { NoteTypes } from '../publishing/ports.ts'

// The Obsidian Starter Kit plugin inside Obsidian, as the publishing logic
// needs it: the note type of each note (decision R61). The plugin of the
// Starter Kit answers through its API, `recognizeNoteTypes(paths)`, with the
// same document as its command line program (`osk-cli recognize`), which the
// Rust implementation runs. The logic reads the document strictly.

/** The id of the Starter Kit plugin in Obsidian. */
export const STARTER_KIT_ID = 'obsidian-starter-kit'

/** What this face reads of `app`: the plugins that Obsidian loaded. */
export interface PluginHost {
    readonly plugins: { readonly plugins: Readonly<Record<string, unknown>> }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

/**
 * The Starter Kit of a running Obsidian. Each question finds the plugin
 * again: it can be turned off, updated or turned on between two runs. It
 * throws when the plugin is not enabled, when it has no `recognizeNoteTypes`
 * (a version before the batch API), and when it gives no success.
 */
export function starterKitNoteTypes(app: PluginHost): NoteTypes {
    return {
        async recognize(paths) {
            const plugin = app.plugins.plugins[STARTER_KIT_ID]
            const api = isRecord(plugin) ? plugin['api'] : undefined
            const recognize = isRecord(api) ? api['recognizeNoteTypes'] : undefined
            if (typeof recognize !== 'function') {
                throw new Error(
                    plugin === undefined
                        ? 'the Obsidian Starter Kit plugin is not enabled in this vault'
                        : 'the Obsidian Starter Kit plugin has no recognizeNoteTypes: it needs a newer version'
                )
            }
            const result: unknown = await (
                recognize as (this: unknown, paths: string[]) => unknown
            ).call(api, [...paths])
            if (!isRecord(result) || result['success'] !== true) {
                const error = isRecord(result) ? result['error'] : undefined
                throw new Error(
                    `the Obsidian Starter Kit plugin gave an error: ${typeof error === 'string' ? error : 'no message'}`
                )
            }
            return result['data']
        }
    }
}
