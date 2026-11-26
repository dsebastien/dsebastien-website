import type { ResolverMap, SiteFile } from './resolver.ts'

// The reader of a resolver map (MOD-06): the map is a file of a release, so
// each host that reads it checks its shape at that boundary, with the same
// check.

/** The place of the resolver map in the output of the build. */
export const RESOLVER_MAP_FILE = '-/resolver-map.json'

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The form of a key of the attachment storage. It names a file of the storage. */
const ATTACHMENT_KEY = /^[0-9a-f]{64}$/

/** True when every value of the record passes the check. */
function everyValue(value: unknown, check: (item: unknown) => boolean): boolean {
    return isRecord(value) && Object.values(value).every(check)
}

const isText = (value: unknown): value is string => typeof value === 'string'
const isTextList = (value: unknown): boolean => Array.isArray(value) && value.every(isText)
const isSet = (value: unknown): boolean => everyValue(value, (item) => item === true)
const isGoneMap = (value: unknown): boolean =>
    isRecord(value) &&
    (value['file'] === undefined || isText(value['file'])) &&
    typeof value['longest'] === 'number' &&
    Number.isInteger(value['longest']) &&
    value['longest'] >= 0 &&
    isSet(value['paths']) &&
    isSet(value['folded']) &&
    isSet(value['names']) &&
    isSet(value['aliases'])
const isFormerMap = (value: unknown): boolean =>
    isRecord(value) &&
    everyValue(value['folded'], isTextList) &&
    everyValue(value['names'], isTextList) &&
    everyValue(value['markdown'], isText)
const isRedirectMap = (value: unknown): boolean =>
    isRecord(value) &&
    typeof value['longest'] === 'number' &&
    Number.isInteger(value['longest']) &&
    value['longest'] >= 0 &&
    everyValue(value['folded'], isText) &&
    everyValue(value['prefixes'], isText) &&
    isSet(value['temporary']) &&
    everyValue(value['counts'], (count) => typeof count === 'number') &&
    Array.isArray(value['prefixLengths']) &&
    value['prefixLengths'].every(
        (length: unknown) => typeof length === 'number' && Number.isInteger(length) && length > 0
    )
const isSiteFile = (value: unknown): value is SiteFile =>
    isRecord(value) &&
    isText(value['file']) &&
    (value['type'] === 'markdown' || value['type'] === 'text')

/**
 * The resolver map that a value read from a release is.
 *
 * @throws when the value is not a resolver map
 */
export function resolverMapFrom(value: unknown): ResolverMap {
    if (
        !isRecord(value) ||
        !everyValue(value['pages'], isText) ||
        !everyValue(value['files'] ?? {}, isSiteFile) ||
        !everyValue(
            value['attachments'] ?? {},
            (key) => typeof key === 'string' && ATTACHMENT_KEY.test(key)
        ) ||
        !everyValue(value['folded'] ?? {}, isText) ||
        !everyValue(value['names'] ?? {}, isTextList) ||
        !everyValue(value['aliases'] ?? {}, isTextList) ||
        !everyValue(value['choices'] ?? {}, isText) ||
        !(value['notFound'] === undefined || isText(value['notFound'])) ||
        !(value['gone'] === undefined || isGoneMap(value['gone'])) ||
        !(value['former'] === undefined || isFormerMap(value['former'])) ||
        !(value['redirects'] === undefined || isRedirectMap(value['redirects']))
    ) {
        throw new Error(`${RESOLVER_MAP_FILE} is not a resolver map`)
    }
    // Checked above, member by member.
    return value as unknown as ResolverMap
}
