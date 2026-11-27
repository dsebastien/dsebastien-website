import { describe, expect, test } from 'bun:test'
import { playerAddress, videoOf } from './video.ts'

describe('the video of an address (CARD-09)', () => {
    test('reads the id of each form of a YouTube address', () => {
        for (const address of [
            'https://www.youtube.com/watch?v=GardenTour1',
            'https://youtube.com/watch?v=GardenTour1&list=PL1',
            'https://m.youtube.com/watch?v=GardenTour1',
            'https://youtu.be/GardenTour1',
            'https://www.youtube.com/shorts/GardenTour1',
            'https://www.youtube.com/embed/GardenTour1',
            'https://www.youtube.com/live/GardenTour1'
        ]) {
            expect(videoOf(address)).toEqual({ id: 'GardenTour1' })
        }
    })

    test('keeps the start time, in seconds or in hours, minutes and seconds', () => {
        expect(videoOf('https://youtu.be/GardenTour1?t=90')).toEqual({
            id: 'GardenTour1',
            start: 90
        })
        expect(videoOf('https://www.youtube.com/watch?v=GardenTour1&t=1h2m3s')).toEqual({
            id: 'GardenTour1',
            start: 3723
        })
        expect(videoOf('https://www.youtube.com/watch?v=GardenTour1&start=12')).toEqual({
            id: 'GardenTour1',
            start: 12
        })
        expect(videoOf('https://www.youtube.com/watch?v=GardenTour1&t=soon')).toEqual({
            id: 'GardenTour1'
        })
    })

    test('gives nothing for another host, no id, or an id that is not one of YouTube', () => {
        expect(videoOf('https://garden.example/watch?v=GardenTour1')).toBeUndefined()
        expect(videoOf('https://www.youtube.com/watch')).toBeUndefined()
        expect(videoOf('https://www.youtube.com/watch?v=short')).toBeUndefined()
        expect(videoOf('https://youtu.be/"><script>')).toBeUndefined()
        expect(videoOf('not an address')).toBeUndefined()
    })

    test('the player is on the host without cookies, and starts at the time of the note', () => {
        expect(playerAddress({ id: 'GardenTour1' })).toBe(
            'https://www.youtube-nocookie.com/embed/GardenTour1?autoplay=1'
        )
        expect(playerAddress({ id: 'GardenTour1', start: 90 })).toBe(
            'https://www.youtube-nocookie.com/embed/GardenTour1?autoplay=1&start=90'
        )
    })
})
