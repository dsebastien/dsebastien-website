import { parseArgs } from 'node:util'

// PROTOTYPE (issue 21, hosting). Throwaway code.
//
// Watches a page and its Markdown during a deployment or a revert (check 5
// of the hosting research, and point 8 of its section 5): it asks for them
// in a loop and prints each change of what it sees (the mark of the second
// release or not, another status, a failure).
//
//     bun prototype/hosting/watch.ts --base <address> --page <canonical path> \
//         [--mark release-2] [--seconds 120] [--every 250]

const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
        base: { type: 'string' },
        page: { type: 'string' },
        mark: { type: 'string', default: 'release-2' },
        seconds: { type: 'string', default: '120' },
        every: { type: 'string', default: '250' }
    },
    strict: true
})
if (values.base === undefined || values.page === undefined) {
    throw new Error('--base and --page are required')
}
const base = values.base.replace(/\/+$/u, '')
const paths = [values.page, `/-/md${values.page}.md`]
const started = Date.now()
const last = new Map<string, string>()
const counts = new Map<string, number>()

async function look(path: string): Promise<string> {
    try {
        const response = await fetch(`${base}${path}`, { redirect: 'manual' })
        const text = await response.text()
        if (response.status !== 200) {
            return `status ${String(response.status)}`
        }
        return text.includes(`<!-- ${values.mark} -->`) ? 'new release' : 'old release'
    } catch (error) {
        return `no answer (${error instanceof Error ? error.message : String(error)})`
    }
}

while (Date.now() - started < Number(values.seconds) * 1000) {
    for (const path of paths) {
        const seen = await look(path)
        const key = `${path === values.page ? 'page' : 'markdown'}: ${seen}`
        counts.set(key, (counts.get(key) ?? 0) + 1)
        if (last.get(path) !== seen) {
            last.set(path, seen)
            process.stdout.write(
                `${((Date.now() - started) / 1000).toFixed(1)} s  ${path === values.page ? 'page' : 'markdown'}: ${seen}\n`
            )
        }
    }
    await Bun.sleep(Number(values.every))
}
process.stdout.write(`${JSON.stringify(Object.fromEntries(counts))}\n`)
