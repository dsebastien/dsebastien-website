import { barStep, isClosed, remember, type BarView } from './bar.ts'
import { signUp, type SignupResult } from './signup.ts'

// The script of the newsletter bar of a note page (NEWS-01, NEWS-04): a view
// over the rules of `bar.ts` and the signup of `signup.ts`. It is a module of
// the build (a file of the site, pinned with it); the markup has no inline
// handler and no inline style: the bar shows and hides with its `hidden`
// attribute; its message is a live region that is empty until a result. The browser test of issue 57
// (`newsletter-page.spec.ts`) drives it.

/** How long the message of a signup stays before the bar closes, as today. */
const MESSAGE_TIME = 5_000

/** The messages of the bar, as the current site writes them. */
export const MESSAGES = {
    sent: 'Success! Please check your email to confirm your subscription.',
    already: 'You are already subscribed. Thank you!',
    invalid: 'Please enter a valid email address',
    failed: 'Network error. Please check your connection and try again.'
} as const

/** The kind of the message of a result: its look. */
function kindOf(result: SignupResult): 'success' | 'error' {
    return result.kind === 'sent' || result.kind === 'already' ? 'success' : 'error'
}

/** The text of the message of a result. */
function messageOf(result: SignupResult): string {
    return result.kind === 'refused' ? result.message : MESSAGES[result.kind]
}

/** Starts the bar of a page, when the page has one. */
export function startNewsletterBar(page: Document, window: Window): void {
    const bar = page.querySelector<HTMLElement>('[data-newsletter]')
    const note = page.querySelector<HTMLElement>('[data-note-body]')
    const footer = page.querySelector<HTMLElement>('footer')
    if (bar === null || note === null || footer === null) {
        return
    }
    const form = bar.querySelector<HTMLFormElement>('[data-newsletter-form]')
    const email = bar.querySelector<HTMLInputElement>('input[type="email"]')
    const submit = bar.querySelector<HTMLButtonElement>('button[type="submit"]')
    const message = bar.querySelector<HTMLElement>('[data-newsletter-message]')
    const dismiss = bar.querySelector<HTMLButtonElement>('[data-newsletter-dismiss]')
    if (
        form === null ||
        email === null ||
        submit === null ||
        message === null ||
        dismiss === null
    ) {
        return
    }
    const storage = ((): Storage | undefined => {
        try {
            return window.localStorage
        } catch {
            return undefined
        }
    })()
    let closed = storage === undefined ? false : isClosed(storage)
    if (closed) {
        return
    }
    let reached = false
    // A message of a signup holds the bar until it closes.
    let holding = false
    let frame = 0
    // A hidden bar has no height: the last one that it had, else a guess.
    let barHeight = 120

    const viewOf = (): BarView => {
        const top = window.scrollY
        const noteBox = note.getBoundingClientRect()
        return {
            scrollTop: top,
            viewportHeight: window.innerHeight,
            noteTop: noteBox.top + top,
            noteHeight: noteBox.height,
            footerTop: footer.getBoundingClientRect().top + top,
            barHeight: bar.hidden ? barHeight : (barHeight = bar.offsetHeight)
        }
    }
    const update = (): void => {
        frame = 0
        const step = barStep(reached, viewOf(), {
            closed,
            focused: holding || bar.contains(page.activeElement)
        })
        reached = step.reached
        bar.hidden = !step.shown
    }
    const schedule = (): void => {
        if (frame === 0) frame = window.requestAnimationFrame(update)
    }
    const close = (why: 'signed-up' | 'dismissed'): void => {
        closed = true
        holding = false
        if (storage !== undefined) remember(storage, why)
        bar.hidden = true
        window.removeEventListener('scroll', schedule)
        window.removeEventListener('resize', schedule)
    }
    const show = (text: string, kind: 'success' | 'error'): void => {
        message.textContent = text
        message.dataset['kind'] = kind
    }

    form.addEventListener('submit', (event) => {
        event.preventDefault()
        if (submit.disabled) return
        message.textContent = ''
        submit.disabled = true
        form.setAttribute('aria-busy', 'true')
        void signUp(email.value).then((result) => {
            submit.disabled = false
            form.removeAttribute('aria-busy')
            show(messageOf(result), kindOf(result))
            if (kindOf(result) === 'success') {
                // Closed for good at once; the message stays a moment, as today.
                if (storage !== undefined) remember(storage, 'signed-up')
                holding = true
                form.hidden = true
                dismiss.hidden = true
                window.setTimeout(() => {
                    close('signed-up')
                }, MESSAGE_TIME)
            }
        })
    })
    dismiss.addEventListener('click', () => {
        close('dismissed')
    })
    bar.addEventListener('focusout', schedule)
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    update()
}
