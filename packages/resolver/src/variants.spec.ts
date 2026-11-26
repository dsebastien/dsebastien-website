import { describe, expect, test } from 'bun:test'
import {
    hasVariants,
    imageKeyOf,
    imageVariants,
    VARIANT_GENERATION,
    VARIANT_WIDTHS,
    variantAt,
    variantKey,
    variantKeysOf,
    variantPath
} from './variants.ts'

// The variants of an image (issue 87, PERF-25).
const KEY = 'a9526809f9da4f3a083bceb07247ac2633b41de1ddf9cad8d37e0a518b550a33'
const OTHER = 'b9526809f9da4f3a083bceb07247ac2633b41de1ddf9cad8d37e0a518b550a33'

describe('the variants of an image', () => {
    test('a photo, a screenshot and a WebP get variants; an SVG, a GIF and a PDF do not', () => {
        expect(['a.jpg', 'a.JPEG', 'a.png', 'a.webp'].map(hasVariants)).toEqual([
            true,
            true,
            true,
            true
        ])
        expect(['a.svg', 'a.gif', 'a.pdf', 'a.avif', 'png'].map(hasVariants)).toEqual([
            false,
            false,
            false,
            false,
            false
        ])
    })

    test('each width below the width of the image, then the whole image', () => {
        expect(imageVariants('cover.jpg', 1000, 1500)).toEqual([
            { step: 480, width: 480, height: 720 },
            { step: 800, width: 800, height: 1200 },
            { step: 1200, width: 1000, height: 1500 }
        ])
        expect(imageVariants('wide.png', 4000, 1000).map((variant) => variant.width)).toEqual([
            ...VARIANT_WIDTHS
        ])
        expect(imageVariants('exact.png', 800, 600)).toEqual([
            { step: 480, width: 480, height: 360 },
            { step: 800, width: 800, height: 600 }
        ])
    })

    test('a small image and a kind with no variant get none', () => {
        expect(imageVariants('icon.png', 480, 480)).toEqual([])
        expect(imageVariants('plan.svg', 2000, 1000)).toEqual([])
        expect(imageVariants('thin.png', 3000, 1)).toEqual([
            { step: 480, width: 480, height: 1 },
            { step: 800, width: 800, height: 1 },
            { step: 1200, width: 1200, height: 1 },
            { step: 1600, width: 1600, height: 1 }
        ])
    })
})

describe('the names and the addresses of the variants', () => {
    test('a variant is named by the key of its image, its width and its generation', () => {
        expect(variantKey(KEY, 800)).toBe(`${KEY}-w800-${String(VARIANT_GENERATION)}.webp`)
        expect(variantKeysOf(KEY)).toEqual(VARIANT_WIDTHS.map((step) => variantKey(KEY, step)))
        expect(() => variantKey('not a key', 800)).toThrow()
    })

    test('each name of the storage belongs to the key of its image', () => {
        expect(imageKeyOf(KEY)).toBe(KEY)
        for (const name of variantKeysOf(KEY)) {
            expect(imageKeyOf(name)).toBe(KEY)
        }
        // A variant of an older generation, or of a width of no generation, follows its image too.
        expect(imageKeyOf(`${KEY}-w801-${String(VARIANT_GENERATION)}.webp`)).toBe(KEY)
        // A generation that does not exist yet, another form: no file of a release.
        expect(imageKeyOf(`${KEY}-w800-${String(VARIANT_GENERATION + 1)}.webp`)).toBeUndefined()
        expect(imageKeyOf(`${KEY}-w800-0.webp`)).toBeUndefined()
        expect(imageKeyOf(`${KEY}-w0800-${String(VARIANT_GENERATION)}.webp`)).toBeUndefined()
        expect(imageKeyOf(`${KEY}.part`)).toBeUndefined()
        expect(imageKeyOf('.DS_Store')).toBeUndefined()
    })

    test('the address of a variant comes from the address of its image', () => {
        expect(variantPath(`/-/attachments/${KEY}/Garden%20plan.png`, 480)).toBe(
            `/-/attachments/${KEY}/w480-${String(VARIANT_GENERATION)}/Garden%20plan.webp`
        )
        expect(variantPath(`/-/attachments/${KEY}/plan.v2.JPG`, 1600)).toBe(
            `/-/attachments/${KEY}/w1600-${String(VARIANT_GENERATION)}/plan.v2.webp`
        )
        expect(() => variantPath('/-/note/a.html', 480)).toThrow()
    })

    test('the release gives a variant only of an image that it uses', () => {
        const attachments = {
            [`/-/attachments/${KEY}/Garden%20plan.png`]: KEY,
            [`/-/attachments/${OTHER}/plan.svg`]: OTHER
        }
        const address = variantPath(`/-/attachments/${KEY}/Garden%20plan.png`, 800)
        expect(variantAt(address, attachments)).toEqual({
            key: variantKey(KEY, 800),
            name: 'Garden plan.webp'
        })
        // Another name, another key, an SVG, another generation.
        expect(variantAt(address.replace('Garden%20plan', 'Other'), attachments)).toBeUndefined()
        expect(variantAt(address.replace(KEY, OTHER), attachments)).toBeUndefined()
        expect(
            variantAt(variantPath(`/-/attachments/${OTHER}/plan.svg`, 800), attachments)
        ).toBeUndefined()
        expect(
            variantAt(address.replace(`-${String(VARIANT_GENERATION)}/`, '-0/'), attachments)
        ).toBeUndefined()
        expect(variantAt(address, {})).toBeUndefined()
    })
})
