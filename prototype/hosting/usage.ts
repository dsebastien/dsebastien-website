import { parseArgs } from 'node:util'

// PROTOTYPE (issue 21, hosting). Throwaway code.
//
// Reads the usage of the test Worker and of the test bucket from the
// analytics of the host (check 6 of the hosting research): the requests, the
// errors, the subrequests and the CPU time of the Worker, and the operations
// of the bucket by kind. The account, the token, the Worker and the bucket
// come from the environment (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`,
// `PROTO_WORKER`, `PROTO_BUCKET`).
//
//     bun prototype/hosting/usage.ts [--since <ISO time>]

const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { since: { type: 'string' } },
    strict: true
})
const account = process.env['CLOUDFLARE_ACCOUNT_ID'] ?? ''
const token = process.env['CLOUDFLARE_API_TOKEN'] ?? ''
const worker = process.env['PROTO_WORKER'] ?? ''
const bucket = process.env['PROTO_BUCKET'] ?? ''
const since = values.since ?? new Date(Date.now() - 6 * 3600 * 1000).toISOString()
const until = new Date().toISOString()

const query = `{
  viewer {
    accounts(filter: { accountTag: "${account}" }) {
      workersInvocationsAdaptive(
        limit: 1000
        filter: { scriptName: "${worker}", datetime_geq: "${since}", datetime_leq: "${until}" }
      ) {
        sum { requests errors subrequests }
        quantiles { cpuTimeP50 cpuTimeP99 }
        dimensions { status }
      }
      r2OperationsAdaptiveGroups(
        limit: 1000
        filter: { bucketName: "${bucket}", datetime_geq: "${since}", datetime_leq: "${until}" }
      ) {
        sum { requests }
        dimensions { actionType }
      }
    }
  }
}`

const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query })
})
process.stdout.write(`${JSON.stringify(await response.json(), null, 1)}\n`)
