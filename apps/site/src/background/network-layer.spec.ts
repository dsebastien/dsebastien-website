import { describe, expect, test } from 'bun:test'
import { LAYER, QUIET_STEPS, layout } from './network.ts'
import { drawFrame, startLayer, type Context, type Environment } from './network-layer.ts'

// The script of the network behind the hero (issue 81), with a fake page.

/** A 2D context that records the calls that matter here. */
function recordingContext(): Context & { log: string[] } {
    const log: string[] = []
    const context = {
        log,
        globalAlpha: 1,
        globalCompositeOperation: 'source-over' as GlobalCompositeOperation,
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        setTransform: () => undefined,
        clearRect: () => log.push('clear'),
        beginPath: () => undefined,
        moveTo: () => undefined,
        lineTo: () => undefined,
        arc: () => undefined,
        rect: () => undefined,
        fill: () => log.push(`fill ${context.globalCompositeOperation}`),
        stroke: () => log.push('stroke')
    }
    return context
}

interface FakePage {
    environment: Environment
    context: Context & { log: string[] }
    reduce: (value: boolean) => void
    hide: (value: boolean) => void
    scroll: (onScreen: boolean) => void
    frame: (now: number) => void
    requested: () => number
    /** The number of reads of the color and the mode of the theme. */
    themeReads: () => number
}

function fakePage(reducedMotion: boolean): FakePage {
    let reduced = reducedMotion
    let hidden = false
    const listeners: Record<string, (() => void)[]> = { motion: [], visibility: [] }
    let screen: (onScreen: boolean) => void = () => undefined
    let pending: ((now: number) => void) | undefined
    let requested = 0
    let themeReads = 0
    const context = recordingContext()
    const environment: Environment = {
        reducedMotion: () => reduced,
        onReducedMotionChange: (listener) => listeners['motion']?.push(listener),
        hidden: () => hidden,
        onVisibilityChange: (listener) => listeners['visibility']?.push(listener),
        onScreenChange: (listener) => {
            screen = listener
        },
        onResize: () => undefined,
        onModeChange: () => undefined,
        requestFrame: (callback) => {
            pending = callback
            requested++
            return requested
        },
        cancelFrame: () => {
            pending = undefined
        },
        devicePixelRatio: () => 3,
        mode: () => {
            themeReads++
            return 'dark'
        },
        color: () => {
            themeReads++
            return 'currentColor'
        },
        size: () => ({ width: 1200, height: 480 }),
        quietBoxes: () => [{ left: 40, top: 100, right: 600, bottom: 160 }],
        context: () => context,
        setCanvasSize: () => undefined
    }
    return {
        environment,
        context,
        reduce: (value) => {
            reduced = value
            for (const listener of listeners['motion'] ?? []) listener()
        },
        hide: (value) => {
            hidden = value
            for (const listener of listeners['visibility'] ?? []) listener()
        },
        scroll: (onScreen) => {
            screen(onScreen)
        },
        frame: (now) => {
            const callback = pending
            pending = undefined
            callback?.(now)
        },
        requested: () => requested,
        themeReads: () => themeReads
    }
}

describe('the layer', () => {
    test('draws one still frame and asks for no frame when the reader asks for less motion', () => {
        const page = fakePage(true)
        const layer = startLayer(page.environment)
        expect(layer.running()).toBe(false)
        expect(page.requested()).toBe(0)
        expect(layer.frames()).toBeGreaterThan(0)
        expect(page.context.log).toContain('clear')
    })

    test('moves when motion is allowed, and stops when the reader asks for less', () => {
        const page = fakePage(false)
        const layer = startLayer(page.environment)
        expect(layer.running()).toBe(true)
        page.frame(0)
        page.frame(40)
        const frames = layer.frames()
        page.reduce(true)
        expect(layer.running()).toBe(false)
        page.frame(80)
        // One still frame, and no more.
        expect(layer.frames()).toBe(frames + 1)
        page.reduce(false)
        expect(layer.running()).toBe(true)
    })

    test('stops while the page is hidden or the layer is off screen', () => {
        const page = fakePage(false)
        const layer = startLayer(page.environment)
        page.hide(true)
        expect(layer.running()).toBe(false)
        page.hide(false)
        expect(layer.running()).toBe(true)
        page.scroll(false)
        expect(layer.running()).toBe(false)
        page.scroll(true)
        expect(layer.running()).toBe(true)
    })

    test('skips a frame that comes before the frame rate cap', () => {
        const page = fakePage(false)
        const layer = startLayer(page.environment)
        page.frame(1_000)
        const frames = layer.frames()
        page.frame(1_016)
        expect(layer.frames()).toBe(frames)
        page.frame(1_034)
        expect(layer.frames()).toBe(frames + 1)
    })
})

/** The calls that draw a node or a link, not the quiet steps. */
function marks(log: readonly string[]): number {
    return log.filter((call) => call === 'stroke' || call === 'fill source-over').length
}

/** Runs the frames of the fake page for this time, 40 ms apart. */
function runFor(page: FakePage, from: number, milliseconds: number): void {
    for (let now = from; now <= from + milliseconds; now += 40) page.frame(now)
}

describe('the layer off screen', () => {
    test('draws no node on a page that loads below the hero, then fades in on screen', () => {
        const page = fakePage(false)
        startLayer(page.environment)
        page.scroll(false)
        expect(marks(page.context.log)).toBe(0)
        page.scroll(true)
        runFor(page, 0, 2_000)
        expect(marks(page.context.log)).toBeGreaterThan(0)
    })

    test('keeps its last frame when the hero leaves the screen or the page is hidden', () => {
        const page = fakePage(false)
        const layer = startLayer(page.environment)
        runFor(page, 0, 2_000)
        const frames = layer.frames()
        const calls = page.context.log.length
        page.scroll(false)
        page.hide(true)
        expect(layer.frames()).toBe(frames)
        expect(page.context.log).toHaveLength(calls)
    })

    test('reads the color and the mode of the theme once, not at each frame', () => {
        const page = fakePage(false)
        startLayer(page.environment)
        const reads = page.themeReads()
        runFor(page, 0, 2_000)
        expect(page.themeReads()).toBe(reads)
    })
})

describe('a frame', () => {
    test('cuts the layer down behind the text in steps', () => {
        const context = recordingContext()
        drawFrame(context, {
            network: layout(1200, 480),
            elapsedMs: 0,
            intro: 1,
            mode: 'light',
            color: 'currentColor',
            quiet: [{ left: 40, top: 100, right: 600, bottom: 160 }],
            moving: false
        })
        expect(context.log.filter((call) => call === 'fill destination-out')).toHaveLength(
            QUIET_STEPS
        )
        expect(context.log.filter((call) => call === 'stroke').length).toBeGreaterThan(0)
        expect(context.globalCompositeOperation).toBe('source-over')
        expect(LAYER.light.quiet).toBeLessThan(LAYER.light.full)
    })
})
