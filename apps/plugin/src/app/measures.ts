// The measures of the budgets that are checked by hand in Obsidian (section
// 16.1 of the spec, PERF-17). No automated test can see the interface of
// Obsidian, so the plugin records the numbers, and the author copies them
// into the checklist (decision R67). The values of the budgets are a later
// decision of the author.

/** The measures, in the order of the checklist. */
const MEASURES = [
    ['load', 'PERF-06', 'Time that the plugin adds to the start of Obsidian'],
    ['open', 'PERF-01', 'Open the publication center: the lists with their counts on screen'],
    ['start', 'PERF-04', 'Click on Publish: the message that the publication started'],
    ['pause', 'PERF-05', 'Longest time during which Obsidian did not answer'],
    ['filter', 'PERF-07', 'A change of a filter or of a tick: the list on screen']
] as const

export type MeasureName = (typeof MEASURES)[number][0]

export interface MeasureRow {
    readonly id: string
    readonly name: MeasureName
    readonly label: string
    /** The last value, in whole milliseconds. */
    readonly last: number | undefined
    readonly longest: number | undefined
    readonly count: number
}

export class Measures {
    readonly #values = new Map<MeasureName, { last: number; longest: number; count: number }>()

    /** Records one value of a measure, in milliseconds. */
    record(name: MeasureName, milliseconds: number): void {
        const value = Math.round(milliseconds)
        const kept = this.#values.get(name)
        this.#values.set(name, {
            last: value,
            longest: Math.max(value, kept?.longest ?? 0),
            count: (kept?.count ?? 0) + 1
        })
    }

    rows(): MeasureRow[] {
        return MEASURES.map(([name, id, label]) => {
            const kept = this.#values.get(name)
            return {
                id,
                name,
                label,
                last: kept?.last,
                longest: kept?.longest,
                count: kept?.count ?? 0
            }
        })
    }

    /** The measures as lines of text, for the checklist. */
    text(): string {
        return this.rows()
            .map(
                (row) =>
                    `${row.id} ${row.label}: ${
                        row.last === undefined || row.longest === undefined
                            ? 'not measured'
                            : `last ${String(row.last)} ms, longest ${String(row.longest)} ms (${String(row.count)} ${row.count === 1 ? 'time' : 'times'})`
                    }`
            )
            .join('\n')
    }
}
