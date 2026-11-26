import { describe, expect, test } from 'bun:test'
import {
    CURL_WRITE_OUT,
    hasTiming,
    locationsOf,
    sampleOf,
    summaryOf,
    type Sample
} from './first-request.ts'
import { NEW_INSTANCE_TIMING } from './worker.ts'

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

    test('judges the first requests and keeps the others apart', () => {
        const samples = [
            ...Array.from({ length: 20 }, (_, index) => sample(80 + index, true)),
            ...Array.from({ length: 30 }, () => sample(60, false)),
            sample(500, false, 500)
        ]
        const summary = summaryOf(samples)
        expect(summary.requests).toBe(51)
        expect(summary.newInstances).toBe(20)
        expect(summary.share).toBe(0.392)
        expect(summary.first.verdict).toBe('pass')
        expect(summary.first.p95).toBe(98)
        expect(summary.firstAfterHandshake.p95).toBe(58)
        expect(summary.later).toEqual({ count: 31, p50: 60, p95: 60, max: 500 })
        expect(summary.notOk).toBe(1)
    })

    test('no request gives no share and no verdict', () => {
        const summary = summaryOf([])
        expect(summary.share).toBe(0)
        expect(summary.first.verdict).toBe('too few')
    })
})
