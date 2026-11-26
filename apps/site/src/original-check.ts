import { compareCodePoints } from '../../plugin/src/publishing/order.ts'
import {
    CHECK_CONCURRENCY,
    canonicalLinksOf,
    comparisonForm,
    judgePost,
    type Answer
} from '../../plugin/src/publishing/originals.ts'
import type { MainSite } from '../../plugin/src/publishing/ports.ts'

// The check of the originals between the two sites (IDX-15, the switch gate
// of ADR 0010): for each note that also exists on the main site, the notes
// page names the post in its canonical link, and the post names itself. If
// each site named the other, search engines would get a loop. It only reads:
// `bun run originals` runs it on a built site or on a host, against the live
// main site (`scripts/originals.ts`).

/** A note that also exists on the main site, for the check. */
export interface OriginalNote {
    readonly vaultPath: string
    /** The URL of the page of the note on the notes site. */
    readonly pageUrl: string
    /**
     * The post on the main site: the one that the tool verified, else the
     * one that the property `url` of the note names. None without either.
     */
    readonly post?: string
}

/** A note for which the two sites do not name the same URL. */
export interface OriginalFinding {
    readonly path: string
    readonly message: string
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/** What the check finds for one note, or `undefined` when the two sites name the post. */
async function findingOf(
    note: OriginalNote,
    notesPage: (note: OriginalNote) => Promise<string>,
    mainSite: MainSite
): Promise<string | undefined> {
    let page: string
    try {
        page = await notesPage(note)
    } catch (error) {
        return `the notes page ${note.pageUrl} cannot be read: ${messageOf(error)}`
    }
    const named = canonicalLinksOf(page, note.pageUrl)
    if (note.post === undefined) {
        return `the note has no post URL: the notes page names ${named.join(', ') || 'nothing'}`
    }
    const forms = new Set(named.map((link) => comparisonForm(link) ?? link))
    if (forms.size !== 1 || !forms.has(note.post)) {
        return `the notes page names ${named.join(', ') || 'nothing'}, not the post ${note.post}`
    }
    let answer: Answer
    try {
        answer = await mainSite.page(note.post)
    } catch (error) {
        answer = { failure: messageOf(error) }
    }
    const judged = judgePost(note.post, answer)
    return judged.verified ? undefined : judged.reason
}

/**
 * The notes for which the two sites do not name the same URL, sorted by
 * path, with at most `CHECK_CONCURRENCY` notes checked at one time. It reads
 * every page with `GET` only.
 *
 * @param notesPage the HTML of the page of a note on the notes site: from a
 * built site or from a host. It throws when the page cannot be read.
 */
export async function originalFindings(
    notes: readonly OriginalNote[],
    notesPage: (note: OriginalNote) => Promise<string>,
    mainSite: MainSite
): Promise<OriginalFinding[]> {
    const findings: OriginalFinding[] = []
    let next = 0
    const worker = async (): Promise<void> => {
        while (next < notes.length) {
            const note = notes[next]
            next += 1
            if (note === undefined) {
                return
            }
            const message = await findingOf(note, notesPage, mainSite)
            if (message !== undefined) {
                findings.push({ path: note.vaultPath, message })
            }
        }
    }
    await Promise.all(
        Array.from({ length: Math.min(CHECK_CONCURRENCY, notes.length) }, () => worker())
    )
    return findings.sort((one, two) => compareCodePoints(one.path, two.path))
}
