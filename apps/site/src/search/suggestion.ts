// The search of the "not found" page (decision R63): its field starts with
// the words of the last part of the missing address, so the reader only has
// to press Search. The page runs `suggestionScript`, a few lines inline: the
// static page cannot know its address at the build.

/**
 * The query of a missing address: the last part of its path, decoded, with
 * `+` as a space and without `.md`. Empty for the root, a path under the
 * reserved prefix, and a path that does not decode. It runs alone in the
 * page, so it reads nothing outside itself.
 */
export function queryOfPath(path: string, longest = 80): string {
    if (path.startsWith('/-/')) {
        return ''
    }
    const last =
        path
            .split('/')
            .filter((part) => part !== '')
            .at(-1) ?? ''
    let text: string
    try {
        text = decodeURIComponent(last.replaceAll('+', ' '))
    } catch {
        return ''
    }
    return Array.from(text.replace(/\.md$/iu, '').trim()).slice(0, longest).join('')
}

/** The inline script of the "not found" page: it fills the empty search field of the page. */
export function suggestionScript(field: string): string {
    return `{
    const field = document.getElementById(${JSON.stringify(field)})
    if (field !== null && field.value === '') {
        field.value = (${queryOfPath.toString()})(location.pathname)
    }
}`
}
