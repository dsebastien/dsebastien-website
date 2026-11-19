// The URL function (MOD-04 of the spec): the one place that knows the
// encoding of the canonical URL. Every output of the site uses it.

/**
 * The canonical path of a note, from its vault path: the path part of its
 * canonical URL, with a slash at the start and no slash at the end.
 *
 * Each segment of the vault path is percent-encoded, then `%20` is written as
 * `+`. So a space is `+`, and a literal `+` is `%2B` (URL-01).
 *
 * The research of 2026-11-17 measured this encoding on the site of today
 * (`documentation/research/2026-11-17-current-state.md`, section 1.6). The
 * slice of the first redirect list (issue 44) checks it against every URL
 * that the search engines know.
 */
export function canonicalPath(vaultPath: string): string {
    if (!vaultPath.endsWith('.md')) {
        throw new Error(`"${vaultPath}" is not the vault path of a note`)
    }
    return `/${encodedSegments(vaultPath.slice(0, -'.md'.length))}`
}

/** Each segment of a path percent-encoded, then `%20` written as `+`. */
function encodedSegments(path: string): string {
    return path
        .split('/')
        .map((segment) => encodeURIComponent(segment).replaceAll('%20', '+'))
        .join('/')
}

/**
 * The canonical path of a folder, from its vault path: the encoding of
 * `canonicalPath`. It shows the list of the folder, or leads to its folder
 * note (URL-16).
 */
export function folderPath(vaultPath: string): string {
    return `/${encodedSegments(vaultPath)}`
}

/** The path of the Markdown of a note (URL-10): `/-/md/`, its canonical path, and `.md`. */
export function markdownPath(vaultPath: string): string {
    return `/-/md${canonicalPath(vaultPath)}.md`
}

/** The form of the hash of an attachment in the manifest. */
const ATTACHMENT_HASH = /^sha256:([0-9a-f]{64})$/

/**
 * The content-hashed path of an attachment, which pages use (URL-15): the key
 * of the file in the attachment storage, then its name, percent-encoded. The
 * content of such a URL never changes, so it can be kept for a long time.
 *
 * @param hash the hash of the file in the manifest: `sha256:` and 64 hexadecimal digits
 * @param vaultPath the vault path of the file
 */
export function attachmentPath(hash: string, vaultPath: string): string {
    const key = ATTACHMENT_HASH.exec(hash)?.[1]
    if (key === undefined) {
        throw new Error(`"${hash}" is not the hash of an attachment`)
    }
    const name = vaultPath.slice(vaultPath.lastIndexOf('/') + 1)
    return `/-/attachments/${key}/${encodeURIComponent(name)}`
}
