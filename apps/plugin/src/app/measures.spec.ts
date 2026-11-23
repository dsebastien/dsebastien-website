import { describe, expect, test } from 'bun:test'
import { Measures } from './measures.ts'

// The measures of the budgets that are checked by hand in Obsidian (PERF-01,
// PERF-04 to PERF-07, PERF-17): the plugin records them, and the checklist
// reads them (decision R67).

describe('the measures of the budgets by hand', () => {
    test('keep the last, the longest and the number of each measure, in milliseconds', () => {
        const measures = new Measures()
        measures.record('filter', 12.4)
        measures.record('filter', 30.6)
        measures.record('filter', 8)
        measures.record('load', 3.2)

        expect(measures.rows()).toEqual([
            {
                id: 'PERF-06',
                name: 'load',
                label: 'Time that the plugin adds to the start of Obsidian',
                last: 3,
                longest: 3,
                count: 1
            },
            {
                id: 'PERF-01',
                name: 'open',
                label: 'Open the publication center: the lists with their counts on screen',
                last: undefined,
                longest: undefined,
                count: 0
            },
            {
                id: 'PERF-04',
                name: 'start',
                label: 'Click on Publish: the message that the publication started',
                last: undefined,
                longest: undefined,
                count: 0
            },
            {
                id: 'PERF-05',
                name: 'pause',
                label: 'Longest time during which Obsidian did not answer',
                last: undefined,
                longest: undefined,
                count: 0
            },
            {
                id: 'PERF-07',
                name: 'filter',
                label: 'A change of a filter or of a tick: the list on screen',
                last: 8,
                longest: 31,
                count: 3
            }
        ])
    })

    test('give a text to copy into the checklist', () => {
        const measures = new Measures()
        measures.record('open', 250)
        measures.record('pause', 61)

        expect(measures.text()).toBe(
            [
                'PERF-06 Time that the plugin adds to the start of Obsidian: not measured',
                'PERF-01 Open the publication center: the lists with their counts on screen: last 250 ms, longest 250 ms (1 time)',
                'PERF-04 Click on Publish: the message that the publication started: not measured',
                'PERF-05 Longest time during which Obsidian did not answer: last 61 ms, longest 61 ms (1 time)',
                'PERF-07 A change of a filter or of a tick: the list on screen: not measured'
            ].join('\n')
        )
    })
})
