import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { parseTreeListing } from '../seal.ts'
import type { Commit, SealedHistory } from '../seal.ts'

// The history of a copy of the content store as the check of the seal reads
// it (R104, `documentation/Canonical Form.md`, "The seal of the content
// store", rule 5), with git: the device of the tool and the deploy read it
// the same way. The Rust twin is in `cli/src/device.rs`.

const run = promisify(execFile)

/** The file of the mark of a copy: the last sealed commit that the copy trusted. */
export function markFile(copy: string): string {
    return join(copy, '.git', 'vault-publish', 'sealed')
}

const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u

/** What runs git: the program and its environment (with no `GIT_*` variable of a caller). */
export interface GitProgram {
    readonly program: string
    readonly environment: NodeJS.ProcessEnv
}

/** The history of the copy in this folder. */
export function gitSealedHistory(copy: string, git: GitProgram): SealedHistory {
    const bytes = async (args: readonly string[], input = ''): Promise<Buffer> => {
        const running = run(git.program, ['-c', 'core.autocrlf=false', ...args], {
            cwd: copy,
            env: git.environment,
            encoding: 'buffer',
            maxBuffer: 1024 * 1024 * 1024
        })
        // Git can end before it reads everything: the error of the pipe is
        // not the error of the command.
        running.child.stdin?.on('error', () => undefined)
        running.child.stdin?.end(input)
        return (await running).stdout
    }
    const text = async (...args: string[]): Promise<string> => (await bytes(args)).toString('utf8')
    return {
        async commits(limit) {
            const head = await text('rev-parse', '--verify', '--quiet', 'HEAD').then(
                (id) => id.trim(),
                () => ''
            )
            if (head === '') {
                return []
            }
            // Each commit: its id, its parents and its message, each ended by a NUL.
            const fields = (
                await text(
                    'log',
                    '--first-parent',
                    '-z',
                    `--max-count=${String(limit)}`,
                    '--format=%H%x00%P%x00%B',
                    'HEAD'
                )
            ).split('\0')
            const commits: Commit[] = []
            for (let index = 0; index + 2 < fields.length; index += 3) {
                commits.push({
                    id: (fields[index] ?? '').trim(),
                    parents: (fields[index + 1] ?? '').split(' ').filter((one) => one !== ''),
                    message: fields[index + 2] ?? ''
                })
            }
            return commits
        },
        async files(commit) {
            return parseTreeListing(await text('ls-tree', '-r', '-z', '--full-tree', commit))
        },
        async objects(ids) {
            const found = new Map<string, string>()
            if (ids.length === 0) {
                return found
            }
            // One read for every object: `<id> <type> <size>` and the bytes,
            // or `<id> missing`.
            const output = await bytes(['cat-file', '--batch'], ids.map((id) => `${id}\n`).join(''))
            let at = 0
            while (at < output.length) {
                const end = output.indexOf(10, at)
                if (end < 0) {
                    break
                }
                const [id, type, size] = output.subarray(at, end).toString('utf8').split(' ')
                if (id === undefined || type === undefined || size === undefined) {
                    at = end + 1
                    continue
                }
                const length = Number(size)
                found.set(id, output.subarray(end + 1, end + 1 + length).toString('utf8'))
                at = end + 1 + length + 1
            }
            return found
        },
        async mark() {
            const value = await readFile(markFile(copy), 'utf8').then(
                (one) => one.trim(),
                () => ''
            )
            return COMMIT_ID.test(value) ? value : undefined
        },
        async setMark(commit) {
            const file = markFile(copy)
            const temporary = `${file}.${randomUUID()}.tmp`
            await mkdir(join(copy, '.git', 'vault-publish'), { recursive: true })
            try {
                await writeFile(temporary, `${commit}\n`)
                await rename(temporary, file)
            } finally {
                await rm(temporary, { force: true })
            }
        },
        async descends(commit, ancestor) {
            return await bytes(['merge-base', '--is-ancestor', ancestor, commit]).then(
                () => true,
                () => false
            )
        }
    }
}
