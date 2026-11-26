// The network behind the hero of the home page (issue 81): a few dozen nodes
// and their links, a picture of a garden of linked notes, that drift slowly.
// This file holds the pure parts: the seeded layout, the position of a node
// at a time, the fades, and the limits that keep the text readable. The
// script of the page (`network-layer.ts`) draws them on a canvas.
//
// The layout is seeded pseudo-random: the same size gives the same picture
// at every visit. The nodes do not come from the real graph of the notes.

/** The seed of the layout. */
export const SEED = 0x81

/** The pixel area of the layer for one node, and the bounds of the count. */
export const AREA_PER_NODE = 15_000
export const MIN_NODES = 14
export const MAX_NODES = 56

/** Each node links to its nearest neighbors, up to this count. */
export const NEIGHBORS = 2

/** The frame rate cap of the animation, and the cap of the device pixel ratio. */
export const MAX_FPS = 30
export const MAX_PIXEL_RATIO = 1.5

/** The time of the fade at the start, in milliseconds. */
export const INTRO_MS = 1_400

/** A signal runs along one link in this time, then the next one starts. */
export const SIGNAL_MS = 2_400

/** The opacity of a link, of the halo of a node, relative to a node. */
export const LINK_ALPHA = 0.55
export const HALO_ALPHA = 0.16

/**
 * The opacity of the layer in each mode. `full` is the opacity of a node away
 * from the text. Behind the text, the layer is cut down so that no pixel has
 * more than `quiet` of the color of the nodes: the text over it then keeps
 * the contrast of WCAG AA (checked in `network.spec.ts` with the values of
 * the theme). A light background loses contrast faster: its limit is lower.
 */
export const LAYER = {
    dark: { full: 0.85, quiet: 0.32 },
    light: { full: 0.7, quiet: 0.12 }
} as const

export type LayerMode = keyof typeof LAYER

/** The free space around the text, in pixels, where the layer fades to its quiet limit. */
export const QUIET_MARGIN = 28

/** The steps of that fade. */
export const QUIET_STEPS = 4

export interface NetworkNode {
    /** The home position, in pixels of the layer. */
    x: number
    y: number
    /** The drift around the home position: amplitudes in pixels, angular speeds in radians per second, phases. */
    ax: number
    ay: number
    wx: number
    wy: number
    px: number
    py: number
    /** The radius of the node, in pixels. A hub is larger. */
    r: number
}

export interface Network {
    width: number
    height: number
    nodes: NetworkNode[]
    /** Each link joins two indexes of `nodes`, the smaller first. */
    links: [number, number][]
}

export interface Point {
    x: number
    y: number
}

/** A small seeded generator of numbers in [0, 1) (mulberry32). */
export function generator(seed: number): () => number {
    let state = seed >>> 0
    return () => {
        state = (state + 0x6d2b79f5) >>> 0
        let mixed = state
        mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
        mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
    }
}

/** The number of nodes for a layer of this size. */
export function nodeCount(width: number, height: number): number {
    const count = Math.round((Math.max(0, width) * Math.max(0, height)) / AREA_PER_NODE)
    return Math.min(MAX_NODES, Math.max(MIN_NODES, count))
}

/**
 * The network of a layer of this size: the nodes spread on a jittered grid
 * (even, but not regular), each linked to its nearest neighbors.
 */
export function layout(width: number, height: number, seed = SEED): Network {
    const random = generator(seed)
    const count = nodeCount(width, height)
    const ratio = width > 0 && height > 0 ? width / height : 1
    const columns = Math.max(1, Math.round(Math.sqrt(count * ratio)))
    const rows = Math.max(1, Math.ceil(count / columns))
    const cellWidth = width / columns
    const cellHeight = height / rows
    const spacing = Math.sqrt((width * height) / count)
    const cells = Array.from({ length: columns * rows }, (_cell, index) => index)
    // A seeded shuffle picks which cells get a node, when the grid has more cells than nodes.
    for (let index = cells.length - 1; index > 0; index--) {
        const other = Math.floor(random() * (index + 1))
        const kept = cells[index] ?? 0
        cells[index] = cells[other] ?? 0
        cells[other] = kept
    }
    const nodes = cells
        .slice(0, count)
        .sort((one, two) => one - two)
        .map((cell): NetworkNode => {
            const column = cell % columns
            const row = Math.floor(cell / columns)
            const hub = random() < 0.14
            return {
                x: (column + 0.15 + random() * 0.7) * cellWidth,
                y: (row + 0.15 + random() * 0.7) * cellHeight,
                ax: spacing * (0.12 + random() * 0.18),
                ay: spacing * (0.12 + random() * 0.18),
                // Periods between 22 s and 48 s: a slow drift.
                wx: (2 * Math.PI) / (22 + random() * 26),
                wy: (2 * Math.PI) / (22 + random() * 26),
                px: random() * 2 * Math.PI,
                py: random() * 2 * Math.PI,
                r: hub ? 2.6 + random() * 0.8 : 1.3 + random() * 0.7
            }
        })
    return { width, height, nodes, links: linksOf(nodes) }
}

/** The links of the nodes: each node to its nearest neighbors, once per pair. */
export function linksOf(nodes: readonly Point[]): [number, number][] {
    const seen = new Set<string>()
    const links: [number, number][] = []
    nodes.forEach((node, index) => {
        const nearest = nodes
            .map((other, at) => ({ at, distance: Math.hypot(other.x - node.x, other.y - node.y) }))
            .filter(({ at }) => at !== index)
            .sort((one, two) => one.distance - two.distance || one.at - two.at)
            .slice(0, NEIGHBORS)
        for (const { at } of nearest) {
            const pair: [number, number] = index < at ? [index, at] : [at, index]
            const key = `${String(pair[0])}-${String(pair[1])}`
            if (!seen.has(key)) {
                seen.add(key)
                links.push(pair)
            }
        }
    })
    return links
}

/** The position of a node at this time, in seconds. Time 0 is the still frame. */
export function positionAt(node: NetworkNode, seconds: number): Point {
    return {
        x: node.x + node.ax * Math.sin(node.wx * seconds + node.px),
        y: node.y + node.ay * Math.sin(node.wy * seconds + node.py)
    }
}

/** 0 at `edge0`, 1 at `edge1`, smooth between. */
export function smoothstep(edge0: number, edge1: number, value: number): number {
    if (edge1 === edge0) return value < edge0 ? 0 : 1
    const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)))
    return t * t * (3 - 2 * t)
}

/**
 * The presence of a point of the layer: 1 inside, down to 0 at the edges, so
 * the layer has no hard border against the header and the rest of the page.
 */
export function edgeFade(point: Point, width: number, height: number): number {
    const across = Math.min(width * 0.08, 96)
    const down = height * 0.18
    return (
        smoothstep(0, across, point.x) *
        smoothstep(0, across, width - point.x) *
        smoothstep(0, down, point.y) *
        smoothstep(0, down, height - point.y)
    )
}

/** The opacity of a link, from its length: a long link is fainter. */
export function linkFade(length: number, spacing: number): number {
    return 1 - smoothstep(spacing * 0.9, spacing * 2.4, length)
}

/** The fade at the start of the animation: from 0 to 1 in `INTRO_MS`. */
export function introFade(elapsedMs: number): number {
    return smoothstep(0, INTRO_MS, elapsedMs)
}

/** The average space between two nodes of a network. */
export function spacingOf(network: Network): number {
    return Math.sqrt((network.width * network.height) / Math.max(1, network.nodes.length))
}

export interface Signal {
    /** The link that the signal runs along, as an index of `links`. */
    link: number
    /** Where it is on the link, from 0 to 1, from its first node. */
    progress: number
    /** Its opacity, 0 at the start and at the end. */
    alpha: number
}

/** The signal at this time, in milliseconds: one at a time, on a seeded link. */
export function signalAt(elapsedMs: number, linkCount: number): Signal | undefined {
    if (linkCount === 0) return undefined
    const round = Math.floor(elapsedMs / SIGNAL_MS)
    const progress = (elapsedMs - round * SIGNAL_MS) / SIGNAL_MS
    const link = Math.floor(generator(SEED + round)() * linkCount)
    return { link, progress: smoothstep(0, 1, progress), alpha: Math.sin(Math.PI * progress) }
}

/**
 * The opacity that each step of the quiet fade removes. A pixel behind the
 * text gets every step, so its alpha (at most 1) ends at most at `quiet`.
 */
export function quietStepAlpha(quiet: number, steps = QUIET_STEPS): number {
    return 1 - quiet ** (1 / steps)
}

/** The margin of each quiet step, from the widest to the text itself. */
export function quietMargins(steps = QUIET_STEPS, margin = QUIET_MARGIN): number[] {
    return Array.from({ length: steps }, (_step, index) =>
        steps === 1 ? 0 : (margin * (steps - 1 - index)) / (steps - 1)
    )
}

/** True when the layer moves: the reader allows motion, the page is shown and the layer is on screen. */
export function animates(state: {
    reducedMotion: boolean
    hidden: boolean
    onScreen: boolean
}): boolean {
    return !state.reducedMotion && !state.hidden && state.onScreen
}

/** True when enough time passed since the last frame for the frame rate cap. */
export function frameDue(nowMs: number, lastMs: number, fps = MAX_FPS): boolean {
    // A millisecond of slack, so a 60 Hz screen gives every second frame.
    return nowMs - lastMs >= 1_000 / fps - 1
}

/** The device pixel ratio that the canvas uses. */
export function pixelRatio(devicePixelRatio: number): number {
    return Math.min(MAX_PIXEL_RATIO, Math.max(1, devicePixelRatio || 1))
}
