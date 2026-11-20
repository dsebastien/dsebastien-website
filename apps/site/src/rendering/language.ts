// The language of a note (REN-09 of the spec, decision of the author in
// issue 45): the property `language` of the note, a language tag such as `fr`
// or `en`. A note without it, or with a value that is no language tag, is in
// English. The property `languages` lists the languages of a book or a
// resource, not of the note: it is not read.

const TAG = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/iu

/** The language of a note, from its properties. */
export function languageOf(properties: Readonly<Record<string, unknown>>): string {
    const value = properties['language']
    return typeof value === 'string' && TAG.test(value.trim()) ? value.trim() : 'en'
}
