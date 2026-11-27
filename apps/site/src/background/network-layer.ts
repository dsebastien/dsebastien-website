import {
    HALO_ALPHA,
    LAYER,
    LINK_ALPHA,
    animates,
    edgeFade,
    frameDue,
    introFade,
    layout,
    linkFade,
    pixelRatio,
    positionAt,
    quietMargins,
    quietStepAlpha,
    signalAt,
    spacingOf,
    type LayerMode,
    type Network
} from './network.ts'

// The script of the network behind the hero (issue 81). It starts after the
// first paint and the load of the page, so it never delays the text. It draws
// one still frame when the reader asks for less motion (DES-09), and moves
// only while the page is shown and the layer is on screen, at 30 frames per
// second at most. The layer is not printed (a class of the canvas).

/** A box of text over the layer, in pixels of the layer. */
export interface Box {
    left: number
    top: number
    right: number
    bottom: number
}

/** The part of a 2D context that the layer uses. */
export type Context = Pick<
    CanvasRenderingContext2D,
    | 'setTransform'
    | 'clearRect'
    | 'beginPath'
    | 'moveTo'
    | 'lineTo'
    | 'arc'
    | 'rect'
    | 'fill'
    | 'stroke'
    | 'globalAlpha'
    | 'globalCompositeOperation'
    | 'fillStyle'
    | 'strokeStyle'
    | 'lineWidth'
>

/** What the layer draws at one time. */
export interface Frame {
    network: Network
    /** The time of the drift, in milliseconds. */
    elapsedMs: number
    /** The fade at the start, from 0 to 1. */
    intro: number
    mode: LayerMode
    /** The color of the nodes, from the theme. */
    color: string
    /** The boxes of the text over the layer. */
    quiet: readonly Box[]
    /** False for the still frame: no signal. */
    moving: boolean
}

/** Draws one frame, at the scale of the layer (the caller sets the pixel ratio). */
export function drawFrame(context: Context, frame: Frame): void {
    const { network, mode, color } = frame
    const { width, height } = network
    const full = LAYER[mode].full * frame.intro
    const seconds = frame.elapsedMs / 1_000
    const spacing = spacingOf(network)
    const points = network.nodes.map((node) => positionAt(node, seconds))
    const presence = points.map((point) => edgeFade(point, width, height))

    context.globalCompositeOperation = 'source-over'
    context.clearRect(0, 0, width, height)
    context.fillStyle = color
    context.strokeStyle = color
    context.lineWidth = 1

    network.links.forEach(([from, to]) => {
        const one = points[from]
        const two = points[to]
        if (one === undefined || two === undefined) return
        const alpha =
            full *
            LINK_ALPHA *
            Math.min(presence[from] ?? 0, presence[to] ?? 0) *
            linkFade(Math.hypot(two.x - one.x, two.y - one.y), spacing)
        if (alpha < 0.01) return
        context.globalAlpha = alpha
        context.beginPath()
        context.moveTo(one.x, one.y)
        context.lineTo(two.x, two.y)
        context.stroke()
    })

    network.nodes.forEach((node, index) => {
        const point = points[index]
        const alpha = full * (presence[index] ?? 0)
        if (point === undefined || alpha < 0.01) return
        context.globalAlpha = alpha * HALO_ALPHA
        context.beginPath()
        context.arc(point.x, point.y, node.r * 4, 0, 2 * Math.PI)
        context.fill()
        context.globalAlpha = alpha
        context.beginPath()
        context.arc(point.x, point.y, node.r, 0, 2 * Math.PI)
        context.fill()
    })

    const signal = frame.moving ? signalAt(frame.elapsedMs, network.links.length) : undefined
    const link = signal === undefined ? undefined : network.links[signal.link]
    if (signal !== undefined && link !== undefined) {
        const one = points[link[0]]
        const two = points[link[1]]
        if (one !== undefined && two !== undefined) {
            const x = one.x + (two.x - one.x) * signal.progress
            const y = one.y + (two.y - one.y) * signal.progress
            const alpha = full * signal.alpha * edgeFade({ x, y }, width, height)
            if (alpha >= 0.01) {
                context.globalAlpha = alpha * HALO_ALPHA * 2
                context.beginPath()
                context.arc(x, y, 7, 0, 2 * Math.PI)
                context.fill()
                context.globalAlpha = alpha
                context.beginPath()
                context.arc(x, y, 2, 0, 2 * Math.PI)
                context.fill()
            }
        }
    }

    // Behind the text the layer is cut down in steps, from a margin around
    // the text to the text itself: there, no pixel keeps more than the quiet
    // limit of the mode (WCAG AA for the text over it).
    if (frame.quiet.length > 0) {
        context.globalCompositeOperation = 'destination-out'
        context.globalAlpha = quietStepAlpha(LAYER[mode].quiet)
        for (const margin of quietMargins()) {
            context.beginPath()
            for (const box of frame.quiet) {
                context.rect(
                    box.left - margin,
                    box.top - margin,
                    box.right - box.left + 2 * margin,
                    box.bottom - box.top + 2 * margin
                )
            }
            context.fill()
        }
        context.globalCompositeOperation = 'source-over'
    }
    context.globalAlpha = 1
}

/** What the layer needs from the page. The browser gives it in `browserEnvironment()`. */
export interface Environment {
    reducedMotion: () => boolean
    onReducedMotionChange: (listener: () => void) => void
    hidden: () => boolean
    onVisibilityChange: (listener: () => void) => void
    /** Calls the listener with true when the layer comes on screen, false when it leaves. */
    onScreenChange: (listener: (onScreen: boolean) => void) => void
    onResize: (listener: () => void) => void
    onModeChange: (listener: () => void) => void
    requestFrame: (callback: (now: number) => void) => number
    cancelFrame: (handle: number) => void
    devicePixelRatio: () => number
    mode: () => LayerMode
    color: () => string
    /** The size of the layer, in CSS pixels. */
    size: () => { width: number; height: number }
    /** The boxes of the text over the layer. */
    quietBoxes: () => Box[]
    context: () => Context | null
    /** Gives the canvas its size in device pixels. */
    setCanvasSize: (width: number, height: number) => void
}

/** The controls of a running layer, for the tests. */
export interface Layer {
    /** True while the layer asks the browser for frames. */
    running: () => boolean
    /** The number of frames drawn. */
    frames: () => number
}

/** Starts the layer: one still frame, then the motion when it is allowed. */
export function startLayer(environment: Environment): Layer {
    const context = environment.context()
    let network: Network | undefined
    let quiet: Box[] = []
    let ratio = 1
    let onScreen = true
    let handle: number | undefined
    let last = -Infinity
    let elapsed = 0
    let drawn = 0
    let reduced = environment.reducedMotion()
    // The theme is read when the layer starts or resizes and when the mode
    // changes, never at each frame.
    let mode: LayerMode = 'dark'
    let color = ''

    const readTheme = (): void => {
        mode = environment.mode()
        color = environment.color()
    }

    const resize = (): void => {
        const { width, height } = environment.size()
        ratio = pixelRatio(environment.devicePixelRatio())
        environment.setCanvasSize(Math.round(width * ratio), Math.round(height * ratio))
        network = width > 0 && height > 0 ? layout(width, height) : undefined
        quiet = environment.quietBoxes()
        readTheme()
    }

    const draw = (moving: boolean): void => {
        if (context === null || network === undefined) return
        context.setTransform(ratio, 0, 0, ratio, 0, 0)
        drawFrame(context, {
            network,
            elapsedMs: elapsed,
            // The still frame of less motion shows at once: no fade, which is
            // motion too. Otherwise a frame keeps the fade where it is, so a
            // page that loads below the hero shows no node before it moves.
            intro: reduced ? 1 : introFade(elapsed),
            mode,
            color,
            quiet,
            moving
        })
        drawn++
    }

    const tick = (now: number): void => {
        handle = environment.requestFrame(tick)
        if (!frameDue(now, last)) return
        // A long gap (a busy page) does not make the nodes jump.
        elapsed += last === -Infinity ? 0 : Math.min(now - last, 100)
        last = now
        draw(true)
    }

    const update = (): void => {
        reduced = environment.reducedMotion()
        const moves = animates({
            reducedMotion: reduced,
            hidden: environment.hidden(),
            onScreen
        })
        if (moves && handle === undefined) {
            last = -Infinity
            handle = environment.requestFrame(tick)
        } else if (!moves && handle !== undefined) {
            environment.cancelFrame(handle)
            handle = undefined
        }
        if (reduced) {
            // The still frame: the network at rest, for the reader who asks for less motion.
            elapsed = 0
            draw(false)
        }
        // A layer that is hidden or off screen keeps its last frame.
    }

    resize()
    draw(false)
    environment.onReducedMotionChange(update)
    environment.onVisibilityChange(update)
    environment.onScreenChange((value) => {
        onScreen = value
        update()
    })
    environment.onResize(() => {
        resize()
        draw(handle !== undefined)
    })
    environment.onModeChange(() => {
        readTheme()
        draw(handle !== undefined)
    })
    update()

    return { running: () => handle !== undefined, frames: () => drawn }
}

/** The environment of a canvas of the page, with the elements whose text it keeps readable. */
export function browserEnvironment(
    canvas: HTMLCanvasElement,
    textElements: readonly Element[]
): Environment {
    const motion = matchMedia('(prefers-reduced-motion: reduce)')
    const root = document.documentElement
    return {
        reducedMotion: () => motion.matches,
        onReducedMotionChange: (listener) => {
            motion.addEventListener('change', listener)
        },
        hidden: () => document.hidden,
        onVisibilityChange: (listener) => {
            document.addEventListener('visibilitychange', listener)
        },
        onScreenChange: (listener) => {
            new IntersectionObserver((entries) => {
                const entry = entries[entries.length - 1]
                if (entry !== undefined) listener(entry.isIntersecting)
            }).observe(canvas)
        },
        onResize: (listener) => {
            let first = true
            new ResizeObserver(() => {
                // The observer reports the first size at once: the layer has it already.
                if (first) {
                    first = false
                    return
                }
                listener()
            }).observe(canvas)
            // The text moves when the font arrives.
            void document.fonts.ready.then(listener)
        },
        onModeChange: (listener) => {
            new MutationObserver(listener).observe(root, {
                attributeFilter: ['data-theme', 'data-design']
            })
        },
        requestFrame: (callback) => requestAnimationFrame(callback),
        cancelFrame: (handle) => {
            cancelAnimationFrame(handle)
        },
        devicePixelRatio: () => window.devicePixelRatio,
        mode: () => (root.dataset['theme'] === 'light' ? 'light' : 'dark'),
        // The canvas has the color class of the nodes: its color is the token of the theme.
        color: () => getComputedStyle(canvas).color,
        size: () => ({ width: canvas.clientWidth, height: canvas.clientHeight }),
        quietBoxes: () => {
            const origin = canvas.getBoundingClientRect()
            const range = document.createRange()
            const boxes: Box[] = []
            for (const element of textElements) {
                // One box per line of the text, so the space beside a short line stays lively.
                range.selectNodeContents(element)
                for (const line of range.getClientRects()) {
                    if (line.width === 0 || line.height === 0) continue
                    boxes.push({
                        left: line.left - origin.left,
                        top: line.top - origin.top,
                        right: line.right - origin.left,
                        bottom: line.bottom - origin.top
                    })
                }
            }
            return boxes
        },
        context: () => canvas.getContext('2d'),
        setCanvasSize: (width, height) => {
            canvas.width = width
            canvas.height = height
        }
    }
}

/** Starts the layer of each network canvas of the page, after the first paint and the load. */
export function startNetworkLayers(page: Document): void {
    const start = (): void => {
        for (const canvas of page.querySelectorAll<HTMLCanvasElement>('canvas[data-network]')) {
            const scope = canvas.closest('[data-network-scope]') ?? page.body
            startLayer(
                browserEnvironment(canvas, [...scope.querySelectorAll('[data-network-quiet]')])
            )
        }
    }
    const idle = (): void => {
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(start, { timeout: 1_500 })
        } else {
            setTimeout(start, 200)
        }
    }
    if (page.readyState === 'complete') {
        idle()
    } else {
        addEventListener('load', idle, { once: true })
    }
}
