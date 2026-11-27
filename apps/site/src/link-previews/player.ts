import { VIDEO_FRAME_ORIGIN } from './video.ts'

// The player of a video card (CARD-09). The card is a link to the video with
// a local image: the page loads nothing of the video site. A click on it (or
// Enter on the link) puts the player of the host without cookies in its
// place, which starts at once, at the time of the note; the frame is the one
// host of `frame-src` of the Content Security Policy (SEC-04). A click with
// a key that opens a tab, or with another button, stays a link, and without
// JavaScript the card is a link. A note page with a video card runs this
// script; it is one block, so it declares no global name.

/** The script of the player of the video cards of a page. */
export const videoPlayerScript = `{
    document.addEventListener('click', (event) => {
        if (event.defaultPrevented || event.button !== 0) return
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        const link = event.target.closest?.('[data-video-id] > a.link-card-link')
        if (!link) return
        const card = link.parentElement
        const id = card.dataset.videoId
        const start = card.dataset.videoStart
        if (!/^[A-Za-z0-9_-]{11}$/.test(id) || (start !== undefined && !/^[0-9]+$/.test(start))) return
        event.preventDefault()
        const frame = document.createElement('iframe')
        frame.className = 'link-card-player'
        frame.src = '${VIDEO_FRAME_ORIGIN}/embed/' + id + '?autoplay=1' + (start ? '&start=' + start : '')
        frame.title = link.querySelector('.link-card-title')?.textContent || 'Video'
        frame.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture'
        frame.allowFullscreen = true
        frame.referrerPolicy = 'strict-origin-when-cross-origin'
        link.replaceWith(frame)
        frame.focus()
    })
}`
