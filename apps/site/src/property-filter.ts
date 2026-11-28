// The one filter of the properties of a published note (business rule 14,
// issue 100): every output that shows a property reads it through
// `isShownProperty`: the properties panel, the links of the properties, and
// the aliases of the title index of the search. A later allow list per
// property key goes here, so it applies to all of them. The module has no
// dependency: the code of the search page loads it too.

/** True when the outputs of the site show the property with this key. */
export type PropertyFilter = (key: string) => boolean

/** The keys that no output shows. `position` is a key of the reader of Obsidian. */
const HIDDEN = new Set(['position'])

/** The filter of the site: until an allow list exists, every key but `position` (business rule 14). */
export const isShownProperty: PropertyFilter = (key) => !HIDDEN.has(key)
