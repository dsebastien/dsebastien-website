// The order of texts in the canonical form (documentation/Canonical Form.md).
// The Rust twin is `cli/src/order.rs`. Change both in the same commit.

/**
 * Compares two texts by their code points: the order of the canonical form.
 *
 * Never use the default sort for a list that the parity rule compares. It
 * compares UTF-16 units, so it puts a character above U+FFFF (most emoji)
 * before the characters U+E000 to U+FFFF. Rust compares the bytes of UTF-8,
 * which is the order of the code points.
 *
 * A path is compared as one text, the slash included.
 */
export function compareCodePoints(one: string, two: string): number {
    const first = one[Symbol.iterator]()
    const second = two[Symbol.iterator]()
    for (;;) {
        const left = first.next()
        const right = second.next()
        if (left.done === true || right.done === true) {
            // The text that ends first comes first.
            return (left.done === true ? 0 : 1) - (right.done === true ? 0 : 1)
        }
        const difference = (left.value.codePointAt(0) ?? 0) - (right.value.codePointAt(0) ?? 0)
        if (difference !== 0) {
            return difference
        }
    }
}

/** A copy of the texts in the order of the canonical form. */
export function sortByCodePoint(texts: readonly string[]): string[] {
    return [...texts].sort(compareCodePoints)
}
