// What a face gives to a run of the tool: the time, the name of the device
// and the face (`documentation/Canonical Form.md`, "A publication"). The
// logic reads no clock and no name of the system. The Rust twin is in
// `cli/src/tool.rs`.

/** The faces of the tool that can start a run. */
export const FACES = ['plugin', 'command-line', 'mcp-server'] as const
export type Face = (typeof FACES)[number]

/** A time in the canonical form: UTC, to the second. */
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

/** True when the text is a real date and time in the canonical form. */
export function isCanonicalTime(time: string): boolean {
    if (!TIME.test(time)) {
        return false
    }
    const date = new Date(time)
    // A date that does not exist (month 13, day 31 of a short month) does not
    // come back as the same text.
    return !Number.isNaN(date.getTime()) && `${date.toISOString().slice(0, 19)}Z` === time
}

/** True when the text is one line with something to read: no control character, and not only spaces (U+0020). */
export function isOneLine(text: string): boolean {
    return !/\p{Cc}/u.test(text) && /[^ ]/u.test(text)
}

/** True when the text is the name of a face of the tool. */
export function isFace(text: string): text is Face {
    return (FACES as readonly string[]).includes(text)
}
