import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
    LAYER,
    MAX_NODES,
    MIN_NODES,
    NEIGHBORS,
    QUIET_STEPS,
    animates,
    edgeFade,
    frameDue,
    introFade,
    layout,
    nodeCount,
    pixelRatio,
    positionAt,
    quietMargins,
    quietStepAlpha,
    signalAt
} from './network.ts'

// The pure parts of the network behind the hero (issue 81).

describe('the layout', () => {
    test('is the same for the same size and seed', () => {
        expect(layout(1200, 480)).toEqual(layout(1200, 480))
        expect(layout(1200, 480, 1)).not.toEqual(layout(1200, 480, 2))
    })

    test('has a few dozen nodes, fewer on a small screen', () => {
        expect(nodeCount(390, 500)).toBe(MIN_NODES)
        expect(nodeCount(390, 700)).toBeLessThan(20)
        expect(nodeCount(1440, 480)).toBeGreaterThan(36)
        expect(nodeCount(3840, 1200)).toBe(MAX_NODES)
        expect(nodeCount(0, 0)).toBe(MIN_NODES)
        expect(layout(1440, 480).nodes).toHaveLength(nodeCount(1440, 480))
    })

    test('keeps every node inside the layer', () => {
        for (const [width, height] of [
            [1440, 480],
            [390, 560],
            [768, 400]
        ] as const) {
            for (const node of layout(width, height).nodes) {
                expect(node.x).toBeGreaterThanOrEqual(0)
                expect(node.x).toBeLessThanOrEqual(width)
                expect(node.y).toBeGreaterThanOrEqual(0)
                expect(node.y).toBeLessThanOrEqual(height)
            }
        }
    })

    test('links each node to its nearest neighbors, once per pair', () => {
        const { nodes, links } = layout(1440, 480)
        const keys = links.map(([one, two]) => `${String(one)}-${String(two)}`)
        expect(new Set(keys).size).toBe(links.length)
        for (const [one, two] of links) {
            expect(one).toBeLessThan(two)
            expect(two).toBeLessThan(nodes.length)
        }
        nodes.forEach((_node, index) => {
            const degree = links.filter((link) => link.includes(index)).length
            expect(degree).toBeGreaterThanOrEqual(NEIGHBORS)
        })
    })
})

describe('the drift', () => {
    test('stays within the amplitude of a node, and time 0 is the still frame', () => {
        const node = layout(1440, 480).nodes[0]
        expect(node).toBeDefined()
        if (node === undefined) return
        for (const seconds of [0, 1, 7.5, 60, 3_600]) {
            const point = positionAt(node, seconds)
            expect(Math.abs(point.x - node.x)).toBeLessThanOrEqual(node.ax + 1e-9)
            expect(Math.abs(point.y - node.y)).toBeLessThanOrEqual(node.ay + 1e-9)
        }
        expect(positionAt(node, 0)).toEqual(positionAt(node, 0))
    })

    test('is slow: less than 12 pixels per second', () => {
        for (const node of layout(1440, 480).nodes) {
            expect(Math.hypot(node.ax * node.wx, node.ay * node.wy)).toBeLessThan(12)
        }
    })
})

describe('the fades', () => {
    test('the edges of the layer are empty and its middle is whole', () => {
        expect(edgeFade({ x: 0, y: 240 }, 1440, 480)).toBe(0)
        expect(edgeFade({ x: 720, y: 480 }, 1440, 480)).toBe(0)
        expect(edgeFade({ x: 720, y: 240 }, 1440, 480)).toBe(1)
    })

    test('the start fades in, then stays', () => {
        expect(introFade(0)).toBe(0)
        expect(introFade(10_000)).toBe(1)
    })

    test('a signal runs along a link and fades in and out', () => {
        expect(signalAt(0, 0)).toBeUndefined()
        const start = signalAt(0, 10)
        expect(start?.alpha).toBe(0)
        const middle = signalAt(1_200, 10)
        expect(middle?.alpha).toBeCloseTo(1)
        expect(middle?.link).toBeLessThan(10)
    })
})

describe('the motion', () => {
    test('stops when the reader asks for less, when the page is hidden, and off screen', () => {
        const moving = { reducedMotion: false, hidden: false, onScreen: true }
        expect(animates(moving)).toBe(true)
        expect(animates({ ...moving, reducedMotion: true })).toBe(false)
        expect(animates({ ...moving, hidden: true })).toBe(false)
        expect(animates({ ...moving, onScreen: false })).toBe(false)
    })

    test('runs at 30 frames per second at most', () => {
        expect(frameDue(16.7, 0)).toBe(false)
        expect(frameDue(33.4, 0)).toBe(true)
    })

    test('caps the pixel ratio', () => {
        expect(pixelRatio(3)).toBe(1.5)
        expect(pixelRatio(1)).toBe(1)
        expect(pixelRatio(0)).toBe(1)
    })
})

// The text over the layer keeps WCAG AA: behind it no pixel has more than the
// quiet limit of the color of the nodes. The worst pixel is that color at that
// limit over the background of the page, in each mode of the theme.
describe('the text over the layer', () => {
    const THEME = fileURLToPath(new URL('../styles/themes/knowii.css', import.meta.url))

    async function values(selector: string): Promise<Map<string, string>> {
        const css = await readFile(THEME, 'utf8')
        const start = css.indexOf(`${selector} {`)
        const block = css.slice(start, css.indexOf('}', start))
        return new Map(
            [...block.matchAll(/--theme-([a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/gu)].map(
                ([, name = '', value = '']) => [name, value]
            )
        )
    }

    const channels = (hex: string): number[] =>
        [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16))

    function luminance(rgb: readonly number[]): number {
        const [r = 0, g = 0, b = 0] = rgb.map((value) => {
            const channel = value / 255
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
        })
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }

    function contrast(one: readonly number[], two: readonly number[]): number {
        const [light = 0, dark = 0] = [luminance(one), luminance(two)].sort((a, b) => b - a)
        return (light + 0.05) / (dark + 0.05)
    }

    test('the quiet steps leave at most the quiet limit behind the text', () => {
        for (const mode of ['dark', 'light'] as const) {
            const left = (1 - quietStepAlpha(LAYER[mode].quiet)) ** QUIET_STEPS
            expect(left).toBeCloseTo(LAYER[mode].quiet)
        }
        const margins = quietMargins()
        expect(margins).toHaveLength(QUIET_STEPS)
        expect(margins[margins.length - 1]).toBe(0)
    })

    test.each([
        ['dark', ":root,\n[data-theme='dark']"],
        ['light', "[data-theme='light']"]
    ] as const)('passes WCAG AA in the %s mode', async (mode, selector) => {
        const theme = await values(selector)
        const background = channels(theme.get('background') ?? '')
        const node = channels(theme.get('secondary-text') ?? '')
        const quiet = LAYER[mode].quiet
        const worst = background.map(
            (channel, index) => channel * (1 - quiet) + (node[index] ?? 0) * quiet
        )
        for (const text of ['primary', 'muted']) {
            const color = theme.get(text)
            expect(color).toBeDefined()
            expect(contrast(channels(color ?? ''), worst)).toBeGreaterThanOrEqual(4.5)
        }
    })
})
