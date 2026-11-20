// Prototype of issue 26: Pele (the Mermaid renderer of the Obsidian team)
// renders at build time in Bun, with no browser. Prints the time, the size and
// the inline styles of the SVG of one invented diagram.
//
//     cd prototypes/markdown-adopt-check && bun pele-check.ts

import { render } from 'pele'

const start = performance.now()
const result: unknown = await render('graph TD\n    Seed --> Sprout\n    Sprout --> Harvest')
const svg = typeof result === 'string' ? result : (result as { svg: string }).svg
const count = (pattern: RegExp): number => (svg.match(pattern) ?? []).length
console.log(
    `${(performance.now() - start).toFixed(1)} ms, ${String(svg.length)} bytes, ` +
        `${String(count(/\sstyle="/g))} style attributes, ${String(count(/<style/g))} style elements, ` +
        `${String(count(/<script/g))} scripts, ${String(count(/var\(--pele/g))} theme variables`
)
