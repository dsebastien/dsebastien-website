// Reading of JSON files of the content store and of the device. The Rust twin
// reads the same files with `serde_json`, and both must accept and refuse the
// same texts.

/**
 * Reads a JSON text. It throws for a text that is not JSON, and for two forms
 * that the reader of JavaScript accepts and the Rust reader refuses: a text
 * with half of a surrogate pair, and a number too large to hold.
 */
export function parseJson(text: string): unknown {
    return JSON.parse(text, (key, value: unknown) => {
        if (!key.isWellFormed() || (typeof value === 'string' && !value.isWellFormed())) {
            throw new Error('a text is not valid Unicode')
        }
        if (typeof value === 'number' && !Number.isFinite(value)) {
            throw new Error('a number is too large')
        }
        return value
    })
}
