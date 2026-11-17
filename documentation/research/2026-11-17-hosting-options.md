# Hosting options (2026-11-17)

Input for decision D3 of `documentation/plans/spec-v1.md` (section 5.5). This file compares the places where the static notes site can run.

How to read it:

- Every limit and price comes from primary documentation, read on 2026-11-17. The source link sits next to the number.
- "unverified" marks a number or a behavior that no primary source confirmed, or that is an estimate.
- Nothing in this file was tested on a live account. Section 5 lists the tests.
- Prices are in US dollars, without tax.
- The zone plan (Free, Pro, Business) changes some answers. The cost figures assume the Free zone plan. The text says where a paid zone plan matters.

Working figures:

| Figure                                                                | Value                                             | Status                                      |
| --------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------- |
| Note pages                                                            | 20,735                                            | Measured (research 1.2)                     |
| Attachments                                                           | 13,970 files, 788 MB                              | Measured (research 1.2)                     |
| Largest files                                                         | Two videos (27 MB, 13 MB), one audio file (18 MB) | Measured (research 1.2)                     |
| Names that the resolver knows                                         | About 48,000                                      | Measured (research 1.6)                     |
| Output files                                                          | More than 100,000                                 | Estimate of spec 5.5, unverified            |
| Release-bound files (see below)                                       | About 45,000                                      | Estimate, unverified                        |
| Output size                                                           | 5 GB                                              | Working figure for "several GB", unverified |
| Requests that one browser page view adds (CSS, script, fonts, images) | 5                                                 | Assumption, unverified                      |
| Publications                                                          | 4 per day, 300 changed files each                 | Assumption from the requirement, unverified |

Two terms that this file uses:

- **Release-bound file**: a file whose content can change while its URL stays the same. HTML pages, Markdown twins, feeds, sitemaps, discovery files.
- **Immutable file**: a file with a content hash in its name. Image variants, media, hashed CSS and scripts. A new content gives a new name, so the file never changes and never needs a purge.

## 1. Recommendation

Use option G: one Cloudflare Worker with Workers Static Assets for the release-bound files, one R2 bucket for the immutable files, and the resolver map bundled in the Worker. The single strongest reason: a release is then one Worker version, so the pages, the Markdown twins, the resolver map and the code switch together and roll back together with one command, and no HTML cache exists that a deployment must purge ([versions][w-versions], [rollbacks][w-rollbacks], [static assets][sa]). No server exists that a crawler can overload, requests for files are free ([pricing][w-pricing]), and the fixed cost is $5 per month. Option A (the self-managed server) is the fallback and the exit path: since 2026-07-02 the Cloudflare cache can keep HTML and Markdown apart with a `Vary` setting on all plans ([changelog][c-vary-changelog]), so A no longer needs code at the edge. Option B is the second fallback, if the limit of 100,000 files per Worker version or the path matching of Static Assets blocks G. Options C alone, D and E do not fit the site. Option F adds nothing to A. The remote MCP server with code mode (section 7) does not change this choice: it is a second Worker in G and in B, and it makes option A weaker, because it would run scripts from anonymous callers on the shared server.

## 2. Comparison table

| Requirement                                  | A: own server                                                   | B: R2 + Worker                             | C: Static Assets                             | D: Pages                            | E: GitHub Pages        | F: hybrid                      | G: Static Assets + R2                              |
| -------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------- | ----------------------------------- | ---------------------- | ------------------------------ | -------------------------------------------------- |
| File count limit                             | None                                                            | None                                       | 100,000 per version (20,000 on Workers Free) | 20,000, or 100,000 on a paid plan   | None stated            | None                           | 100,000 for release-bound files, none for the rest |
| File size limit                              | None (cache: 512 MB)                                            | 5 TiB                                      | 25 MiB                                       | 25 MiB                              | Site: 1 GB in total    | As A                           | 25 MiB in Static Assets, 5 TiB in R2               |
| Fits more than 100,000 files, 5 GB           | Yes                                                             | Yes                                        | No                                           | No                                  | No                     | Yes                            | Yes, with the split                                |
| Resolver, 48,000 names, one redirect         | Yes: local service or nginx `map`                               | Yes: in the Worker                         | Yes: in the Worker                           | Yes: in a Pages Function            | No                     | Yes, at the origin             | Yes: in the Worker                                 |
| Markdown on request                          | Yes: origin + `Vary` cache rule                                 | Yes: the Worker selects the object         | Yes: the Worker selects the asset            | Yes: the Function selects the asset | No                     | As A                           | Yes: the Worker selects the asset                  |
| HTML and Markdown apart in the cache         | Cache rule with `vary`                                          | No shared cache by default                 | No shared cache                              | No shared cache                     | Not applicable         | As A                           | No shared cache                                    |
| Atomic release                               | Symbolic link switch, own script                                | Own manifest, switched by a Worker version | Built in                                     | Built in                            | Per deployment         | As A                           | Built in                                           |
| Instant rollback                             | Switch the link back, purge                                     | `wrangler rollback`                        | `wrangler rollback`                          | Dashboard                           | No command             | As A                           | `wrangler rollback`                                |
| Purge of changed URLs                        | Needed: API call after each switch                              | Not needed without a cache                 | Not needed                                   | Not needed                          | Not possible           | As A                           | Not needed                                         |
| Several publications per day                 | Yes                                                             | Yes, with own upload tool                  | Yes                                          | Yes                                 | Soft limits            | As A                           | Yes                                                |
| Crawler load                                 | Cache misses reach the server                                   | No server. Requests are billed             | No server. File requests are free            | No server                           | Provider rate limits   | As A                           | No server. File requests are free                  |
| Range requests (video, audio)                | Yes                                                             | Yes                                        | No (answers 200)                             | No (answers 200)                    | unverified             | Yes                            | Yes, from R2                                       |
| Remote MCP server with code mode (section 7) | Possible. Own sandbox on the shared server: a new security risk | Yes: a second Worker                       | Yes: a second Worker                         | Yes: a second Worker                | No                     | As A, or a Worker for MCP only | Yes: a second Worker                               |
| Cost at 1,000,000 page requests              | $0 new cost                                                     | $5                                         | $5                                           | unverified                          | $0                     | $0 to $5                       | $5                                                 |
| Operations work                              | Highest: server, purge, origin protection                       | Medium: own release tool                   | Lowest                                       | Lowest                              | Lowest                 | As A, plus edge rules          | Low: two upload targets                            |
| Leaving Cloudflare                           | Nothing to rewrite                                              | Copy the bucket, rewrite the glue          | Rewrite the glue                             | Rewrite the glue                    | Not tied to Cloudflare | Move the rule to the origin    | Copy the bucket, rewrite the glue                  |
| Verdict                                      | Fits. Fallback and exit path                                    | Fits. Second fallback                      | Does not fit alone                           | Does not fit                        | Does not fit           | No gain over A                 | Recommended                                        |

## 3. The options

### 3.0 Facts that several options share

These facts are about the Cloudflare cache and rules in front of the domain. Options A and F depend on all of them. The other options depend on some.

1. **Order.** A Worker (a JavaScript or TypeScript function that Cloudflare runs in its data centers for each matching request) runs before the cache ([how the cache works][w-cache-how]). A request that hits a Worker is billed also when the response comes from the cache ([pricing][w-pricing]).
2. **HTML is not cached by default.** The cache selects by file extension, and HTML and JSON are not in the list. A Cache Rule (a zone rule that sets cache behavior for matching requests) must make HTML eligible ([default cache behavior][c-default]). Without cache headers, the edge keeps 200, 206 and 301 for 120 minutes, 302 and 303 for 20 minutes, 404 and 410 for 3 minutes ([default cache behavior][c-default]). The largest cacheable file is 512 MB on Free, Pro and Business ([default cache behavior][c-default]).
3. **Cache key.** The default key is the full URL with the query string ([cache keys][c-keys]). "Ignore query string" is available on all plans. Request headers in the key are an Enterprise feature ([cache keys][c-keys]). So `?ref=...` gives a second cache entry unless a rule ignores the query string (rule U12).
4. **`Vary`.** By default the cache ignores `Vary`, except for `Accept-Encoding` ([cache control][c-control]). Since 2026-07-02, a Cache Rule can turn on `Vary` handling, on all plans ([changelog][c-vary-changelog], [Vary][c-vary]). The origin sends `Vary: Accept`, and the rule says how to treat the header: `normalize`, `passthrough` or `bypass`. With `normalize`, an allow list of up to 10 media types reduces the `Accept` header to those types, sorted by quality value, and Cloudflare forwards the reduced header to the origin ([Vary][c-vary], [settings][c-rules-settings]). A purge of one URL removes all its variants ([Vary][c-vary]). This replaces the statement in spec 5.5 and spec 19 item 7 that the cache cannot keep the two formats apart.
5. **Purge.** Purge by URL, host, tag, prefix and "everything" exist on all plans ([purge][c-purge]). Limits on the Free plan, per account: 800 URLs per second and 100 URLs per request for purge by URL; 5 requests per minute with a burst of 25, and 100 operations per request, for tag, prefix and host ([purge][c-purge]). The path in a purge is case-sensitive ([purge by URL][c-purge-url]).
6. **Tiered cache.** Smart Tiered Cache (one upper cache layer near the origin, so that fewer misses reach the origin) is free on all plans ([tiered cache][c-tiered]). Cache Reserve (a persistent cache stored in R2) is a paid add-on: $0.015 per GB-month, $4.50 per million writes, $0.36 per million reads. A file needs an edge lifetime of 10 hours or more and a `Content-Length` header ([Cache Reserve][c-reserve]).
7. **Range requests.** The cache answers a single byte range with 206 from a complete cached file ([range requests][c-range]).
8. **Rule quotas on the Free plan.** 10 Cache Rules ([cache rules][c-rules]). 10 Transform Rules (rules that rewrite the URL or headers of a request before the cache), without regular expressions below the Business plan ([transform rules][rules-transform]). 10 Single Redirects ([redirects][rules-forwarding]). 5 custom firewall rules ([custom rules][waf-custom]). 1 rate limiting rule, with a counting period of 10 seconds ([rate limiting][waf-ratelimit]).
9. **Rule features cannot hold the resolver.** Bulk Redirects (a static list of redirects at account level) hold 10,000 URLs on Free, 25,000 on Pro and 50,000 on Business, and support no string operations ([redirects][rules-forwarding], [bulk redirects][rules-bulk]). Snippets (small JavaScript functions attached to a rule) need a Pro plan or higher, and are limited to 32 KB of code, 2 MB of memory and 5 ms ([Snippets][rules-snippets]). The `_redirects` file of Static Assets and Pages holds 2,000 static and 100 dynamic redirects ([limits][w-limits]). The resolver needs 48,000 names, letter case, Unicode forms and a precedence order. None of these features can do it.
10. **Rule order.** URL Rewrite Rules run before Cache Rules, and Snippets run after Cache Rules ([phases][rules-phases]).
11. **Bots and AI crawlers.** AI Crawl Control (a dashboard that shows AI crawlers and blocks or allows each one) works on all plans. Its pay-per-crawl part is in private beta ([AI Crawl Control][ai-crawl]). Policies per behavior (search, agent, training) can block or allow, and can write managed `robots.txt` lines with Content Signals ([policies][ai-policies], [robots.txt][ai-robots]). Bot Fight Mode is free and cannot be tuned ([Bot Fight Mode][bfm]).
12. **Logs.** Logpush (a push of request logs to storage) is available on Free, Pro and Business with usage prices: 25 GB per month included, then $0.03 per GB to R2 and $0.10 per GB to other targets ([Logpush pricing][logpush-pricing]). Zone analytics show at least the last 30 days on every plan ([zone analytics][zone-analytics]). Workers Logs (logs of Worker runs) include 200,000 events per day on Workers Free, kept 3 days, and 20 million events per month on Workers Paid, kept 7 days ([pricing][w-pricing]).
13. **Terms for video.** On Free, Pro and Business, the terms do not allow the CDN to serve video, or a disproportionate share of images, audio or other large files, unless a paid Cloudflare service such as the Developer Platform serves them ([terms][terms]). R2 and Workers are part of the Developer Platform. This matters for options A and F: the 15 video files (80 MB) must not go through the cache from the server.
14. **Markdown for Agents.** See section 4.2. It needs a Pro plan or higher ([Markdown for Agents][mfa]).

### 3.1 Option A: self-managed Linux server behind the Cloudflare cache

**How it works.** nginx (or Caddy) serves the files from a directory. Cloudflare stays in front as DNS and cache. A request that is not an exact file goes to the resolver. The resolver has two possible homes:

1. A small local service that runs the TypeScript resolver of `packages/resolver`. nginx sends it every request that matches no file (`try_files` with a named location, [nginx core][nginx-core]). This is the same code as in the tests and in a Worker.
2. A generated nginx `map` file. nginx matches plain strings of a `map` without letter case and loads them from an included file ([nginx map][nginx-map]). The default hash size (`map_hash_max_size 2048`) must be raised for 48,000 entries ([nginx map][nginx-map]). The njs module can also load a JSON file at configuration time (`js_preload_object`, [nginx js][nginx-js]). A `map` cannot express the precedence order, the suggestions for an ambiguous alias, or Unicode normal forms. So home 1 is the realistic one, and home 2 is an optimization.

Caddy has a `map` directive with regular expression inputs ([Caddy map][caddy-map]). The design is the same.

**Pros.**

1. No limit on file count or file size.
2. No new vendor product. The server, nginx and the resolver are all replaceable.
3. No new cost if the server has room.
4. Range requests work without configuration. nginx supports byte ranges by default ([nginx core][nginx-core], `max_ranges`).
5. Full access logs for every request that reaches the server.
6. Since fact 4 of section 3.0, the Markdown requirement needs one Cache Rule and no edge code.

**Cons.**

1. The owner operates it: system updates, TLS between Cloudflare and the server, disk space for releases, monitoring, backups.
2. The server is one machine, shared with other services (spec 5.5). When it is down, every page that is not in the cache fails. The site is a long tail, so that is most pages.
3. Every cache miss reaches the server. A full crawl by one bot is at least 20,735 page requests, and as many again for the Markdown twins. For static files this is a small load for nginx. The real risks are the bandwidth for the 788 MB of attachments and the other services on the same machine. The size of the risk is unverified (section 5).
4. The purge must be correct. A URL that the purge list misses stays stale until its edge lifetime ends. Redirects and 404 answers of the resolver are cached too (fact 2), so they need their own cache headers or a purge.
5. The build runs outside the server (decision D43). So the CI system needs a credential that can write to the server.
6. The origin must refuse traffic that does not come through Cloudflare. Authenticated Origin Pulls (a client certificate that Cloudflare presents to the origin) is available on all plans ([origin pulls][aop]).
7. Video files must not go through the cache from this server (fact 13). They need R2 or another host.

**Limits.**

| Item                         | Value                                                                    | Source                              |
| ---------------------------- | ------------------------------------------------------------------------ | ----------------------------------- |
| File count, file size        | Limits of the disk only                                                  | Not applicable                      |
| Largest cacheable file       | 512 MB                                                                   | [default cache behavior][c-default] |
| Purge by URL, Free plan      | 800 URLs per second, 100 per request                                     | [purge][c-purge]                    |
| Purge by tag or prefix, Free | 5 requests per minute, burst of 25, 100 operations per request           | [purge][c-purge]                    |
| Cache Rules, Free plan       | 10                                                                       | [cache rules][c-rules]              |
| Rate limiting rules, Free    | 1, counting period 10 seconds                                            | [rate limiting][waf-ratelimit]      |
| Media types in a `Vary` rule | 10                                                                       | [settings][c-rules-settings]        |
| nginx `map` hash size        | Default 2048, must be raised. The value for 48,000 entries is unverified | [nginx map][nginx-map]              |

**Cost.** Cloudflare Free plan: $0 per month, with the CDN included ([plans][plans]). No Worker, no R2. Purge calls are free. The server exists, so the new cost is $0 at 100,000 and at 1,000,000 page requests. Without an existing server, add the price of a small server (unverified, depends on the provider). Optional: Cache Reserve for the long tail, at 5 GB × $0.015 = $0.08 per month for storage, plus $0.45 per 100,000 files written (100,000 × $4.50 / 1,000,000) ([Cache Reserve][c-reserve]).

**Deployment.** See section 4.4.

### 3.2 Option B: Cloudflare R2 plus one Worker

**How it works.** R2 is object storage: a bucket of files reachable over HTTP, with an S3-compatible API. The bucket stays private. One Worker receives every request, computes an object key, reads the object through a binding (a direct API between a Worker and a bucket, without HTTP) and returns it. The resolver runs in the same Worker.

R2 has no notion of a release. The design must add one:

1. Every file is stored once, under a key made from its content hash. An upload never overwrites.
2. A manifest maps each public path to a hash. The manifest and the resolver map are part of the Worker version.
3. A deployment uploads the new objects first, then deploys the Worker version. That deployment is the atomic switch. `wrangler rollback` is the rollback ([rollbacks][w-rollbacks]). wrangler is the Cloudflare command-line tool.
4. Immutable files do not need the manifest. Their URL is their key.

**Cache choices.** A read through the binding does not pass through the zone cache. There are four ways to cache, and the first is "do not":

1. No cache. Every request runs the Worker and reads R2. Nothing can go stale and nothing needs a purge. The cost is one Worker request and one R2 read per request.
2. Workers Cache (a cache in front of a Worker that returns a stored response without running the Worker). It honors `Vary`, is tiered, and by default keys each entry by the Worker version, so a deployment starts with an empty cache ([Workers Cache][w-cache], [cache keys][w-cache-keys]). A cache hit is billed as a request. With this cache on, requests for static assets are billed too ([Workers Cache][w-cache]). Purge is by tag or path prefix, at the Free purge limits whatever the plan ([purge][w-cache-purge], [limitations][w-cache-limits]). Its documentation speaks of "at launch". Its release state is unverified.
3. Cache API (a programmatic cache per data center). It is not tiered and does not merge concurrent requests ([limitations][w-cache-limits]).
4. A public custom domain on the bucket, with the zone cache in front ([public buckets][r2-public]). This suits immutable files. It does not suit pages, because the Worker must run for the resolver.

**Pros.**

1. No limit on file count. Objects up to 5 TiB ([R2 limits][r2-limits]).
2. No server. No egress price ([R2 pricing][r2-pricing]).
3. Atomic switch and rollback through Worker versions.
4. Writes are strongly consistent: a read after an upload sees the object everywhere ([R2 API][r2-api]).
5. Range requests: the binding takes a `range` option ([R2 API][r2-api]).
6. The bucket speaks the S3 API, so standard tools copy it in and out ([rclone][r2-rclone]).

**Cons.**

1. The release tool is own code: content-hash upload, manifest, removal of old objects. Option G gets this from wrangler.
2. Every request is billed as a Worker request, and as an R2 read when no cache is used.
3. The manifest for all paths is large. For 45,000 release-bound paths it is about 4 MB (estimate, unverified). It must stay inside the startup limit of 1 second ([limits][w-limits]).
4. More Cloudflare products than option A: Workers and R2.

**Limits.**

| Item                               | Value                                                     | Source                   |
| ---------------------------------- | --------------------------------------------------------- | ------------------------ |
| Objects per bucket                 | Unlimited                                                 | [R2 limits][r2-limits]   |
| Object size                        | 5 TiB. 5 GiB in a single-part upload                      | [R2 limits][r2-limits]   |
| Object key length                  | 1,024 bytes                                               | [R2 limits][r2-limits]   |
| Writes to the same key             | 1 per second                                              | [R2 limits][r2-limits]   |
| Storage                            | $0.015 per GB-month. First 10 GB free                     | [R2 pricing][r2-pricing] |
| Class A operations (writes, lists) | $4.50 per million. First 1 million per month free         | [R2 pricing][r2-pricing] |
| Class B operations (reads)         | $0.36 per million. First 10 million per month free        | [R2 pricing][r2-pricing] |
| Deletes, egress                    | Free                                                      | [R2 pricing][r2-pricing] |
| Worker requests, Free plan         | 100,000 per day, 10 ms CPU per request                    | [limits][w-limits]       |
| Worker requests, Paid plan         | $5 per month, 10 million included, then $0.30 per million | [pricing][w-pricing]     |
| Worker CPU time, Paid plan         | 30 million ms included, then $0.02 per million ms         | [pricing][w-pricing]     |
| Worker size                        | 64 MiB uncompressed, no compressed limit                  | [limits][w-limits]       |
| Worker startup time                | 1 second                                                  | [limits][w-limits]       |
| Worker memory                      | 128 MB per isolate                                        | [limits][w-limits]       |
| Rollback targets                   | The 100 most recent versions                              | [rollbacks][w-rollbacks] |

**Overage.** On Workers Free, the request above 100,000 per day gets error 1027, or bypasses the Worker when the route is set to "fail open" ([limits][w-limits]). On Workers Paid, usage is billed. A spending limit can stop all Workers of the account at a threshold. It is not an exact cap ([spend management][w-spend]). R2 bills above the free amounts.

**Cost.** See section 4.3. $5 per month at both volumes.

**Deployment.** See section 4.4.

### 3.3 Option C: Workers Static Assets with a Worker

**How it works.** Workers Static Assets is a file store that belongs to a Worker: `wrangler deploy` uploads a directory, and Cloudflare serves and caches the files. The files, the code and the configuration form one Worker version. By default, Cloudflare first looks for a file that matches the path. When none matches, it runs the Worker ([worker script][sa-routing]). That is the shape of requirement 1: the resolver runs for every request that is not an exact file. The setting `run_worker_first` runs the Worker before the file lookup, for all paths or for a list of up to 100 patterns ([binding][sa-binding]).

**Pros.**

1. A release is a version. The deployment sets which version gets the traffic. `wrangler rollback` returns to one of the 100 most recent versions ([rollbacks][w-rollbacks]).
2. No purge. Each request uses the file list of the selected version, so a new version serves the new files ([static assets][sa]).
3. Requests for files are free and not limited. Storage has no price ([billing][sa-billing]).
4. wrangler uploads only the files that Cloudflare does not have yet ([direct upload][sa-upload]).
5. Cloudflare caches the files in tiers. No cache configuration exists ([static assets][sa]).
6. No server.

**Cons.**

1. 100,000 files per version on Workers Paid, 20,000 on Workers Free ([limits][w-limits]). The site passes 100,000 files. This alone rules out C for the whole site.
2. 25 MiB per file ([limits][w-limits]). The 27 MB video does not fit.
3. A request with a `Range` header gets 200 with the full file. The documented way around it is to send those paths through the Worker ([billing][sa-billing]).
4. The default HTML handling answers some paths with a 307 redirect: `/file.html` and `/file/` go to `/file` ([HTML handling][sa-html]). The resolver would then add a second redirect. Rule U2 asks for one. So `html_handling` must be "none", and the Worker must run first for note paths.
5. Headers from the `_headers` file do not apply to responses that the Worker makes ([headers][sa-headers]). The Worker must set them.
6. A deployment takes "up to a few seconds" to reach every data center. During that time, a page and its files can come from different versions ([version skew][w-skew]). Hashed files of earlier releases must stay in the new release, or live outside it.
7. With `run_worker_first` on Workers Free, a request above the daily limit gets 429 and does not fall back to the file ([billing][sa-billing]).

**Limits.**

| Item                              | Value                                                                                                            | Source                     |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Files per Worker version          | 20,000 (Free), 100,000 (Paid)                                                                                    | [limits][w-limits]         |
| File size                         | 25 MiB                                                                                                           | [limits][w-limits]         |
| `run_worker_first` patterns       | 100                                                                                                              | [binding][sa-binding]      |
| `_redirects`                      | 2,000 static, 100 dynamic                                                                                        | [limits][w-limits]         |
| `_headers`                        | 100 rules                                                                                                        | [limits][w-limits]         |
| Upload token                      | Valid for 1 hour                                                                                                 | [direct upload][sa-upload] |
| Default `Cache-Control` of a file | `public, max-age=0, must-revalidate`, with an `ETag`                                                             | [headers][sa-headers]      |
| Worker logs, Paid plan            | 20 million events per month included, then $0.60 per million, kept 7 days. The price model changes on 2026-12-01 | [pricing][w-pricing]       |

**Cost.** Workers Paid, $5 per month, is required because of the file count. See section 4.3.

**Verdict.** C does not fit alone. Its release model needs the least own code of all options. Option G keeps that model and moves the files that break the limits to R2.

### 3.4 Option D: Cloudflare Pages

**How it works.** Pages is the older Cloudflare product for static sites: it stores a directory per deployment and can run Pages Functions, which are Workers under another name.

**Findings.**

1. The Pages documentation starts with this advice: Workers "is Cloudflare's primary platform for building applications. Start new projects with Workers" ([Pages][pages]).
2. File count: 20,000 on the Free plan. Paid plans "such as Pro, Business, and Enterprise" get 100,000 with an environment variable ([Pages limits][pages-limits]). The direct upload page states 20,000 files for wrangler ([direct upload][pages-upload]). The two pages disagree, and which paid plan counts is unverified.
3. File size: 25 MiB ([Pages limits][pages-limits]).
4. Range requests get 200 ([serving Pages][pages-serving]).
5. Rollback exists and is instant. The documentation shows it in the dashboard only ([rollbacks][pages-rollbacks]).
6. Pages Functions are billed as Workers ([migration guide][pages-migrate]).
7. A Cache Rule on the custom domain can serve stale content after a deployment ([serving Pages][pages-serving]).

**Verdict.** D has the limits of C, fewer features, and its vendor points new projects elsewhere. It does not fit.

### 3.5 Option E: GitHub Pages

**How it works.** GitHub serves the files of a repository branch or of a build artifact.

**Findings** ([GitHub Pages limits][gh-limits]):

1. A published site may be no larger than 1 GB. The attachments alone are 788 MB before image variants.
2. A deployment times out after 10 minutes.
3. Soft limits: 100 GB of bandwidth per month, 10 builds per hour (not for a custom Actions workflow).
4. Above the limits, GitHub can answer 429 or ask the owner to move.
5. The product must not host a site that is primarily directed at commercial transactions. The store section comes later (spec 2).
6. No server logic exists: no resolver, no response by `Accept` header, no real 410. Range support is unverified.

**Verdict.** E fails on size and on requirements 1 and 2. It does not fit.

### 3.6 Option F: hybrid, server as origin plus logic at the edge

**How it works.** As option A, and one edge feature takes over the resolver or the Markdown rewrite. Three edge features are possible:

1. **A Transform Rule for Markdown.** A URL Rewrite Rule matches the `Accept` header and rewrites the path to the Markdown URL. It runs before the cache (fact 10). It is free: 10 rules on the Free plan. Since fact 4, a Cache Rule with `vary` does the same job with the origin in control, so this rule is one of two valid ways. Whether the cache key uses the rewritten path is unverified.
2. **A Snippet.** It needs a Pro plan and cannot hold the map (fact 9). It could only do the Markdown rewrite, which a rule already does.
3. **A Worker on the route, for the resolver.** A Worker route cannot select "requests that match no file". Canonical URLs and other names share the root. So the Worker runs for every page request, also for responses that the cache holds, and each run is billed (fact 1). The map then exists in two places: in the Worker version and in the server release. The two switches are not atomic together.

**What the Worker would gain.** Unknown paths get their 404 at the edge and never reach the server. That matters only under a flood of invalid URLs. One rate limiting rule covers that case.

**Verdict.** The resolver is a hash lookup. The server does it at no cost. F with a Worker adds a second deployment target and a per-request price to option A, for no gain. If the server is chosen, choose option A with one Cache Rule.

### 3.7 Option G (added): Workers Static Assets for release-bound files, R2 for immutable files

**How it works.** One Worker, as in option C, with a split:

1. **Static Assets** hold the release-bound files: HTML pages, Markdown twins, feeds, sitemaps, discovery files, small hashed CSS and scripts. About 45,000 files (estimate, unverified).
2. **R2** holds the immutable files: image variants, attachments, video, audio. They are uploaded once and never change. A public custom domain on the bucket (a media host name in the same zone) serves them through the zone cache ([public buckets][r2-public]). No Worker runs for them.
3. **The Worker** runs first for note paths. It reads the raw path, and then: for a canonical URL it selects the HTML file or the Markdown twin by the `Accept` header and returns it through the assets binding; for any other name it runs the resolver and answers with one redirect, 404 or 410. The stable URL of an attachment (rule U10) is a redirect to the media host.
4. **The resolver map** is bundled in the Worker (section 4.1).

A configuration sketch (not tested):

```jsonc
{
    "name": "notes",
    "main": "src/worker.ts",
    "assets": {
        "directory": "./dist",
        "binding": "ASSETS",
        "html_handling": "none",
        "run_worker_first": ["/*", "!/<reserved prefix>/static/*"]
    }
}
```

**File budget.** 20,735 HTML + 20,735 Markdown + about 3,000 generated files (unverified) = about 44,500 of 100,000. If the search index stays in Static Assets and Pagefind writes one fragment per page (unverified): about 65,000. Each new note adds 2 or 3 files. The ceiling is hard, so the build must count the files and fail early.

**Pros.**

1. All pros of option C: release as a version, one-command rollback, no purge, free file requests, upload of changed files only, no server.
2. The limits of C do not apply to the files that break them. R2 has no count limit and takes 5 TiB per object ([R2 limits][r2-limits]).
3. Range requests work for media: the cache answers them (fact 7).
4. The terms allow video from R2 (fact 13).
5. Immutable files in R2 need no release logic and no purge. This avoids the own release tool of option B.
6. No shared HTTP cache sits between the reader and the Worker. HTML and Markdown cannot mix (section 4.2).

**Cons.**

1. The ceiling of 100,000 files stays for release-bound files. The site can grow to it.
2. Two upload targets per deployment: the bucket first, then the Worker.
3. Every page request runs the Worker and is billed. 10 million per month are included ([pricing][w-pricing]).
4. A second host name for media. The Content Security Policy must list it.
5. More Cloudflare products than option A: Workers, Static Assets, R2.
6. Several behaviors are unverified: path matching for `+`, `%2B` and non-ASCII names, deployment time at this file count, the effect of zone rules on a Worker domain (section 5).
7. Cons 4 to 6 of option C apply.

**Limits.** The tables of options B and C apply.

**Cost.** $5 per month at both volumes. See section 4.3.

**Deployment.** See section 4.4.

## 4. Answers to the five questions

### 4.1 Where should the resolver map live in options B, C (G) and F?

**Size.** 48,000 names: 20,735 paths, 20,735 file names, about 6,900 aliases (research 1.6). The file names are the last segments of the paths, so the data is one list of paths and one list of aliases. As JSON that is about 2 MB (estimate, unverified). Former paths and unpublished notes add to it over time.

**Answer: bundle the map in the Worker**, as a module that the Worker imports. Reasons:

1. A lookup is an in-memory hash lookup. No network call, no extra price.
2. The map is part of the Worker version. It switches and rolls back with the files and the code.
3. The size fits: a Worker can be 64 MiB uncompressed, and no compressed limit exists ([limits][w-limits]).
4. The risks are the startup limit of 1 second and the 128 MB of memory ([limits][w-limits]). wrangler reports `startup_time_ms` at each deployment ([limits][w-limits]). If the startup is too slow, the Worker builds the lookup table on the first request, or loads the map as one file (next table, rows 2 and 3).
5. On Workers Free, the CPU limit is 10 ms per request ([limits][w-limits]). Parsing the map on a first request can pass it (unverified). Workers Paid allows 30 seconds by default.

| Place                                                      | Lookup                        | Price per million resolver requests, after included usage                     | Switches with the release                                                 | Remarks                                                                                                                                 |
| ---------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Bundled in the Worker                                   | Memory                        | $0.30 request + $0.02 CPU at 1 ms (unverified) = $0.32                        | Yes                                                                       | Realistic choice ([pricing][w-pricing])                                                                                                 |
| 2. One JSON file in Static Assets, loaded once per isolate | Memory after the first load   | $0.32                                                                         | Yes                                                                       | 25 MiB per file. Only in C and G                                                                                                        |
| 3. One R2 object, loaded once per isolate                  | Memory after the first load   | $0.32, plus one R2 read per isolate start                                     | Yes, if the key carries the release id                                    | Strongly consistent ([R2 API][r2-api])                                                                                                  |
| 4. KV, one key per name                                    | Network read, cached when hot | $0.30 + $0.50 = $0.80 ([KV pricing][kv-pricing])                              | No. A change can take 60 seconds or more to show ([how KV works][kv-how]) | KV is a key-value store that is cached at the edge. Cold reads go to a central store. Unknown names are billed too. Bad for a long tail |
| 5. D1, one row per name                                    | SQL query over the network    | $0.30 + $0.001 per million rows read ([D1 pricing][d1-pricing]) = about $0.30 | Only with one table per release                                           | D1 is a SQLite database service. One network call per lookup                                                                            |
| 6. Durable Object                                          | Call to one object            | $0.30 + $0.15 ([Durable Objects pricing][do-pricing]) = $0.45, plus duration  | Not applicable                                                            | A Durable Object is one stateful instance in one place. No reason to use it here                                                        |
| 7. Cache API                                               | Not a store                   | Not applicable                                                                | Not applicable                                                            | Per data center, not tiered ([limitations][w-cache-limits]). It can only cache answers                                                  |

Included usage on Workers Paid: 10 million requests and 30 million CPU ms per month ([pricing][w-pricing]). At 1,000,000 page requests per month, the price of the resolver is $0 above the $5 subscription.

Per option:

1. **B and G (and C):** row 1. In C and G with the default "file first" routing, only requests that match no file run the Worker. In the recommended "Worker first" routing, every page request runs it.
2. **F:** row 1 is the only sound choice for a Worker, and the Worker runs for every request on the route. The better answer for F is to keep the map at the origin (section 3.6).

### 4.2 Markdown on request: configuration per option, and "Markdown for Agents"

**What must be configured so that the cache keeps HTML and Markdown apart.**

1. **A and F, way 1 (origin decides).** The origin reads `Accept`, returns the Markdown file or the HTML file, and sends `Vary: Accept` on both. One Cache Rule for the host: eligible for cache, ignore the query string, and this `vary` setting ([settings][c-rules-settings]):

    ```json
    "vary": {
        "default": { "action": "bypass" },
        "headers": {
            "accept": { "action": "normalize", "media_types": ["text/markdown", "text/html"] },
            "accept-encoding": { "action": "normalize" }
        }
    }
    ```

    The cache then holds one entry per reduced `Accept` value: `text/html`, `text/markdown`, `text/markdown,text/html`, `text/html,text/markdown`, or none. The origin gets the reduced header ([Vary][c-vary]). The exact reduced values for real browsers and agents are unverified.

2. **A and F, way 2 (rewrite before the cache).** One URL Rewrite Rule: when an `Accept` value contains `text/markdown` and the path is not under the reserved prefix, rewrite the path to the Markdown URL under the reserved prefix (rule U11). The rule runs before the cache (fact 10). The origin needs no logic. The rule ignores quality values, so `text/markdown;q=0` would also match. Whether the cache key uses the rewritten path is unverified.
3. **B.** The Worker reads `Accept` and selects the object. Without a cache in front, nothing can mix. With Workers Cache, the Worker returns `Vary: Accept`. That cache stores one entry per exact header value ([Workers Cache][w-cache]), so the many `Accept` strings of browsers give many entries. The fix is a gateway entry point without cache that decides the format and calls a cached entry point with a path per format.
4. **C and G.** The Worker runs first for note paths, reads `Accept`, and gets the HTML file or the Markdown twin through the assets binding. No shared cache sits in front of the Worker, because a Worker runs before the zone cache (fact 1) and Workers Cache stays off. The Worker sends `Vary: Accept` for browsers and proxies. No Cache Rule is needed for that host.
5. **D.** As C, with a Pages Function. A Cache Rule on the custom domain can serve stale content ([serving Pages][pages-serving]).
6. **E.** Not possible without Cloudflare in front. With Cloudflare in front, only way 2 works.

**Is "Markdown for Agents" usable instead?** It is a zone feature: when a request has `Accept: text/markdown`, Cloudflare converts the HTML response of the origin to Markdown on the fly ([Markdown for Agents][mfa]).

1. **Plans.** Pro, Business and Enterprise, at no extra cost. Not on the Free plan ([Markdown for Agents][mfa]). The Pro plan is $20 per month billed per year, or $25 billed per month ([plans][plans]).
2. **What it does.** It sets `Content-Type: text/markdown`, adds `Accept` to `Vary`, and removes `ETag` and `Last-Modified`. It converts up to 6 MiB of HTML ([Markdown for Agents][mfa]).
3. **Drawbacks compared with the own Markdown file.**
    1. The output is a conversion of the rendered page, not the cleaned note. Spec 9.16 asks that agents get the cleaned artifact: allowed properties, site URLs for links.
    2. The front matter holds three fields only: title, description, image ([Markdown for Agents][mfa]).
    3. The response keeps the headers of the HTML response. Rule U11 asks for `noindex` and a canonical link on Markdown responses only. That is not possible.
    4. Without a `content-signal` header from the origin, Cloudflare adds `Content-Signal: ai-train=yes, search=yes, ai-input=yes` ([Markdown for Agents][mfa]). The AI policy is an open decision (D33). The origin must set the header to stay in control.
    5. Conditional requests do not work on the converted response, because `ETag` and `Last-Modified` are removed.
    6. It adds a dependency that cannot move: without Cloudflare, the feature is gone. The own Markdown file works on every host.
    7. Whether it applies to responses of a Worker or of Static Assets is unverified. Whether the converted response is cached is unverified.
4. **Answer.** Serve the own Markdown file. The site builds a Markdown twin per note anyway. Markdown for Agents is at most a stopgap for pages that have no twin, on a Pro zone.

### 4.3 Monthly cost at 100,000 and at 1,000,000 page requests

Notation: P is the number of page requests per month. A browser page view adds 5 requests (assumption), so the total is T = 6 × P when every request counts. Storage is 5 GB (working figure). Uploads are 4 × 300 × 30 = 36,000 files per month.

| Option                 | P = 100,000 | P = 1,000,000 | Fixed part                                  |
| ---------------------- | ----------- | ------------- | ------------------------------------------- |
| A: own server          | $0          | $0            | The server, which exists                    |
| B: R2 + Worker         | $5          | $5            | Workers Paid                                |
| C: Static Assets       | $5          | $5            | Workers Paid. Does not fit alone            |
| D: Pages               | unverified  | unverified    | A paid plan for more than 20,000 files      |
| E: GitHub Pages        | $0          | $0            | Does not fit                                |
| F: hybrid, rules only  | $0          | $0            | The server                                  |
| F: hybrid, with Worker | $0          | $5            | Workers Paid above 100,000 requests per day |
| G: Static Assets + R2  | $5          | $5            | Workers Paid                                |

The arithmetic:

1. **A.** Cloudflare Free plan: $0 ([plans][plans]). No Worker, no R2. Total: $0. Optional Cache Reserve: 5 GB × $0.015 = $0.08 per month, and 100,000 writes × $4.50 / 1,000,000 = $0.45 per full fill ([Cache Reserve][c-reserve]).
2. **B, no cache, all requests through the Worker.**
    1. P = 100,000: T = 600,000 requests. Workers Paid: $5.00 subscription. Requests: 600,000 is under the 10 million included, $0. CPU: 600,000 × 1 ms (unverified) = 0.6 million ms, under the 30 million included, $0 ([pricing][w-pricing]). R2 storage: 5 GB is under the 10 GB free, $0. R2 reads: 600,000 is under the 10 million free, $0. R2 writes: 36,000 is under the 1 million free, $0 ([R2 pricing][r2-pricing]). Total: $5.00.
    2. P = 1,000,000: T = 6,000,000 requests. Requests: under 10 million, $0. CPU: 6 million ms, under 30 million, $0. R2 reads: 6 million, under 10 million, $0. Total: $5.00.
    3. Workers Free is possible at P = 100,000 on average: 600,000 / 30 = 20,000 requests per day, under 100,000 per day ([limits][w-limits]). At P = 1,000,000 it is not: 6,000,000 / 30 = 200,000 per day. A crawler burst passes the daily limit at any volume, and the site then answers with errors until midnight UTC. So Workers Paid is the realistic plan.
    4. Beyond the included usage, for scale: at T = 20 million requests, Workers (20 - 10) × $0.30 = $3.00, R2 reads (20 - 10) × $0.36 = $3.60, total $5.00 + $3.00 + $3.60 = $11.60. At 20 GB of storage: (20 - 10) × $0.015 = $0.15.
3. **C and G, Worker first for pages, media on the media host.**
    1. Workers Paid is required: Workers Free allows 20,000 files ([limits][w-limits]). $5.00.
    2. Worker requests: P plus the requests that the resolver answers. With 20% for the resolver (unverified): 120,000 or 1,200,000. Both are under the 10 million included, $0. CPU: under the 30 million ms included, $0.
    3. Requests for files in Static Assets: free ([billing][sa-billing]).
    4. G only, R2: storage 5 GB, under 10 GB free, $0. Reads: only cache misses on the media host reach R2. At most 5 × P = 500,000 or 5,000,000, under the 10 million free, $0. Writes: 36,000, $0.
    5. Total: $5.00 at both volumes.
    6. For scale: a month with 50 million page requests from crawlers costs (50 - 10) × $0.30 = $12.00 for requests, (50 - 30) × $0.02 = $0.40 for CPU at 1 ms, total $17.40. A spending limit can stop the Worker at a threshold. Files that need no Worker stay available ([spend management][w-spend]).
4. **D.** Pages Functions are billed as Workers ([migration guide][pages-migrate]). More than 20,000 files needs a paid plan. If that means the Pro zone plan, it is $20 or $25 per month ([plans][plans]). Which plan counts is unverified.
5. **E.** $0. It does not fit.
6. **F.** With rules only: as A, $0. With a Worker on the route: the Worker runs for every request, T = 600,000 or 6,000,000 per month. The first is under the free daily limit on average. The second is 200,000 per day, so Workers Paid, $5.00.
7. **Add-on, any option:** Markdown for Agents needs the Pro zone plan: $20 per month billed per year, or $25 billed per month ([plans][plans]).

### 4.4 A deployment of "5 changed notes, 300 changed files"

Deployment times are unverified for every option. Section 6 measures them. The build step is the same everywhere and is not shown.

**A: own server.**

```sh
# 1. New release directory. Unchanged files become hard links to the current release.
rsync -a --link-dest=<current release> dist/ <server>:<releases>/<id>/
# 2. Atomic switch: make a new symbolic link, then rename it over the old one.
ssh <server> 'ln -s <releases>/<id> <site>.new && mv -T <site>.new <site>'
# 3. Purge the changed URLs, 100 per call (3 calls for 300 URLs).
curl -X POST https://api.cloudflare.com/client/v4/zones/<zone>/purge_cache \
     -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
     -d '{"files":["https://<host>/<path>", ...]}'
```

Rollback: point the link at the previous release, then purge the same URLs. What can go wrong:

1. The purge list misses a derived file. That URL stays stale until its edge lifetime ends.
2. The switch and the purge are two steps. Between them, the cache serves old pages. That is harmless when hashed files of both releases exist.
3. A URL has several cached forms: with a query string, with `%20`. The purge must cover the forms that the cache holds, or a rule must ignore the query string. The exact behavior is unverified.
4. Cached redirects and 404 answers of the resolver stay until they expire (fact 2 of section 3.0).
5. With `open_file_cache` on, nginx can serve an old file for a short time. The directive is off by default ([nginx core][nginx-core]).
6. Old release directories fill the disk. A cleanup job is needed.
7. If the map lives in the nginx configuration, a reload is needed after the switch, and the two are not atomic together. The local resolver service that reads the map from the release directory avoids this.

**B: R2 plus Worker.**

```sh
# 1. Upload the objects that the bucket does not have yet (names are content hashes).
rclone copy dist-objects/ r2:<bucket>/ --ignore-existing
# 2. Deploy the Worker with the new manifest and resolver map. This is the switch.
npx wrangler deploy
# Rollback
npx wrangler rollback <version id>
```

What can go wrong:

1. The deploy runs before all objects are there. The upload must finish first, and the tool must check it.
2. Objects that no manifest of the last 100 versions uses stay forever. A cleanup job is needed, and it must not remove an object that a rollback target needs.
3. The manifest makes the Worker slow to start (limit: 1 second, [limits][w-limits]).
4. With a cache in front, a purge step returns, with the limits of fact 5.

**C and G: Static Assets (G: plus R2).**

```sh
# G only: upload new immutable files to the bucket. They never change, so order and repeats are harmless.
rclone copy dist-media/ r2:<media bucket>/ --ignore-existing
# Upload changed files and create the version, then send it all traffic.
npx wrangler deploy
# Or in two steps: upload first, switch later.
npx wrangler versions upload
npx wrangler versions deploy <version id>@100%
# Rollback
npx wrangler rollback <version id>
```

wrangler sends the list of all files with their hashes. Cloudflare answers with the files that it does not have, and wrangler uploads those ([direct upload][sa-upload]). For this deployment that is about 300 files. No purge follows. What can go wrong:

1. The release has more than 100,000 files or a file above 25 MiB. The deployment fails ([limits][w-limits]). The build must check both.
2. The deployment reaches the data centers within "up to a few seconds" ([version skew][w-skew]). In that time a new page can ask an old version for a new hashed file. Keep the hashed files of earlier releases in the release, or in R2.
3. The upload token is valid for 1 hour ([direct upload][sa-upload]). The time to hash and list 45,000 or more files is unverified.
4. A rollback needs the R2 bucket of the target version to still exist ([rollbacks][w-rollbacks]). Immutable files that the old version uses must not be removed.
5. A spending limit that triggers stops the Worker, and with it every page ([spend management][w-spend]).

**D: Pages.** `npx wrangler pages deploy dist` ([direct upload][pages-upload]). Rollback in the dashboard ([rollbacks][pages-rollbacks]). The same file limits as C stop the deployment.

**E: GitHub Pages.** A push, or a deployment from an Actions workflow. It fails above 1 GB or after 10 minutes ([GitHub Pages limits][gh-limits]). No rollback command exists. A rollback is a new deployment of an old commit.

**F: hybrid.** As A. With a Worker on the route, add `npx wrangler deploy` for the map, and accept that the server switch and the Worker switch happen at different moments.

### 4.5 Which options keep working without Cloudflare?

In every option, three things are not tied to Cloudflare: the build output (a directory of files), the resolver (`packages/resolver`, plain TypeScript), and the resolver map (generated data). What differs is the glue.

| Option | Works without Cloudflare  | What must be rewritten or replaced                                                                                                                                                                                                                                               |
| ------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A      | Yes                       | Nothing in the site. Lost: the cache, the purge step, the `Vary` rule (the origin already negotiates), bot controls. The server then takes all traffic                                                                                                                           |
| B      | After a move              | Copy the bucket out with an S3 tool (egress is free, [R2 pricing][r2-pricing]). Rewrite the Worker glue: the binding calls and the manifest lookup become file reads. The manifest scheme works on any S3 store or on a disk                                                     |
| C, G   | After a move              | The release-bound files are in the build output already. G: copy the media bucket out. Rewrite the Worker entry: the assets binding and the `Accept` selection become a file server with the same logic. `wrangler` versions and rollback are replaced by option A's link switch |
| D      | After a move              | As C. Pages Functions use their own file conventions                                                                                                                                                                                                                             |
| E      | Yes                       | Nothing. But it does not meet the requirements with or without Cloudflare                                                                                                                                                                                                        |
| F      | Yes, after a small change | The edge rule moves to the origin. With a Worker for the resolver: the origin must run the resolver again                                                                                                                                                                        |

The way to keep the move small in G: the Worker is a thin adapter around the resolver, and the `serve` command of `apps/cli` (spec 5.2) is a second adapter around the same resolver for a plain server. The URL contract tests run against both. Option A is then always one DNS change and one `rsync` away.

Features that are lost with Cloudflare in every option: AI Crawl Control, bot rules, rate limiting, the DNS and cache in front. These are replaceable services, not site code.

## 5. What is not verified

Each point has the test that settles it.

| #   | Point                                                                                                                                                                                  | Test                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Real file count and size of the output: more than 100,000 files, 5 GB, about 45,000 release-bound files, about 3,000 generated files                                                   | Run the full-size build prototype (spec 15.2). Count files and bytes per class                                                                 |
| 2   | Pagefind output: one fragment file per page, hashed names                                                                                                                              | Index the full-size fixture. Count the files in the Pagefind directory                                                                         |
| 3   | Size of the resolver map (about 2 MB), Worker startup time, memory, CPU per lookup (1 ms)                                                                                              | Generate the map from fixture names at full scale. Read `startup_time_ms` from wrangler and CPU time from the Worker metrics                   |
| 4   | Path matching of Static Assets for `+`, `%2B`, `%20`, non-ASCII, apostrophes, `&`, dots, names that end like `.js`                                                                     | Deploy a fixture with the name patterns of research 1.4b. Request each form. With "Worker first", check which raw path the Worker sees         |
| 5   | The sketch of section 3.7: `run_worker_first` with a negative pattern, `html_handling` "none", content types from the assets binding                                                   | Deploy the sketch. Run the URL contract tests of spec 5.4                                                                                      |
| 6   | Whether a call to the assets binding from the Worker is billed                                                                                                                         | Read the usage figures after a known number of requests                                                                                        |
| 7   | Deployment time and reliability with 45,000 to 65,000 files, for a first upload and for 300 changed files                                                                              | Measure both with wrangler                                                                                                                     |
| 8   | Effect of the "few seconds" of propagation on readers                                                                                                                                  | Request a page and its files in a loop from several places during a deployment                                                                 |
| 9   | Whether zone features apply to a Worker domain: firewall rules, rate limiting, AI crawler policies, managed `robots.txt`, URL Rewrite Rules                                            | Add one rule of each kind on a test host. Request and observe                                                                                  |
| 10  | The reduced `Accept` values of the `vary` rule for real browsers and agents, and the handling of `Accept-Encoding` with `default: bypass`                                              | Option A test: send 6 `Accept` forms twice each. Compare the body and `cf-cache-status`                                                        |
| 11  | Whether the cache key uses the path after a URL Rewrite Rule                                                                                                                           | Option A test: add the rule, request with and without `Accept: text/markdown`, twice each                                                      |
| 12  | Which URL forms a purge by URL must list (query string, `+`, `%20`), with "ignore query string" on                                                                                     | Cache three forms of one page, purge one, request all three                                                                                    |
| 13  | Crawler load on the server in option A: bandwidth and effect on other services                                                                                                         | Request all URLs of the fixture with a cold cache at a high rate. Watch the server                                                             |
| 14  | nginx `map`: the hash size for 48,000 entries, and letter case for non-ASCII names                                                                                                     | Generate the map file. Run `nginx -t`. Request names with accents in both cases                                                                |
| 15  | Markdown for Agents: effect on Worker and Static Assets responses, caching of the converted response                                                                                   | Only if the feature is wanted. Turn it on for a test host on a Pro zone                                                                        |
| 16  | Workers Cache: release state, and behavior together with Static Assets                                                                                                                 | Only if a cache in front of the Worker is wanted. Turn it on in a test Worker                                                                  |
| 17  | Logs for requests that Static Assets answer without the Worker, and request logs of a Worker domain through Logpush on a plan below Enterprise                                         | Turn on Workers Logs and one Logpush job to R2. Compare with a known request list. The 404 report after the switch (spec 15.1) depends on this |
| 18  | Response time of "Worker first plus assets binding" compared with a direct file                                                                                                        | Measure time to first byte for both on the test host, from several places                                                                      |
| 19  | Whether the R2 free amounts count as a "paid service" in the terms for video                                                                                                           | Read the terms with the account in hand, or ask support. With Workers Paid active, a paid Developer Platform plan exists                       |
| 20  | Pages: which paid plan gives 100,000 files. The two documentation pages disagree                                                                                                       | Not needed unless option D returns                                                                                                             |
| 21  | GitHub Pages: Range support                                                                                                                                                            | Not needed unless option E returns                                                                                                             |
| 22  | The assumptions of section 4.3: 5 extra requests per page view, 20% of requests for the resolver, 4 publications per day                                                               | Read the real figures after the switch. The cost stays $5 until 10 million Worker requests per month                                           |
| 23  | Price of a small server for option A when no server exists                                                                                                                             | Not needed: the server exists                                                                                                                  |
| 24  | Release state of `createMcpHandler` and of Dynamic Workers. Code Mode is experimental, so its API can change                                                                           | Read the changelog at decision time. Pin the package versions                                                                                  |
| 25  | Whether the Code Mode executor creates a new Dynamic Worker at each call, also for an identical script                                                                                 | Run 100 different scripts and 100 identical ones. Read the count of Dynamic Workers in the dashboard                                           |
| 26  | Memory limit of a Dynamic Worker, and the behavior at the `cpuMs` limit                                                                                                                | Run one script that allocates memory without end and one endless loop                                                                          |
| 27  | QuickJS in WebAssembly inside a Worker: it loads, host functions with promises work, the memory and time limits hold, and its CPU factor against V8 (100 ms per call is an assumption) | Run the same 10 scripts with both executors. Compare the CPU time in the Worker metrics                                                        |
| 28  | Whether the MCP helpers of Code Mode accept an executor other than `DynamicWorkerExecutor`                                                                                             | Pass the QuickJS executor to `openApiMcpServer()`                                                                                              |
| 29  | Size of the SQLite database with FTS5 (150 to 250 MB), load time into D1, row count of a full-text query, export of FTS5 tables                                                        | Build the database from the fixture. Load it. Run queries and read the row counts that D1 returns                                              |
| 30  | Size of the link list in memory (about 2 MB as JSON for 155,000 links)                                                                                                                 | Build it from the fixture and measure                                                                                                          |
| 31  | Pagefind on a server                                                                                                                                                                   | Not needed unless FTS5 is rejected                                                                                                             |
| 32  | Price of the Rate Limiting binding. Whether the edge rate limiting rule acts on the MCP path of a Worker                                                                               | Read the usage figures after a test. Send a burst from one address                                                                             |
| 33  | Whether the Workers spending limit counts the price of Dynamic Workers                                                                                                                 | Read the spend view after the test of point 25, or ask support                                                                                 |
| 34  | Whether Static Assets upload and serve files under `/.well-known/`, with the right content types                                                                                       | Deploy the fixture with these files. Request each one                                                                                          |
| 35  | Paths and formats of the agent skills index, the MCP server card and the ARD manifest. State of WebMCP in browsers                                                                     | Read each specification when the files are designed                                                                                            |
| 36  | Vectorize figures: 18 million tokens for the corpus, one vector per note                                                                                                               | Only if semantic search is wanted                                                                                                              |
| 37  | Which MCP clients connect without login, and whether bot rules stop them                                                                                                               | Connect two clients to the test host with Bot Fight Mode on                                                                                    |

## 6. Prototype plan

The smallest experiment that confirms or rejects option G. It also covers the resolver and the Markdown prototypes of spec 15.2. It uses invented notes only (AGENTS.md, privacy).

**Fixture.**

1. A generator writes a site at full scale from invented content: 20,735 HTML pages, 20,735 Markdown twins, and a resolver map with 48,000 names. The names follow every pattern of research 1.4b: dots, endings like `.js`, apostrophes, non-ASCII, `&`, literal `+`, `%`.
2. A few media files in a test bucket: one above 25 MiB, one audio file.

**Worker.** One file: the resolver from `packages/resolver`, the `Accept` selection, the assets binding, the redirect of stable attachment URLs to the media host. The configuration of section 3.7.

**Checks.**

1. Deploy to a test host. Record the upload behavior, `startup_time_ms` and the file count. (Points 3, 5, 7.)
2. Run the acceptance tests of spec 5.4 against the test host: every canonical path returns 200, every variant reaches the right note in one redirect, an unknown path returns 404, an unpublished note returns 410. (Points 4, 5.)
3. Request one page with `Accept: text/html` and with `Accept: text/markdown`, several times, from two places. Each answer has the right format and `Vary: Accept`.
4. Request a byte range of the large media file on the media host. The answer is 206.
5. Change 5 notes and 300 files in the fixture. Deploy. Record what wrangler uploads. Check that the new pages are live without a purge. Roll back with one command. Check that the old pages are live. (Points 7, 8.)
6. Request all 41,470 file URLs and 50,000 invented wrong URLs at a high rate. Read the Worker metrics and the usage figures. Nothing fails, and the usage matches section 4.3. (Points 6, 22.)
7. Add one firewall rule and the AI crawler policies on the test host. Check that they act on Worker responses. (Point 9.)
8. Exit drill: serve the same output directory and the same resolver with a plain local server, and run the tests of check 2 against it. This proves that the glue is thin, and it is the first half of option A.
9. MCP server: deploy a second Worker with `search` and `execute` over the fixture data (a SQLite database with FTS5 in D1, and the link list). Run 10 fixed scripts with both executors of section 7.2. Record the CPU time, the count of Dynamic Workers and the rows read. Run three hostile scripts: an endless loop, memory growth, a `fetch` to another host. Each must end with an error. Send 10,000 calls from one address: the rate limit and the daily budget must stop them. Then run the same server code with the QuickJS executor and the SQLite file on a plain local server. (Points 25 to 30, 32.)

**Decision rule.**

1. All checks pass: option G is confirmed.
2. Check 1 or 2 fails because of the file count, the path matching or the upload at this scale: move the release-bound files to R2 with a manifest (option B). The Worker and the resolver stay.
3. Check 6 or 7 shows a cost or a control problem that has no fix, or the owner prefers fewer vendor products: take option A. Then run points 10, 12 and 13 of section 5 on the server.
4. Check 9: if the QuickJS executor fails or is too slow, use the Dynamic Worker executor, and require a token or a daily budget for `execute` (section 7.5). The hosting choice does not change.

## 7. Remote MCP server with code mode

This section was added after a decision of the owner: the site gets a remote MCP server at the first release. MCP (Model Context Protocol) is the open protocol through which an AI client calls tools on a server. The server uses the "code mode" pattern. It exposes two tools, `search` and `execute`. The model writes a short script against a typed API of the notes (search, get note, backlinks, neighbors, recent, tags). The script runs in a sandbox, and only its result returns. The other agent-facing files also come at the first release: API catalog, agent skills index, MCP server card, WebMCP tools in the page, ARD manifest (7.7).

Nothing in this section was tested. Points 24 to 37 of section 5 list the tests.

### 7.1 What Cloudflare offers for this pattern

| Part                                        | What it is                                                                                                                                                                                                                                           | State                                                                                        | Plan                               | Limits and prices                                                                                                                                                                                                                                                | Source                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Remote MCP over Streamable HTTP             | `createMcpHandler` of the Agents SDK serves an MCP server from a Worker. It is stateless: a fresh server per request, no Durable Object, no session. Streamable HTTP is the standard transport for remote MCP. The older SSE transport is deprecated | No beta label in the documentation. The release state is unverified                          | Workers Free or Paid               | The price of Worker requests                                                                                                                                                                                                                                     | [handler][mcp-handler], [transport][mcp-transport]                             |
| `McpAgent`                                  | A stateful MCP server on a Durable Object                                                                                                                                                                                                            | Deprecated and feature-frozen. The documentation asks to move to `createMcpHandler`          | Not applicable                     | Do not start with it                                                                                                                                                                                                                                             | [McpAgent][mcp-agent]                                                          |
| Code Mode (package `@cloudflare/codemode`)  | A library that shows tools to the model as a typed API and runs the script of the model in an executor. `codeMcpServer()` gives one `code` tool. `openApiMcpServer()` gives `search` and `execute` against an OpenAPI document                       | Experimental: "may have breaking changes. Use caution in production"                         | Workers Paid (it needs the loader) | Default timeout 60,000 ms. Network blocked by default. The final answer is cut at about 6,000 estimated tokens. Both helpers return a server of the older MCP SDK version, served by `createLegacyMcpHandler`                                                    | [guide][mcp-codemode-guide], [how it works][codemode-how], [API][codemode-api] |
| Dynamic Workers (the Worker Loader binding) | An API with which a Worker creates another Worker at run time from a string of code. The new Worker runs in its own isolate                                                                                                                          | No beta label in the documentation. Billed since 2026-05-26. The release state is unverified | Workers Paid only                  | 1,000 unique Dynamic Workers per month included, then $0.002 per Dynamic Worker per day. Requests and CPU at the Workers rates, and CPU includes the startup. 4 distinct Dynamic Workers in flight per Worker request. Per-call limits `cpuMs` and `subRequests` | [pricing][dw-pricing], [limits][dw-limits], [custom limits][dw-custom-limits]  |
| Rate Limiting binding                       | A counter API inside a Worker: a key is allowed or not                                                                                                                                                                                               | No beta label                                                                                | Price not stated (unverified)      | Period of 10 or 60 seconds. Counts are approximate and separate per Cloudflare location. A strict limit needs a Durable Object                                                                                                                                   | [rate limit][w-ratelimit]                                                      |

The pattern of the owner is the "search and execute" pattern of Cloudflare. The MCP server for the Cloudflare API uses it ([Cloudflare MCP servers][mcp-cloudflare]). In that pattern, `search` runs a script of the model against an OpenAPI document, and `execute` runs a script with a request function that the host provides ([guide][mcp-codemode-guide]). Two remarks:

1. The API of the notes must then exist as an OpenAPI document. The API catalog file can point to the same document.
2. The guide advises the single `code` tool for "a manageable set of tools" and search-and-execute for a large API ([guide][mcp-codemode-guide]). Six functions are a small set. The form with two tools is still possible.

### 7.2 The sandboxed `execute` in options G and B

The answer is the same for G and for B. The MCP server is a Worker, and it does not depend on the place of the site files. Use a second Worker, apart from the site Worker: it has its own deployment, its own limits and its own logs, and a fault in it cannot break the pages. Give it a URL on the own domain, so that the MCP server card stays valid after a move.

Two executors are possible.

**Executor 1: a Dynamic Worker.** This is the design of Code Mode.

1. **Where the script runs.** The MCP Worker hands the script to the Worker Loader binding. Cloudflare starts a new isolate for it. `load()` creates a new Worker at each call. `get(id)` can reuse a Worker with the same id ([API][dw-api]).
2. **Network.** With `globalOutbound: null`, `fetch()` and `connect()` throw ([egress][dw-egress]). The executor of Code Mode sets this by default ([how it works][codemode-how]).
3. **Secrets.** The Dynamic Worker gets only the `env` object that the host passes ([API][dw-api]). It does not see the bindings or the credentials of the host. The API of the notes reaches the script as remote calls: each call crosses to the host, and the host runs the query ([how it works][codemode-how]). The notes are public. The things to protect are the bill and the other resources of the account.
4. **Limits.** `limits: { cpuMs, subRequests }` per call ([custom limits][dw-custom-limits]). A timeout on the executor: the default is 60 seconds, so lower it ([API][codemode-api]). Memory: a Worker isolate has 128 MB ([limits][w-limits]). Whether that holds for a Dynamic Worker is unverified. The host must also limit the number of API calls per script, the rows per API call and the size of the result.
5. **Cost per call.** One Worker request for the MCP call ($0.30 per million). One Dynamic Worker: $0.002, when the script text is new on that day and the 1,000 included per month are used. One request into the Dynamic Worker ($0.30 per million). CPU for startup and execution: 20 ms (unverified) × $0.02 per million ms = $0.0000004 ([pricing][dw-pricing]). The total is about $0.002 per call with a new script.
6. **Per month.** 1,000 calls: $0 above the plan. 10,000 calls: (10,000 - 1,000) × $0.002 = $18. 100,000 calls: $198. 1,000,000 calls: $1,998.
7. The `search` tool of `openApiMcpServer()` also runs a script of the model, so it counts in the same way. Whether the executor reuses a Dynamic Worker for an identical script is unverified. Scripts of a model are seldom identical.

**Executor 2: QuickJS in WebAssembly, inside the MCP Worker.** QuickJS is a small JavaScript interpreter. `quickjs-emscripten` is a build of it as a WebAssembly module. Its documentation lists Cloudflare Workers, Node.js, Bun and Deno as supported, and names the evaluation of untrusted JavaScript as a use ([quickjs-emscripten][qjs]).

1. **Where the script runs.** Inside the isolate of the MCP Worker, in the memory of the WebAssembly module. The script can call only the functions that the host adds to the interpreter.
2. **Network and secrets.** The interpreter has no `fetch`, no file access and no host objects.
3. **Limits.** `setMemoryLimit`, `setMaxStackSize` and `setInterruptHandler`, which stops a script at a deadline ([quickjs-emscripten][qjs]). The CPU limit of the Worker bounds the whole call.
4. **Cost per call.** One Worker request plus CPU. An interpreter is slower than V8. The factor is unverified. With 100 ms of CPU: $0.0000003 + 100 × $0.00000002 = $0.0000023. That is $2.30 per million calls.
5. **Isolation.** The script and the host share one isolate. An escape needs a defect in QuickJS and then a defect in the WebAssembly sandbox of V8. A Dynamic Worker has a separate isolate, which is the stronger design.
6. **Portability.** The same executor runs without change on a plain server.

| Property                | Executor 1: Dynamic Worker    | Executor 2: QuickJS in WebAssembly      |
| ----------------------- | ----------------------------- | --------------------------------------- |
| Isolation               | Separate isolate              | WebAssembly memory in the host isolate  |
| Speed                   | V8                            | Interpreter, slower (unverified factor) |
| Price per new script    | About $0.002                  | About $0.0000023                        |
| Runs outside Cloudflare | No                            | Yes                                     |
| Own code                | Little: Code Mode provides it | The executor glue                       |
| State                   | Experimental library          | Open-source library                     |

**First recommendation for the executor:** executor 2, behind a small interface, with executor 1 as a second implementation. The reason: the server is public without login, and a price of $0.002 per call does not fit anonymous callers. Executor 1 becomes the better choice when calls need a token or a daily budget exists, and speed or isolation matter more. Code Mode has an `Executor` interface that `DynamicWorkerExecutor` implements ([API][codemode-api]). Whether its MCP helpers accept another executor is unverified.

### 7.3 The same server on a self-managed server (option A)

The protocol part is plain. The MCP SDK for TypeScript serves Streamable HTTP from Node.js or Bun ([MCP transports][mcp-spec-transport]). nginx passes the MCP path to that service. The calls are POST requests, so the cache does not help: every call reaches the server.

The sandbox is the hard part:

| Sandbox                                         | How it works                                                             | Fit for scripts from anonymous callers                                                                                                                                                                            | Source                         |
| ----------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Node.js `vm` module                             | A separate context in the same process                                   | No. The documentation says: "not a security mechanism. Do not use it to run untrusted code"                                                                                                                       | [Node.js vm][node-vm]          |
| `isolated-vm`                                   | V8 isolates inside the Node.js process                                   | Possible with care. The library is in maintenance mode. Its documentation warns that a leaked object gives the attacker control of the process, asks for fast V8 security updates, and advises a separate process | [isolated-vm][ivm]             |
| QuickJS in WebAssembly                          | An interpreter in WebAssembly memory, with memory, stack and time limits | Realistic choice. It is executor 2 of section 7.2                                                                                                                                                                 | [quickjs-emscripten][qjs]      |
| A Deno process without permissions              | One process per call. No file, network or environment access by default  | Possible. For untrusted code, the Deno documentation asks for more layers: an operating system sandbox (chroot, cgroups, seccomp) and a virtual machine (gVisor, Firecracker)                                     | [Deno security][deno-security] |
| A container or a small virtual machine per call | The strongest separation                                                 | Safe, and the most work to operate                                                                                                                                                                                | Not applicable                 |
| `workerd`, the open-source Workers runtime      | It runs Worker code on any machine                                       | Its documentation says: "`workerd` is not a hardened sandbox", and asks for a virtual machine around it. Whether its Worker Loader works outside Cloudflare is unverified                                         | [workerd][workerd]             |

**The security risk.** With static files, the server runs no code from visitors. With `execute`, it runs code that anyone on the internet wrote, on a machine that other services share (spec 5.5). A sandbox escape reaches those services and their data. A script that uses much CPU or memory slows them down. This is a new class of risk for that machine.

**The realistic setup on A.**

1. QuickJS in WebAssembly as the executor.
2. The MCP service in its own process, under its own system user, with limits of the operating system on memory, CPU, file access and outgoing network.
3. A fixed number of executor workers, each stopped at a timeout.
4. A rate limit in nginx or at Cloudflare.

**The cost to operate.** No price per call. The work: security updates of the JavaScript runtime, one more process to watch, limits to tune, logs to read. A burst costs CPU on the shared machine, not money.

### 7.4 Where the data of the tools comes from

The corpus: 20,735 notes with 71 MB of Markdown, and about 155,000 links (research 1.2).

| Function                             | Source in G and B                                                                                                                         | Source in A                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Get note                             | The Markdown twin, from Static Assets (G) or R2 (B)                                                                                       | The Markdown twin in the release directory |
| Backlinks, neighbors                 | The link list that the build writes for the graph (spec 9.5): 155,000 pairs of numbers, about 2 MB as JSON (unverified). Or a table in D1 | The same file, or a table in SQLite        |
| Recent, tags, names and aliases      | Small JSON files from the build, and the resolver map                                                                                     | The same files                             |
| Full-text search                     | D1 with the FTS5 extension                                                                                                                | A SQLite file with FTS5                    |
| Semantic search (not in the API yet) | Vectorize, with embeddings from Workers AI                                                                                                | Another vector index. Not studied here     |

**The portable data layer** is one SQLite database that the build writes at each release: notes, links, tags and a full-text index. D1 is SQLite as a service and supports FTS5 ([D1 SQL][d1-sql]). A plain server opens the same file. The size is about 150 to 250 MB (estimate, unverified).

**D1 limits and prices.** 10 GB per database on Workers Paid, 500 MB on Workers Free. 2 MB per row. 1,000 queries per Worker invocation on Paid, 50 on Free ([D1 limits][d1-limits]). Rows read: 25 billion per month included on Paid, then $0.001 per million. On Free, 5 million per day. Rows written: 50 million per month included, then $1.00 per million. Storage: 5 GB included, then $0.75 per GB-month ([D1 pricing][d1-pricing]).

**Read cost for this corpus.**

1. Get note: one row, or one file.
2. Backlinks of a note: one row per link, through an index. A hub note with 2,000 backlinks is 2,000 rows.
3. A full scan of the links table is 155,000 rows. 1,000 such scans per day are 155 million rows per day, or 4.65 billion per month. That is under the 25 billion included.
4. So normal use costs $0 on Workers Paid. The risk is a script that forces many scans (7.5).
5. How D1 counts the rows of a full-text query is unverified.
6. Write cost: the first load is about 176,000 rows plus the rows of the full-text index (unverified). That is under the 50 million included. A publication rewrites the rows of 5 notes.

**Release.** A D1 database is not part of a Worker version. Two ways exist. The simple way: apply the changed rows after the deployment, and accept that MCP answers follow the pages a short time later. The strict way: load a new database per release and bind it in the Worker version. The import file can be 5 GiB ([D1 import][d1-import]). The load time is unverified.

**Pagefind.** It is a browser library: its index is a set of chunk files that its WebAssembly code fetches. Its use on a server is unverified, and it is not built for that. Keep it for the page and for the WebMCP tools, which run in the browser of the reader.

**Vectorize** is a vector database for search by meaning. It is generally available ([Vectorize pricing][vectorize-pricing]). With one vector of 768 dimensions per note:

1. Stored: 20,735 × 768 = 15.9 million dimensions. Workers Paid includes 10 million. (15.9 - 10) million × $0.05 per 100 million = $0.003 per month.
2. Queries are billed as (queries + stored vectors) × dimensions. Workers Paid includes 50 million. 10,000 queries: (10,000 + 20,735) × 768 = 23.6 million, included. 100,000 queries: 92.7 million, so (92.7 - 50) × $0.01 = $0.43.
3. Embedding the corpus once with the `bge-m3` model at $0.012 per million input tokens ([Workers AI pricing][wai-pricing]): 71 MB is about 18 million tokens (unverified), so $0.21.
4. The listed API does not need it. It can come later. An index in Vectorize cannot move: another host needs a new index.

### 7.5 Public access without login, abuse controls, cost of a burst

**Yes, the server can be public without login.** The Cloudflare guide has a variant without authentication, which anyone can connect to, and OAuth can be added later ([remote MCP server][mcp-remote]).

**Controls.**

1. **A rate limiting rule at the edge.** The Free plan has 1 rule, counted per IP address over 10 seconds, with the path as a field ([rate limiting][waf-ratelimit]). It stops a caller before the Worker runs. Whether it acts on a Worker domain is point 9 of section 5.
2. **The Rate Limiting binding** in the Worker: a limit per IP address or per token, over 10 or 60 seconds. The counts are approximate ([rate limit][w-ratelimit]).
3. **A daily budget for `execute`,** for all callers together. A counter in a Durable Object gives a strict count ([rate limit][w-ratelimit]). When the budget is spent, `execute` answers with an error. This control bounds the bill.
4. **Limits in the sandbox:** CPU, timeout, memory, API calls per script, rows per API call, size of the result. No API function may scan a whole table. Each query has a fixed `LIMIT`.
5. **An optional token for `execute` only.** `search` stays anonymous. A token gives a limit per caller, and makes executor 1 affordable.
6. **The Workers spending limit.** It counts requests and CPU of all Workers of the account, and it stops all of them, also the site Worker. It does not count D1 ([spend management][w-spend]). Whether it counts Dynamic Workers is unverified. Use it as the last guard only.
7. **Bot rules.** A policy that blocks "Agent" traffic can also block the clients that the server is for ([policies][ai-policies]). How Cloudflare classifies MCP clients is unverified.

**Cost of a burst.**

| Burst                                                                                   | G or B with executor 1                                        | G or B with executor 2       | Option A                          |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------- | --------------------------------- |
| 1,000,000 calls that only list the tools                                                | $0.30                                                         | $0.30                        | No bill. Load on the server       |
| 100,000 `execute` calls with different scripts                                          | 100,000 × $0.002 = $200                                       | 100,000 × $0.0000023 = $0.23 | No bill. CPU on the shared server |
| 1,000,000 `execute` calls with different scripts                                        | $2,000                                                        | $2.30                        | No bill. CPU on the shared server |
| D1 reads of those 1,000,000 calls, with 50 API calls per script and 1,000 rows per call | 50 billion rows: (50 - 25) billion × $0.001 per million = $25 | $25                          | None                              |
| D1 reads of those 1,000,000 calls, with 50 full scans of the links table per script     | 7,750 billion rows: about $7,725                              | About $7,725                 | None                              |

The last row shows why control 4 matters more than the choice of the executor. The first rows show why executor 1 needs control 3 or control 5.

### 7.6 Effect on the recommendation, and the exit path

1. **G against B: no effect.** The MCP server is a second Worker in both. Option G stays the recommendation.
2. **Option A becomes weaker.** Static files on the shared server are a low risk. Scripts from anonymous callers on that machine are not. If the site goes to A, the MCP server needs another home: a separate small machine, or a Worker on Cloudflare that reads the same SQLite data through D1. So this requirement makes some use of Workers likely in every option, and the advantage "fewer vendor products" of A becomes smaller.
3. **Cost.** Workers Paid is already part of G. With executor 2 and the controls of 7.5, the MCP server adds $0 at normal use.
4. **New ties to Cloudflare:** the Code Mode package (experimental), Dynamic Workers, D1, Vectorize. Three choices keep them small: the executor behind an interface with QuickJS as the first implementation, one SQLite schema as the data layer, and the standard MCP SDK for the protocol.

The exit path for the MCP server alone:

| Part                        | On Cloudflare                         | After leaving                                    | Work                                                                         |
| --------------------------- | ------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------- |
| Protocol and transport      | `createMcpHandler`                    | The MCP SDK for TypeScript on Node.js or Bun     | A new entry file                                                             |
| Tool definitions, notes API | Plain TypeScript                      | The same code                                    | None                                                                         |
| Executor 2 (QuickJS)        | In the Worker                         | In the service                                   | None                                                                         |
| Executor 1 (Dynamic Worker) | Worker Loader binding                 | Does not exist elsewhere                         | Replace it with executor 2 or another sandbox, and review the security again |
| Data                        | D1                                    | The SQLite file of the release build             | A thin adapter: open a file in place of a binding                            |
| Semantic search             | Vectorize, Workers AI                 | Another vector index and another embedding model | Build a new index, or drop the function                                      |
| Rate limits, daily budget   | Rate Limiting binding, Durable Object | Limits in nginx, or a counter in the service     | Small rewrite                                                                |
| URL                         | Own host name                         | The same host name                               | A DNS change                                                                 |

### 7.7 The other agent-facing files

1. API catalog, agent skills index, MCP server card and ARD manifest are files that the build generates (spec 9.16, design note 3). Every option that serves static files can serve them.
2. Some of them have a path under `/.well-known/` and need an exact content type without a file extension. The API catalog is `/.well-known/api-catalog` with the type `application/linkset+json` ([RFC 9727][rfc9727]). In G the Worker runs first and sets the type. In A an nginx location sets it. Whether wrangler uploads a directory whose name starts with a dot is unverified.
3. WebMCP tools are script in the page. They run in the browser of the reader and can use the Pagefind index. They add no server cost. They must fit the Content Security Policy (spec 9.15).
4. The MCP server card and the ARD manifest name the URL of the MCP server. That URL must be on the own domain, so that a move does not break them.
5. The paths and formats of the agent skills index, the MCP server card and the ARD manifest, and the state of WebMCP in browsers, were not checked here: unverified.

[w-limits]: https://developers.cloudflare.com/workers/platform/limits/
[w-pricing]: https://developers.cloudflare.com/workers/platform/pricing/
[w-spend]: https://developers.cloudflare.com/workers/platform/spend-management/
[w-cache-how]: https://developers.cloudflare.com/workers/reference/how-the-cache-works/
[w-cache]: https://developers.cloudflare.com/workers/cache/
[w-cache-keys]: https://developers.cloudflare.com/workers/cache/cache-keys/
[w-cache-purge]: https://developers.cloudflare.com/workers/cache/purge/
[w-cache-limits]: https://developers.cloudflare.com/workers/cache/limitations/
[w-versions]: https://developers.cloudflare.com/workers/versions-and-deployments/
[w-rollbacks]: https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/
[w-skew]: https://developers.cloudflare.com/workers/versions-and-deployments/version-skew/
[sa]: https://developers.cloudflare.com/workers/static-assets/
[sa-billing]: https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/
[sa-binding]: https://developers.cloudflare.com/workers/static-assets/binding/
[sa-routing]: https://developers.cloudflare.com/workers/static-assets/routing/worker-script/
[sa-html]: https://developers.cloudflare.com/workers/static-assets/routing/advanced/html-handling/
[sa-headers]: https://developers.cloudflare.com/workers/static-assets/headers/
[sa-upload]: https://developers.cloudflare.com/workers/static-assets/direct-upload/
[r2-pricing]: https://developers.cloudflare.com/r2/pricing/
[r2-limits]: https://developers.cloudflare.com/r2/platform/limits/
[r2-public]: https://developers.cloudflare.com/r2/buckets/public-buckets/
[r2-api]: https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
[r2-rclone]: https://developers.cloudflare.com/r2/examples/rclone/
[kv-pricing]: https://developers.cloudflare.com/kv/platform/pricing/
[kv-how]: https://developers.cloudflare.com/kv/concepts/how-kv-works/
[d1-pricing]: https://developers.cloudflare.com/d1/platform/pricing/
[do-pricing]: https://developers.cloudflare.com/durable-objects/platform/pricing/
[pages]: https://developers.cloudflare.com/pages/
[pages-limits]: https://developers.cloudflare.com/pages/platform/limits/
[pages-serving]: https://developers.cloudflare.com/pages/configuration/serving-pages/
[pages-rollbacks]: https://developers.cloudflare.com/pages/configuration/rollbacks/
[pages-upload]: https://developers.cloudflare.com/pages/get-started/direct-upload/
[pages-migrate]: https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/
[gh-limits]: https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
[c-default]: https://developers.cloudflare.com/cache/concepts/default-cache-behavior/
[c-control]: https://developers.cloudflare.com/cache/concepts/cache-control/
[c-vary]: https://developers.cloudflare.com/cache/concepts/vary/
[c-vary-changelog]: https://developers.cloudflare.com/changelog/post/2026-07-02-vary-for-cache-rules/
[c-keys]: https://developers.cloudflare.com/cache/how-to/cache-keys/
[c-rules]: https://developers.cloudflare.com/cache/how-to/cache-rules/
[c-rules-settings]: https://developers.cloudflare.com/cache/how-to/cache-rules/settings/
[c-purge]: https://developers.cloudflare.com/cache/how-to/purge-cache/
[c-purge-url]: https://developers.cloudflare.com/cache/how-to/purge-cache/purge-by-single-file/
[c-tiered]: https://developers.cloudflare.com/cache/how-to/tiered-cache/
[c-reserve]: https://developers.cloudflare.com/cache/advanced-configuration/cache-reserve/
[c-range]: https://developers.cloudflare.com/cache/reference/range-requests/
[rules-forwarding]: https://developers.cloudflare.com/rules/url-forwarding/
[rules-bulk]: https://developers.cloudflare.com/rules/url-forwarding/bulk-redirects/
[rules-transform]: https://developers.cloudflare.com/rules/transform/
[rules-snippets]: https://developers.cloudflare.com/rules/snippets/
[rules-phases]: https://developers.cloudflare.com/ruleset-engine/reference/phases-list/
[waf-custom]: https://developers.cloudflare.com/waf/custom-rules/
[waf-ratelimit]: https://developers.cloudflare.com/waf/rate-limiting-rules/
[mfa]: https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/
[ai-crawl]: https://developers.cloudflare.com/ai-crawl-control/
[ai-policies]: https://developers.cloudflare.com/bots/additional-configurations/block-ai-bots/
[ai-robots]: https://developers.cloudflare.com/bots/additional-configurations/managed-robots-txt/
[bfm]: https://developers.cloudflare.com/bots/get-started/bot-fight-mode/
[logpush-pricing]: https://developers.cloudflare.com/logs/logpush/pricing/
[zone-analytics]: https://developers.cloudflare.com/analytics/account-and-zone-analytics/zone-analytics/
[aop]: https://developers.cloudflare.com/ssl/origin-configuration/authenticated-origin-pull/
[terms]: https://www.cloudflare.com/service-specific-terms-application-services/
[plans]: https://www.cloudflare.com/plans/
[nginx-map]: https://nginx.org/en/docs/http/ngx_http_map_module.html
[nginx-core]: https://nginx.org/en/docs/http/ngx_http_core_module.html
[nginx-js]: https://nginx.org/en/docs/http/ngx_http_js_module.html
[caddy-map]: https://caddyserver.com/docs/caddyfile/directives/map
[mcp-handler]: https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/
[mcp-agent]: https://developers.cloudflare.com/agents/model-context-protocol/apis/agent-api/
[mcp-transport]: https://developers.cloudflare.com/agents/model-context-protocol/protocol/transport/
[mcp-remote]: https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/
[mcp-codemode-guide]: https://developers.cloudflare.com/agents/model-context-protocol/guides/build-codemode-mcp-server/
[mcp-cloudflare]: https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/
[mcp-spec-transport]: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
[codemode-how]: https://developers.cloudflare.com/agents/tools/codemode/how-it-works/
[codemode-api]: https://developers.cloudflare.com/agents/tools/codemode/api-reference/
[dw-pricing]: https://developers.cloudflare.com/dynamic-workers/pricing/
[dw-limits]: https://developers.cloudflare.com/dynamic-workers/platform/limits/
[dw-custom-limits]: https://developers.cloudflare.com/dynamic-workers/usage/limits/
[dw-api]: https://developers.cloudflare.com/dynamic-workers/api-reference/
[dw-egress]: https://developers.cloudflare.com/dynamic-workers/usage/egress-control/
[w-ratelimit]: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
[d1-limits]: https://developers.cloudflare.com/d1/platform/limits/
[d1-sql]: https://developers.cloudflare.com/d1/sql-api/sql-statements/
[d1-import]: https://developers.cloudflare.com/d1/best-practices/import-export-data/
[vectorize-pricing]: https://developers.cloudflare.com/vectorize/platform/pricing/
[wai-pricing]: https://developers.cloudflare.com/workers-ai/platform/pricing/
[qjs]: https://github.com/justjake/quickjs-emscripten
[ivm]: https://github.com/laverdet/isolated-vm
[node-vm]: https://nodejs.org/api/vm.html
[deno-security]: https://docs.deno.com/runtime/fundamentals/security/
[workerd]: https://github.com/cloudflare/workerd
[rfc9727]: https://www.rfc-editor.org/rfc/rfc9727
