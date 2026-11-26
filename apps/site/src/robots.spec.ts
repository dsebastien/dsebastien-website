import { describe, expect, test } from 'bun:test'
import { robotsText } from './robots.ts'

describe('robots.txt', () => {
    const text = robotsText('https://notes.example')

    // AI-01: every crawler, every URL; no `Disallow` line.
    test('allows every crawler on every URL', () => {
        expect(text.startsWith('User-agent: *\n')).toBe(true)
        expect(text).toContain('\nAllow: /\n')
        expect(text).not.toContain('Disallow')
        expect(text.match(/User-agent:/gu)).toHaveLength(1)
    })

    // AI-04: one signal line, without a training value.
    test('says search and AI input, and nothing of training', () => {
        expect(text).toContain('\nContent-Signal: search=yes, ai-input=yes\n')
        expect(text).not.toContain('ai-train')
    })

    // AGENT-01: the line of the sitemap index, absolute.
    test('names the sitemap index', () => {
        expect(text.endsWith('\nSitemap: https://notes.example/sitemap.xml\n')).toBe(true)
    })
})
