import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

// PROTOTYPE (issue 21, hosting). Throwaway code.
//
// Writes invented media files for the checks of the attachments (check 4 of
// the hosting research, and point 3 of the comment of issue 35), named by
// the SHA-256 of their bytes as the attachment storage names them, and adds
// their hashed paths to the resolver map of a built site.
//
//     bun prototype/hosting/media.ts --out <folder> --map <resolver-map.json>
//
// The files: a sound of 30 MiB (a tone, above the limit of 25 MiB of a
// static file), a small sound, a PDF of one page, and an SVG that holds a
// script (the script must not run when the file is opened alone).
// It prints the hashed path, the key and the kind of each file as JSON.

const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { out: { type: 'string' }, map: { type: 'string' } },
    strict: true
})
if (values.out === undefined || values.map === undefined) {
    throw new Error('--out and --map are required')
}

/** A WAV file with a tone: 16 bits, one channel. */
function tone(bytes: number, rate: number): Uint8Array {
    const samples = Math.floor((bytes - 44) / 2)
    const buffer = new ArrayBuffer(44 + samples * 2)
    const view = new DataView(buffer)
    const text = (offset: number, value: string): void => {
        for (let index = 0; index < value.length; index += 1) {
            view.setUint8(offset + index, value.charCodeAt(index))
        }
    }
    text(0, 'RIFF')
    view.setUint32(4, 36 + samples * 2, true)
    text(8, 'WAVEfmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, rate, true)
    view.setUint32(28, rate * 2, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    text(36, 'data')
    view.setUint32(40, samples * 2, true)
    for (let index = 0; index < samples; index += 1) {
        view.setInt16(
            44 + index * 2,
            Math.round(Math.sin((index / rate) * 2 * Math.PI * 440) * 8000),
            true
        )
    }
    return new Uint8Array(buffer)
}

/** A PDF of one page with one line of text. */
function pdf(): Uint8Array {
    const stream = 'BT /F1 24 Tf 72 720 Td (Invented page of the hosting prototype) Tj ET'
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        `<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
    ]
    let text = '%PDF-1.4\n'
    const offsets: number[] = []
    objects.forEach((object, index) => {
        offsets.push(text.length)
        text += `${String(index + 1)} 0 obj\n${object}\nendobj\n`
    })
    const xref = text.length
    text += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`
    for (const offset of offsets) {
        text += `${String(offset).padStart(10, '0')} 00000 n \n`
    }
    text += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`
    return new TextEncoder().encode(text)
}

const svg = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120">' +
        '<rect width="320" height="120" fill="#224"/>' +
        '<text id="t" x="16" y="64" fill="#fff" font-size="18">The script did not run</text>' +
        '<script>document.getElementById("t").textContent = "THE SCRIPT RAN"</script>' +
        '</svg>\n'
)

const files: [string, string, Uint8Array][] = [
    ['large sound', 'long tone.wav', tone(30 * 1024 * 1024, 44100)],
    ['small sound', 'short tone.wav', tone(200 * 1024, 22050)],
    ['pdf', 'one page.pdf', pdf()],
    ['svg with a script', 'drawing.svg', svg]
]

await mkdir(values.out, { recursive: true })
const map = (await Bun.file(values.map).json()) as { attachments?: Record<string, string> }
map.attachments ??= {}
const written: { kind: string; path: string; key: string; bytes: number }[] = []
for (const [kind, name, bytes] of files) {
    const key = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
    await writeFile(join(values.out, key), bytes)
    const path = `/-/attachments/${key}/${encodeURIComponent(name)}`
    map.attachments[path] = key
    written.push({ kind, path, key, bytes: bytes.length })
}
await writeFile(values.map, JSON.stringify(map))
process.stdout.write(`${JSON.stringify(written, null, 2)}\n`)
