# The hosting prototype (issue 21, PROTO-01)

Run on 2026-11-24. The question: does one Worker with static files, plus object storage for the attachments, serve the site at full size (HOST-01, option G of the hosting research of 2026-11-17)?

**Answer: confirmed.** The eight checks of section 6 of the hosting research ran, and none fails by the decision rule of that section. The author confirmed the choice on 2026-11-24 (decision R75), with the conditions of section 4 below.

Everything ran on invented notes: the invented corpus of `bun run corpus` (20,735 notes, seed 1) and the site of the URL table (`fixtures/urls.json`). The test host, the test bucket and the account are not named here: the private part of the ticket holds them.

## 1. The setup

1. The full-size site: the command line program published every note of the invented corpus into a local content store, and `bun run build:site` built the site from it. The output has 64,610 files and 484 MB:

    | Part                                    | Files  | Bytes       |
    | --------------------------------------- | ------ | ----------- |
    | Pages (HTML)                            | 21,638 | 327,247,449 |
    | Markdown of the notes (`-/md/`)         | 20,735 | 66,194,161  |
    | Search: Pagefind                        | 22,113 | 73,679,254  |
    | Search: title index                     | 112    | 5,756,058   |
    | Style sheets, scripts, fonts (`_astro`) | 10     | 493,635     |
    | Resolver map, `robots.txt`              | 2      | 10,703,978  |

    Pagefind writes one fragment per note (20,735) and 1,372 index parts. The largest file is the resolver map (10.7 MB). The largest page is a folder list (783 KB).

2. Every file of the output has a plain name: the page and the Markdown of a note are named by the identity of the note (hexadecimal digits). So the static files of the host never see a name with `+`, `%`, `&`, an apostrophe or a letter outside ASCII. The Worker reads such a path of a request, and the resolver map leads it to a plain file name. Point 4 of section 5 of the hosting research (path matching of the static files) is closed by this design.
3. The Worker is `apps/site/worker/worker.ts`: an adapter of the handler of the site (`siteHandler` of `packages/resolver`), which holds the URL contract. The plain local server is the other adapter. The prototype put a thin entry around the Worker for the measures (Markdown on request by the `Accept` header, the time of the first request of an instance). The entry and the scripts are on the branch `prototype/hosting`.
4. The host configuration: static files with `html_handling: none` and `not_found_handling: none`, the Worker first for every path but the folders `/_astro/` and `/-/search/`, a binding to the bucket, a custom domain. wrangler 4.166.0.
5. The measures ran from one machine in Belgium. Its load average was between 1 and 3 during the measures of time.

## 2. The eight checks

### Check 1: deployment at full size

1. The first deployment uploaded 64,595 files in 242 s. The whole command took 433 s.
2. The Worker starts in 5 to 15 ms (`startup_time_ms` of wrangler), with a code of 77 KB.
3. The site uses 65 percent of the limit of 100,000 files of one Worker version. Without the search files it uses 42 percent.
4. In the first seconds after the very first deployment on a new host name, 15 of 94 requests answered 500 with a page of the host. A minute later no request did.

### Check 2: the URL contract

1. `bun run urls check` on the test host, with the site of the URL table: 91 of 92 cases pass.
2. The one difference: a path with a percent sign that is not encoded (`/100%+rye+bread`). The table expects 404 with the "not found" page. The edge of the host answers 400 with its own page, before the Worker runs. The local runtime of the host (`wrangler dev`) answers 404. Issue 119 holds the decision.
3. At full size, the load run of check 6 asked for each of the 21,577 canonical paths (200), each of the 20,736 files (200), 5,000 variants in small letters or with `%20` (one 301 to the canonical path) and 50,000 invented paths (404, never kept): no wrong answer on the second run.

### Check 3: HTML and Markdown apart

1. One canonical URL asked seven times with `Accept: text/html`, `text/markdown`, both with weights, and `*/*`, in a mixed order, two runs: each answer had the form that the header asked for, and `Vary: Accept`.
2. An answer of the Worker has no `cf-cache-status` header: no shared cache is between the reader and the Worker, so one form cannot be given for the other (HOST-04).
3. Markdown on request (URL-11) is not built in the site yet. The prototype entry gave it. The check ran from one place, not from two: with no cache in the path, the place cannot change the answer.

### Check 4: range requests

1. A sound file of 30 MiB (above the limit of 25 MiB of a static file) in the bucket, asked through the Worker: the whole file (200), the first 1,000 bytes, the last 10 bytes and 64 KB from the middle (206 with the right `Content-Range`), and a range outside the file (416).
2. The same requests on a host name of the bucket itself (a "media host"): 200, 206 and 416 too.
3. The headers of issue 35 (a year of cache, `nosniff`, a sandbox policy but not for a PDF) are on every answer of the Worker. The media host sends none of them, and it did not cache the files (`cf-cache-status: DYNAMIC`).
4. An SVG file with a script in it, opened alone in Chrome: through the Worker the script did not run. On the media host the script ran.
5. A PDF opened in the viewer of Chrome through the Worker. The picture of the headless browser did not show the page of the PDF: the author looks at it one time.
6. The first byte of a small attachment: 130 to 210 ms through the Worker, 120 to 250 ms on the media host (10 requests each, each with its own TLS handshake). A page takes 70 to 120 ms measured the same way.

### Check 5: a second release and a revert

1. The second release changed 5 notes and 300 files. wrangler uploaded 300 files and found 64,310 already there: 4 s for the upload, 34 s for the command.
2. The new pages were live with no purge. A watcher asked for a changed page and its Markdown every 200 ms: for about 6 s the old and the new release answered in turn, then only the new one. No request failed. In those seconds a reader can get a page of one release and the Markdown of the other.
3. The revert is one command (`wrangler rollback <version>`): 7 s. The old pages were back about 10 s after its start, with about 5 s of mixed answers and no failed request.

### Check 6: load, usage and cost

1. First run, right after the deployment: 97,313 requests in 190 s (511 per second), median 41 ms, 95 percent under 275 ms, 99 percent under 410 ms. Two Markdown files answered 500 for about one minute (7 of 9 requests), then 200: the static files did not give them to the Worker in that minute. The server error page is never kept by a cache.
2. Second run: 97,313 requests in 51 s (1,912 per second), median 32 ms, 95 percent under 48 ms, 99 percent under 72 ms, no failure.
3. Usage of the whole test, from the analytics of the host: 199,081 requests of the Worker, 0 errors, 189,484 subrequests, 174 s of CPU time in all (0.9 ms per request; median 0.5 ms, 99th percentile 3.5 ms).
4. A call from the Worker to the static files is a subrequest. It is not billed as a request: the count of requests is the count of the calls of the Worker (point 6 of section 5 of the hosting research).
5. Cost: the usage of the test is inside the amounts of the paid plan (10 million requests and 30 million CPU ms per month), and the bucket is inside its free amounts. The cost is the plan: 5 dollars per month, as section 4.3 of the hosting research says. At 0.9 ms per request, the CPU time of the plan covers about 33 million requests per month.

### Check 7: the controls of the zone

1. A custom firewall rule for one path of the test host acted in 5 s: 403 from the edge, and the Worker did not run. Another path stayed 200.
2. The switch "Block AI bots" of the zone acted in 20 s on the answers of the Worker: requests with the user agents of four AI crawlers got 403 for a note and 200 for `robots.txt`. A request with the user agent of a fifth one, and a browser, got 200. The requests came from the test machine, not from the crawlers.
3. The managed `robots.txt` of the zone did not replace the `robots.txt` that the Worker gives (25 s after the switch).
4. These switches act on a whole zone, not on one host name. The test zone is back in its first state.

### Check 8: the exit drill

1. The same output folder and the same handler on the plain local server (`bun run serve`): the server starts in 0.2 s and uses about 100 MB.
2. The load run of check 6 against it: 97,313 requests, no failure, 6,389 requests per second.
3. The URL table passes on it in the tests (`apps/site/src/urls-page.spec.ts`), next to the Worker with static files in memory.

## 3. Findings

1. **The edge removes the tag of a page.** An HTML answer reached the reader with no `ETag`, so a page never answered 304 (URL-18). The Worker sends the tag. The zone of the test had two features on that can rewrite HTML (the obfuscation of email addresses, the automatic rewrite of links to HTTPS). The Markdown of a note kept its tag in the weak form, with Brotli, and answered 304. With `Cache-Control: no-transform` a page kept its strong tag and answered 304, but the edge then did not compress it. Issue 118.
2. **A tag is weak on the host.** The handler now compares tags in their weak form (a finding of the review, shown true on the host).
3. **The place of the resolver map.** As a static file that the Worker reads at its first request: that request took 79 to 285 ms in 18 new instances, and 730 ms one time, right after the full deployment. As a part of the code of the Worker: the upload is 9.4 MB (2.3 MB with gzip), the Worker starts in 23 to 27 ms, and the first request of an instance took 75 and 91 ms. Parsed in memory, the map takes about 19 MB of the 128 MB of an instance, and the parse takes 140 ms in V8 on the test machine. A host creates many instances: 8 to 10 of 14 requests after a deployment met a new one.
4. **The files that the pages load have no long cache time.** The host gives a file of `/_astro/` with `Cache-Control: public, max-age=0, must-revalidate`. The names of these files hold a hash, so a `_headers` file of the release must give them a year and `immutable`. A missing file of these folders reaches the Worker, which answers with the "not found" page.
5. **The file limit.** One note adds three files (page, Markdown, search fragment). At 65 percent of the limit, the site has room for about 11,800 more notes. With the search files in the object storage it has room for about 28,700 more. The prototype did not move the search files: a file of the object storage through the Worker is about 60 to 90 ms slower for its first byte than a static file, and it is a billed request.
6. **A request of the headers only and a failed start** are handled in the Worker after the review (a `HEAD` request reads no byte, a release that the Worker cannot read is read again after ten seconds).

## 4. The decision and its conditions

Decided by the author on 2026-11-24 (R75):

1. The hosting choice of HOST-01 is confirmed (OPEN-18 is closed). The self-managed server stays the exit path (HOST-02): check 8 shows that the same handler serves the same output there.
2. A reader gets an attachment through the Worker, at its hashed path on the host of the notes. No media host is created.
3. The deployment cleans the attachment storage, not the tool after a publication: after a deployment that succeeded, the deploy job deletes the files that neither the new release nor the release before it uses. A takedown still deletes its files at once (business rule 16). Issue 120. Note: the deployment cleans the object storage after each deployment and, since issue 120 (R78), keeps the files of the new release and of the release before it.

Conditions, with their tickets:

1. The zone features that rewrite HTML are off for the host of the notes (issue 118).
2. The first request of a new instance of the Worker has a budget, and the place and the size of the resolver map are chosen with numbers on the preview host (issue 121).
3. The build counts the files of a release and stops before the limit of the host (issue 32).
4. The hashed files of the pages get a long cache time (issue 32).
5. The answer 400 of the edge for a bare percent sign is decided with the first redirect list (issue 119).

## 5. What is not verified

1. Check 3 from a second place.
2. The crawlers themselves: check 7 used their user agents from the test machine.
3. The search with its files in the object storage.
4. Video. The sound file stands for media above the size limit of a static file.
5. Real notes. The paths of the published notes are longer and have more folders than the invented ones, so the real resolver map is larger (the private part of issue 20 has its numbers).
6. A deployment from the build runner. The times above are from the machine of the author. Prototype 19 measures the real pipeline after issue 32 (R74).
7. Logs of the requests that do not run the Worker (point 17 of section 5 of the hosting research), and the time of a response from several places (point 18).

## Sources

- The hosting research: `documentation/research/2026-11-17-hosting-options.md`, sections 3.7, 4, 5 and 6.
- The code that the prototype keeps: `packages/resolver/src/handler.ts`, `apps/site/worker/worker.ts`, `apps/site/src/url-table.ts`, `scripts/url-table.ts`.
- The throwaway code: branch `prototype/hosting`, folder `prototype/hosting/`.
- The steps of the full-size build: a comment on issue 19.
