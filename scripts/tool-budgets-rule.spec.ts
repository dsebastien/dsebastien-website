import { describe, expect, test } from 'bun:test'
import {
    ceilingOf,
    impliedFactor,
    machineFactor,
    median,
    REAL_VAULT_NOTES,
    TOOL_BUDGETS,
    type ToolBudget
} from './tool-budgets-rule.ts'

const STATUS_RUST: ToolBudget = {
    id: 'PERF-03',
    command: 'status',
    implementation: 'rust',
    seconds: 15,
    measured: 8.97
}

describe('the rule of the budgets of the publishing tool', () => {
    test('holds the budgets of R97', () => {
        const seconds = Object.fromEntries(
            TOOL_BUDGETS.map((budget) => [
                `${budget.command} ${budget.implementation}`,
                budget.seconds
            ])
        )
        expect(seconds).toEqual({
            'status rust': 15,
            'status typescript': 30,
            'plan rust': 20,
            'plan typescript': 30
        })
    })

    test('scales the budget by the size of the corpus and by the factor of the machine', () => {
        expect(ceilingOf(STATUS_RUST, REAL_VAULT_NOTES, 1)).toBe(15)
        expect(ceilingOf(STATUS_RUST, REAL_VAULT_NOTES / 2, 1)).toBe(7.5)
        expect(ceilingOf(STATUS_RUST, REAL_VAULT_NOTES / 2, 2)).toBe(15)
    })

    test('never makes the ceiling stricter on a machine faster than the calibration', () => {
        expect(machineFactor(0.5, 1)).toBe(1)
        expect(machineFactor(1, 1)).toBe(1)
        expect(machineFactor(3, 1.5)).toBe(2)
    })

    test('refuses a time of zero or less', () => {
        expect(() => machineFactor(0, 1)).toThrow()
        expect(() => machineFactor(1, 0)).toThrow()
        expect(() => machineFactor(Number.NaN, 1)).toThrow()
    })

    test('takes the median of an odd and of an even number of times', () => {
        expect(median([3, 1, 2])).toBe(2)
        expect(median([4, 1, 3, 2])).toBe(2.5)
        expect(median([7])).toBe(7)
        expect(() => median([])).toThrow()
    })
})

describe('the factor that a measure implies', () => {
    test('is 1 for the measure of the author scaled to the corpus', () => {
        expect(impliedFactor(STATUS_RUST, REAL_VAULT_NOTES / 2, 8.97 / 2)).toBeCloseTo(1, 10)
    })

    test('is 2 for a measure two times slower', () => {
        expect(impliedFactor(STATUS_RUST, REAL_VAULT_NOTES, 17.94)).toBeCloseTo(2, 10)
    })
})
