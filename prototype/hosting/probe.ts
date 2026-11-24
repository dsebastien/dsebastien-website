import { parseArgs } from 'node:util'

// PROTOTYPE (issue 21, hosting). Throwaway code.
//
// Asks a host for the answers that the checks 3 and 4 of the hosting
// research read (HTML and Markdown apart, ranges of a media file, the
// headers of an attachment), and prints them.
//
//     bun prototype/hosting/probe.ts --base <address> --media <media.json> [--page /Welcome]
//         [--media-base <address of the media host>]

const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
        'base': { type: 'string' },
        'media': { type: 'string' },
        'page': { type: 'string', default: '/Welcome' },
        'media-base': { type: 'string' }
    },
    strict: true
})
if (values.base === undefined || values.media === undefined) {
    throw new Error('--base and --media are required')
}
const base = values.base.replace(/\/+$/u, '')
const media = (await Bun.file(values.media).json()) as {
    kind: string
    path: string
    key: string
    bytes: number
}[]

const SHOWN = [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'cache-control',
    'content-security-policy',
    'x-content-type-options',
    'vary',
    'etag',
    'cf-cache-status',
    'x-proto-isolate',
    'x-proto-first-ms',
    'location'
]

const lines: string[] = []

async function ask(
    name: string,
    address: string,
    headers: Record<string, string> = {}
): Promise<Response> {
    const started = performance.now()
    const response = await fetch(address, { redirect: 'manual', headers })
    const body = await response.arrayBuffer()
    const shown = SHOWN.flatMap((header) => {
        const value = response.headers.get(header)
        return value === null ? [] : [`${header}: ${value}`]
    })
    lines.push(
        `${name}\n    ${String(response.status)}, ${String(body.byteLength)} bytes, ${String(Math.round(performance.now() - started))} ms\n    ${shown.join('\n    ')}`
    )
    return new Response(body, response)
}

// Check 3: one page as HTML and as Markdown, several times, in a mixed order.
for (const accept of [
    'text/html',
    'text/markdown',
    'text/html',
    'text/markdown',
    'text/markdown, text/html;q=0.9',
    'text/html, text/markdown;q=0.5',
    '*/*'
]) {
    const response = await ask(`page with Accept: ${accept}`, `${base}${values.page}`, { accept })
    const text = await response.text()
    lines.push(`    body starts with: ${JSON.stringify(text.slice(0, 40))}`)
}
await ask('the Markdown URL of the page', `${base}/-/md${values.page}.md`)

// Check 4 and issue 35: the attachments through the Worker.
for (const file of media) {
    await ask(`${file.kind}, whole`, `${base}${file.path}`)
}
const large = media.find((file) => file.kind === 'large sound')
if (large !== undefined) {
    const last = large.bytes - 1
    await ask('large sound, first 1,000 bytes', `${base}${large.path}`, { range: 'bytes=0-999' })
    await ask('large sound, last 10 bytes', `${base}${large.path}`, { range: 'bytes=-10' })
    await ask('large sound, from the middle', `${base}${large.path}`, {
        range: `bytes=${String(Math.floor(last / 2))}-${String(Math.floor(last / 2) + 65535)}`
    })
    await ask('large sound, a range outside the file', `${base}${large.path}`, {
        range: `bytes=${String(large.bytes + 10)}-`
    })
}

// The same files on the media host, by their keys.
if (values['media-base'] !== undefined) {
    const mediaBase = values['media-base'].replace(/\/+$/u, '')
    for (const file of media) {
        await ask(`media host: ${file.kind}, whole`, `${mediaBase}/${file.key}`)
    }
    if (large !== undefined) {
        await ask('media host: large sound, first 1,000 bytes', `${mediaBase}/${large.key}`, {
            range: 'bytes=0-999'
        })
        await ask('media host: large sound, last 10 bytes', `${mediaBase}/${large.key}`, {
            range: 'bytes=-10'
        })
        await ask(
            'media host: large sound, a range outside the file',
            `${mediaBase}/${large.key}`,
            {
                range: `bytes=${String(large.bytes + 10)}-`
            }
        )
    }
}

process.stdout.write(`${lines.join('\n')}\n`)
