import { describe, expect, test } from 'bun:test'
import {
    CURL_WRITE_OUT,
    floorConfiguration,
    floorWorkerName,
    hasTiming,
    locationsOf,
    sampleOf,
    summaryOf,
    workersDevAddress,
    type Sample
} from './first-request.ts'
import { NEW_INSTANCE_TIMING } from './instance.ts'

// The check of the first request of a new instance (issue 121, PERF-29).

describe('the marker of a new instance', () => {
    test('is an entry of Server-Timing, alone or among others', () => {
        expect(hasTiming(NEW_INSTANCE_TIMING, NEW_INSTANCE_TIMING)).toBe(true)
        expect(hasTiming(`cfL4;desc="x", ${NEW_INSTANCE_TIMING}`, NEW_INSTANCE_TIMING)).toBe(true)
        expect(hasTiming('instance; desc=new', NEW_INSTANCE_TIMING)).toBe(true)
        expect(hasTiming(`${NEW_INSTANCE_TIMING};dur=3`, NEW_INSTANCE_TIMING)).toBe(true)
    })

    test('another entry is no marker', () => {
        expect(hasTiming('', NEW_INSTANCE_TIMING)).toBe(false)
        expect(hasTiming('instance;desc=newer', NEW_INSTANCE_TIMING)).toBe(false)
        expect(hasTiming('cfL4;desc="instance;desc=new"', NEW_INSTANCE_TIMING)).toBe(false)
    })
})

describe('a sample from the output of curl', () => {
    test('the write-out asks for the status, the times and the header', () => {
        expect(CURL_WRITE_OUT).toContain('%{time_starttransfer}')
        expect(CURL_WRITE_OUT).toContain('%header{server-timing}')
    })

    test('reads the status, the times in milliseconds and the marker', () => {
        const output = `200 0.041250 0.093500\n${NEW_INSTANCE_TIMING}\n`
        expect(sampleOf(output, '/A', 7, NEW_INSTANCE_TIMING)).toEqual({
            path: '/A',
            status: 200,
            connected: 41.25,
            firstByte: 93.5,
            newInstance: true,
            at: 7
        })
    })

    test('an answer with no header met an instance that was there', () => {
        expect(sampleOf('404 0.04 0.07\n\n', '/B', 0, NEW_INSTANCE_TIMING)?.newInstance).toBe(false)
    })

    test('a failed curl gives no sample', () => {
        expect(sampleOf('', '/C', 0, NEW_INSTANCE_TIMING)).toBeUndefined()
        expect(sampleOf('000 0 x\n', '/C', 0, NEW_INSTANCE_TIMING)).toBeUndefined()
    })
})

describe('the addresses of a sitemap', () => {
    test('reads each loc, with its entities', () => {
        const xml =
            '<sitemapindex><sitemap><loc>https://h.example/sitemap-a.xml</loc></sitemap>' +
            '<sitemap><loc> https://h.example/A+%26+B?x=1&amp;y=2 </loc></sitemap></sitemapindex>'
        expect(locationsOf(xml)).toEqual([
            'https://h.example/sitemap-a.xml',
            'https://h.example/A+%26+B?x=1&y=2'
        ])
    })
})

describe('the summary of a run', () => {
    const sample = (firstByte: number, newInstance: boolean, status = 200): Sample => ({
        path: '/',
        status,
        connected: 40,
        firstByte,
        newInstance,
        at: 0
    })
    const run = (first: number, count: number, later: number): Sample[] => [
        ...Array.from({ length: count }, (_, index) => sample(first + index, true)),
        ...Array.from({ length: 30 }, () => sample(later, false))
    ]

    test('judges what the map adds to the first requests of the floor, and keeps the others apart', () => {
        const host = [...run(180, 20, 60), sample(500, false, 500)]
        const floor = run(130, 20, 55)
        const summary = summaryOf(host, floor)
        expect(summary.host.requests).toBe(51)
        expect(summary.host.newInstances).toBe(20)
        expect(summary.host.share).toBe(0.392)
        expect(summary.host.afterHandshake.p95).toBe(158)
        expect(summary.host.later).toEqual({ count: 31, p50: 60, p95: 60, max: 500 })
        expect(summary.host.notOk).toBe(1)
        expect(summary.floor.newInstances).toBe(20)
        expect(summary.first.host.p95).toBe(198)
        expect(summary.first.floor.p95).toBe(148)
        expect(summary.first.added).toBe(50)
        expect(summary.first.verdict).toBe('pass')
    })

    test('no request gives no share and no verdict', () => {
        const summary = summaryOf([], [])
        expect(summary.host.share).toBe(0)
        expect(summary.first.verdict).toBe('too few')
    })
})

describe('the floor Worker of a run', () => {
    test('has a name of its own, next to the Worker of the host', () => {
        expect(floorWorkerName('notes-preview', 'a1b2c3')).toBe('notes-preview-floor-a1b2c3')
        // A name of the host is at most 63 characters.
        expect(floorWorkerName('n'.repeat(63), 'a1b2c3')).toBe(`${'n'.repeat(50)}-floor-a1b2c3`)
    })

    test('is a Worker on the workers.dev name of the account, with no route, that runs first', () => {
        const account = 'ab'.repeat(16)
        expect(
            floorConfiguration({
                accountId: account,
                name: 'w-floor-a1b2c3',
                main: '/m.ts',
                dist: '/d'
            })
        ).toEqual({
            name: 'w-floor-a1b2c3',
            account_id: account,
            main: '/m.ts',
            compatibility_date: '2026-11-01',
            workers_dev: true,
            preview_urls: false,
            assets: {
                directory: '/d',
                binding: 'ASSETS',
                html_handling: 'none',
                not_found_handling: 'none',
                run_worker_first: true
            }
        })
    })

    test('its address is the one that wrangler prints', () => {
        expect(
            workersDevAddress(
                'Uploaded w-floor-a1b2c3\n  https://w-floor-a1b2c3.someone.workers.dev\n'
            )
        ).toBe('https://w-floor-a1b2c3.someone.workers.dev')
        expect(workersDevAddress('no address')).toBeUndefined()
    })
})
