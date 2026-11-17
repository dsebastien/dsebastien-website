// The resolver (MOD-05 of the spec): a pure function, in plain TypeScript, so
// that it runs in tests, at the edge and on a plain server (HOST-02).

/** What the build knows about the paths of the site. The build writes it, and the resolver reads it. */
export interface ResolverMap {
    /** The file of the page of each canonical path, relative to the output of the build. */
    readonly pages: Readonly<Record<string, string>>
}

/** What a requested path leads to. Later slices add a redirect and "gone". */
export type Resolution = { kind: 'page'; file: string } | { kind: 'not-found' }

/**
 * Resolves a requested path.
 *
 * The path is read as it is requested, with its percent-encoding: the literal
 * reading of a path wins (URL-03).
 */
export function resolve(path: string, map: ResolverMap): Resolution {
    // `Object.hasOwn`: a path such as "constructor" is not a page.
    const file = Object.hasOwn(map.pages, path) ? map.pages[path] : undefined
    return file === undefined ? { kind: 'not-found' } : { kind: 'page', file }
}
