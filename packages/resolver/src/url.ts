// The URL function (MOD-04 of the spec): the one place that knows the
// encoding of the canonical URL. Every output of the site uses it.

/**
 * The canonical path of a note, from its vault path: the path part of its
 * canonical URL, with a slash at the start and no slash at the end.
 *
 * Each segment of the vault path is percent-encoded, then `%20` is written as
 * `+`. So a space is `+`, and a literal `+` is `%2B` (URL-01).
 *
 * The slice of the URL contract checks this encoding against every URL that
 * the site has today. Until then it is a first version.
 */
export function canonicalPath(vaultPath: string): string {
    if (!vaultPath.endsWith('.md')) {
        throw new Error(`"${vaultPath}" is not the vault path of a note`)
    }
    const segments = vaultPath.slice(0, -'.md'.length).split('/')
    return `/${segments.map((segment) => encodeURIComponent(segment).replaceAll('%20', '+')).join('/')}`
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
