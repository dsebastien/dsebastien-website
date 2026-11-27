// The video of a video card (CARD-09): the id of a YouTube video and the
// time where the note starts it, read from the address that the note
// writes. Only an id of the form of YouTube is read, so the id can go into
// an address and an attribute as it is. The player loads only after a click,
// from the host of YouTube without cookies, which is the only host of a frame
// of the Content Security Policy (SEC-04, `page-policy.ts`).

/** The only host of a frame (SEC-04): the video host without cookies. */
export const VIDEO_FRAME_ORIGIN = 'https://www.youtube-nocookie.com'

/** The hosts of a YouTube address that a video card reads. */
export const VIDEO_HOSTS: ReadonlySet<string> = new Set([
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'youtu.be'
])

/** A video of YouTube. */
export interface Video {
    /** Its id: 11 letters, digits, `-` or `_`. */
    readonly id: string
    /** The second where the note starts it, when the address gives one. */
    readonly start?: number
}

const ID = /^[A-Za-z0-9_-]{11}$/u
/** The paths of a video on the host of YouTube: `/shorts/<id>`, `/embed/<id>`, `/live/<id>`. */
const PATH = /^\/(?:shorts|embed|live)\/([^/]+)\/?$/u
const TIME = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/u

/** A start time in seconds: `90`, `90s` or `1h2m3s`. */
function secondsOf(value: string | null): number | undefined {
    if (value === null || value === '') return undefined
    const match = TIME.exec(value)
    if (match === null) return undefined
    const [, hours = '0', minutes = '0', seconds = '0'] = match
    const total = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)
    return total > 0 ? total : undefined
}

/** The video of a YouTube address, or `undefined` for any other address. */
export function videoOf(address: string): Video | undefined {
    let url: URL
    try {
        url = new URL(address)
    } catch {
        return undefined
    }
    if (!VIDEO_HOSTS.has(url.hostname)) return undefined
    const id =
        url.hostname === 'youtu.be'
            ? url.pathname.slice(1)
            : url.pathname === '/watch'
              ? (url.searchParams.get('v') ?? '')
              : (PATH.exec(url.pathname)?.[1] ?? '')
    if (!ID.test(id)) return undefined
    const start = secondsOf(url.searchParams.get('t') ?? url.searchParams.get('start'))
    return start === undefined ? { id } : { id, start }
}

/** The address of the player of a video, which starts at once: after the click of the reader. */
export function playerAddress(video: Video): string {
    const start = video.start === undefined ? '' : `&start=${String(video.start)}`
    return `${VIDEO_FRAME_ORIGIN}/embed/${video.id}?autoplay=1${start}`
}
