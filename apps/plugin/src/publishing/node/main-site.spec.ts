import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createServer, get as httpGet, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { rejectionOf } from '@dsebastien-website/testing'
import { CHECK_REDIRECTS, CHECK_USER_AGENT } from '../originals.ts'
import { followPage, requestWith, type OneAnswer, type OneRequest } from './main-site.ts'

// The main site over the network (PUB-100). The redirects are tested with a
// fake request, and one request with a local server over plain HTTP: no
// test reaches the real main site.

function answers(table: Record<string, OneAnswer>): { request: OneRequest; asked: string[] } {
    const asked: string[] = []
    return {
        asked,
        request: (url) => {
            asked.push(url)
            const answer = table[url]
            return answer === undefined
                ? Promise.reject(new Error(`no answer for ${url}`))
                : Promise.resolve(answer)
        }
    }
}

describe('the redirects of a check', () => {
    test('are followed within https, and the answer names the last URL', async () => {
        const { request, asked } = answers({
            'https://www.example.net/a': { status: 301, location: '/a/', body: '' },
            'https://www.example.net/a/': { status: 200, location: undefined, body: 'page' }
        })
        expect(await followPage('https://www.example.net/a', request)).toEqual({
            status: 200,
            url: 'https://www.example.net/a/',
            body: 'page'
        })
        expect(asked).toEqual(['https://www.example.net/a', 'https://www.example.net/a/'])
    })

    test('never lead out of https', async () => {
        const { request, asked } = answers({
            'https://www.example.net/a/': {
                status: 302,
                location: 'http://www.example.net/a/',
                body: ''
            }
        })
        expect(await rejectionOf(followPage('https://www.example.net/a/', request))).toContain(
            'https only'
        )
        expect(asked).toEqual(['https://www.example.net/a/'])
    })

    test('stop after a few', async () => {
        const request: OneRequest = (url) =>
            Promise.resolve({ status: 302, location: `${url}x`, body: '' })
        expect(await rejectionOf(followPage('https://www.example.net/', request))).toContain(
            `more than ${String(CHECK_REDIRECTS)} redirects`
        )
    })

    test('share one time limit', async () => {
        let time = 0
        const request: OneRequest = (url, left) => {
            expect(left).toBe(1000 - time)
            time += 600
            return Promise.resolve({ status: 302, location: `${url}x`, body: '' })
        }
        expect(
            await rejectionOf(followPage('https://www.example.net/', request, 1000, () => time))
        ).toContain('did not answer')
    })

    test('an answer that is not a redirect is the page, whatever its status', async () => {
        const { request } = answers({
            'https://www.example.net/gone/': { status: 404, location: undefined, body: 'no' }
        })
        expect((await followPage('https://www.example.net/gone/', request)).status).toBe(404)
    })
})

describe('one request', () => {
    let server: Server
    let origin = ''
    const agents: (string | undefined)[] = []

    beforeAll(async () => {
        server = createServer((request, response) => {
            agents.push(request.headers['user-agent'])
            if (request.url === '/large/') {
                response.writeHead(200, { 'content-type': 'text/html' })
                // No length: the limit counts the bytes as they come.
                response.write('x'.repeat(600))
                response.end('x'.repeat(600))
            } else if (request.url === '/slow/') {
                setTimeout(() => response.end('late'), 2000)
            } else if (request.url === '/moved/') {
                response.writeHead(301, { location: '/page/' })
                response.end('moved')
            } else {
                response.writeHead(200, { 'content-type': 'text/html' })
                response.end('<head><link rel="canonical" href="/page/"></head>')
            }
        })
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    })

    afterAll(async () => {
        server.closeAllConnections()
        await new Promise((resolve) => server.close(resolve))
    })

    const request = requestWith(httpGet, 1000)

    test('reads the page and names the tool in its user agent', async () => {
        const answer = await request(`${origin}/page/`, 5000)
        expect(answer.status).toBe(200)
        expect(answer.body).toContain('canonical')
        expect(agents.at(-1)).toBe(CHECK_USER_AGENT)
    })

    test('gives the location of a redirect and reads none of its body', async () => {
        expect(await request(`${origin}/moved/`, 5000)).toEqual({
            status: 301,
            location: '/page/',
            body: ''
        })
    })

    test('fails above the size limit', async () => {
        expect(await rejectionOf(request(`${origin}/large/`, 5000))).toContain('larger than')
    })

    test('fails after its time limit', async () => {
        expect(await rejectionOf(request(`${origin}/slow/`, 100))).toContain('did not answer')
    })
})
