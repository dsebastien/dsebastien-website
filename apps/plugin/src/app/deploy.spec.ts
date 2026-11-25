import { describe, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeTestStores, rejectionOf } from '@dsebastien-website/testing'
import { childProcess, deploySettingsOf } from './deploy.ts'

// The port that starts the deploy as a child process (issue 32): a real
// program here, the bun of the tests, never the deploy of the site.

describe('the child process of the deploy', () => {
    test('runs the program with its arguments in the folder, and keeps the whole output', async () => {
        await using stores = await makeTestStores()
        const script = [
            "console.log('to the output')",
            "console.error('to the errors')",
            "console.log('DEPLOY-RESULT ' + JSON.stringify([process.cwd(), process.argv.slice(2)]))",
            'process.exit(3)'
        ].join(';')

        const file = join(stores.root, 'child.ts')
        await writeFile(file, script)

        const run = await childProcess().run({
            program: process.execPath,
            args: [file, 'one argument', "it's"],
            folder: stores.root
        })

        expect(run.code).toBe(3)
        const lines = run.stdout.trimEnd().split('\n')
        expect(lines[0]).toBe('to the output')
        expect(lines.at(-1)).toBe(
            `DEPLOY-RESULT ${JSON.stringify([stores.root, ['one argument', "it's"]])}`
        )
        expect(run.stdout).not.toContain('to the errors')
        expect(run.output).toContain('to the output')
        expect(run.output).toContain('to the errors')
    })

    test('refuses a folder that does not exist, and names it', async () => {
        await using stores = await makeTestStores()
        const folder = join(stores.root, 'missing')

        const message = await rejectionOf(
            childProcess().run({ program: process.execPath, args: ['--version'], folder })
        )

        expect(message).toBe(`the folder of the site code is not a folder: ${folder}`)
    })

    test('refuses a program that does not exist', async () => {
        await using stores = await makeTestStores()

        const message = await rejectionOf(
            childProcess().run({
                program: join(stores.root, 'no-bun'),
                args: [],
                folder: stores.root
            })
        )

        expect(message).toContain('no-bun')
    })
})

describe('the deploy settings of a device', () => {
    test('take the folders of the device and trim every path', () => {
        expect(
            deploySettingsOf({
                contentStore: ' /data/copy ',
                attachmentStorage: '/data/files',
                git: '',
                siteCode: ' /work/site ',
                deployTarget: '/private/target.json',
                deployEnvFile: '',
                bun: ' /opt/bun '
            })
        ).toEqual({
            siteCode: '/work/site',
            target: '/private/target.json',
            envFile: '',
            bun: '/opt/bun',
            contentStore: '/data/copy',
            attachments: '/data/files'
        })
    })
})
