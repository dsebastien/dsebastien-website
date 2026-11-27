import { samplePhoto } from '@dsebastien-website/testing'
import { readLinkPreviews, type FetchPort } from './previews.ts'

// The previews of the cards of the fixture vault, for the tests and the
// budgets (issue 86): a cache made with a fake web of invented photos, so a
// build with `LINK_PREVIEWS=cache` shows the images of the cards and makes no
// request. The card of `garden.example/soil` gets a picture of the size of
// an `og:image` (`40 Writing/Reading list.md`), the video card of
// `50 Field guide/Queries/Video URL line.md` a still image and a title.

/** The title of the video of the fixture vault, as the fake web gives it. */
export const SAMPLE_VIDEO_TITLE = 'A tour of the garden'

const OEMBED =
    'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DGardenTour1&format=json'

/** A fake web that knows the previews of two cards of the fixture vault, and answers 404 for any other address. */
async function sampleWeb(): Promise<FetchPort> {
    const photo = await samplePhoto(1200, 630, 150_000, 86)
    const still = await samplePhoto(480, 360, 30_000, 87)
    const html = (head: string): Response =>
        new Response(`<!doctype html><html><head>${head}</head></html>`, {
            headers: { 'content-type': 'text/html; charset=utf-8' }
        })
    const answers = new Map<string, () => Response>([
        [
            'https://garden.example/soil',
            () => html('<meta property="og:image" content="/images/soil.jpg">')
        ],
        [
            'https://garden.example/images/soil.jpg',
            () => new Response(new Uint8Array(photo), { headers: { 'content-type': 'image/jpeg' } })
        ],
        [
            'https://i.ytimg.com/vi/GardenTour1/hqdefault.jpg',
            () => new Response(new Uint8Array(still), { headers: { 'content-type': 'image/jpeg' } })
        ],
        [OEMBED, () => Response.json({ title: SAMPLE_VIDEO_TITLE })]
    ])
    return (url) => Promise.resolve(answers.get(url)?.() ?? new Response('', { status: 404 }))
}

/** Writes the previews of the fixture cards into a cache folder. */
export async function writePreviewSample(cache: string): Promise<void> {
    await readLinkPreviews(
        [
            { url: 'https://garden.example/soil', video: false },
            { url: 'https://www.youtube.com/watch?v=GardenTour1', video: true }
        ],
        { cache, fetch: await sampleWeb(), now: new Date('2031-05-01T00:00:00Z') }
    )
}
