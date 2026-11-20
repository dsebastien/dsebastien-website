import type { PublishedNote } from '../content-store.ts'

// Helpers of the prototype of issue 25: the outline of a rendered note and
// the backlinks of each note, from the manifest.

export interface OutlineItem {
    id: string
    label: string
    level: 2 | 3
}

/** The second and third level headings of a rendered note body, with their ids. */
export function outlineOf(html: string): OutlineItem[] {
    const items: OutlineItem[] = []
    for (const match of html.matchAll(/<h([23])[^>]*\sid="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g)) {
        const label = (match[3] ?? '').replace(/<[^>]+>/g, '').trim()
        items.push({ id: match[2] ?? '', label, level: match[1] === '3' ? 3 : 2 })
    }
    return items
}

export interface Backlink {
    title: string
    path: string
    /** The line of the linking note around the link, as plain text. */
    context: string
}

/** The backlinks of each note: at most `cap` shown, and the total. */
export function backlinksOf(
    notes: { note: PublishedNote; body: string }[],
    cap: number
): Map<string, { shown: Backlink[]; total: number }> {
    const result = new Map<string, { shown: Backlink[]; total: number }>()
    for (const { note, body } of notes) {
        const lines = body.split('\n')
        const seen = new Set<string>()
        for (const link of note.links) {
            if (seen.has(link.path) || link.path === note.vaultPath) {
                continue
            }
            seen.add(link.path)
            const line = lines.find((text) => text.includes(`[[${link.link}`)) ?? ''
            const plain = line
                .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
                .replace(/\[\[([^\]]+)\]\]/g, '$1')
                .replace(/[#>*_`-]+\s?/g, '')
                .trim()
            const context = plain.length > 220 ? `${plain.slice(0, 217)}…` : plain
            const entry = result.get(link.path) ?? { shown: [], total: 0 }
            entry.total += 1
            if (entry.shown.length < cap) {
                entry.shown.push({ title: note.title, path: note.path, context })
            }
            result.set(link.path, entry)
        }
    }
    return result
}
