// What the markup drops of a note (REN-03, REN-14), also read by the
// description of a note (issue 98), which must not show what a page hides.

/** Code blocks that are live queries or widgets: never shown (REN-03, REN-14). */
export function isDroppedBlock(lang: unknown): boolean {
    if (typeof lang !== 'string') {
        return false
    }
    const name = lang.toLowerCase()
    return (
        ['dataview', 'dataviewjs', 'base', 'bases', 'query'].includes(name) ||
        name.startsWith('meta-bind')
    )
}

/** Inline code that is Meta Bind (`INPUT[…]`, `VIEW[…]`, `BUTTON[…]`) or an inline Dataview query (`= …`, `$= …`). */
export function isDroppedInline(value: string): boolean {
    return /^(?:INPUT|VIEW|BUTTON)\[/u.test(value) || /^\$?=\s/u.test(value)
}
