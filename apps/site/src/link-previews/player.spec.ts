import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import { Window } from 'happy-dom'
import { videoPlayerScript } from './player.ts'
import { playerAddress } from './video.ts'

// The player of a video card (CARD-09), as a DOM test: the card is a link,
// and only a plain click puts the player in its place.

let window: Window
let document: Document

const CARD = `<div class="link-card link-card-video" data-video-id="GardenTour1" data-video-start="30"><a class="link-card-link" href="https://www.youtube.com/watch?v=GardenTour1&amp;t=30"><img class="link-card-poster" src="/-/link-previews/a.webp" alt=""><span class="link-card-title">A tour of the garden</span></a></div>`

beforeEach(() => {
    window = new Window({ url: 'https://notes.example/Garden+tour' })
    document = window.document as unknown as Document
    document.body.innerHTML = `${CARD}<a id="other" href="/Other">Other</a>`
    runInNewContext(videoPlayerScript, { document })
})

afterEach(async () => {
    await window.happyDOM.close()
})

/** The keys and the button of a click. */
interface ClickInit {
    readonly button?: number
    readonly ctrlKey?: boolean
    readonly metaKey?: boolean
    readonly shiftKey?: boolean
}

function click(target: Element, init: ClickInit = {}): boolean {
    const event = new window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
        ...init
    }) as unknown as MouseEvent
    return target.dispatchEvent(event)
}

describe('the player of a video card (CARD-09)', () => {
    test('the page has no frame before a click; a click on the image loads the player', () => {
        expect(document.querySelector('iframe')).toBeNull()
        const image = document.querySelector('.link-card-poster')
        if (image === null) throw new Error('no image')
        expect(click(image)).toBe(false)
        const frame = document.querySelector('iframe')
        expect(frame?.getAttribute('src')).toBe(playerAddress({ id: 'GardenTour1', start: 30 }))
        expect(frame?.getAttribute('title')).toBe('A tour of the garden')
        expect(frame?.className).toBe('link-card-player')
        expect(document.querySelector('.link-card-video a')).toBeNull()
    })

    test('a click that opens a tab, another button, or a click on another link stays a link', () => {
        const link = document.querySelector('.link-card-link')
        const other = document.querySelector('#other')
        if (link === null || other === null) throw new Error('no link')
        expect(click(link, { ctrlKey: true })).toBe(true)
        expect(click(link, { metaKey: true })).toBe(true)
        expect(click(link, { shiftKey: true })).toBe(true)
        expect(click(link, { button: 1 })).toBe(true)
        expect(click(other)).toBe(true)
        expect(document.querySelector('iframe')).toBeNull()
    })

    test('a card with an id that is not one of YouTube stays a link', () => {
        document.body.innerHTML = CARD.replace('GardenTour1"', 'x" onclick="1"')
        const link = document.querySelector('.link-card-link')
        if (link === null) throw new Error('no link')
        expect(click(link)).toBe(true)
        expect(document.querySelector('iframe')).toBeNull()
    })
})
