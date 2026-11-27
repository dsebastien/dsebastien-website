# The first request of a new instance of the Worker (issue 121)

Run on 2026-11-26. The question: where must the resolver map be, and how large, so that the first request of a new instance of the Worker is fast? The hosting prototype (`2026-11-24-hosting-prototype.md`, finding 3) measured 79 to 285 ms, and 730 ms one time, with the map as a static file of 10.7 MB.

**The budget** (decision of the author R94, 2026-11-27): the resolver map may add at most 60 ms at the 95th percentile to the time to the first byte of the first request of a new instance, compared in the same run with a Worker that has no map (the floor), measured from a client near the edge, on a host with the resolver map of the published notes. It is `FIRST_REQUEST_BUDGET` in `apps/site/src/budgets.ts`, next to the budgets of the note page (PERF-29). The first rule of the author (150 ms at the 95th percentile, 2026-11-26) was not met by the floor itself (finding 1), so it changed after these numbers.

**Answer: option 3, the map in parts as static files of the release.** It is the only option that keeps the first request near the time of a Worker with no map at all, and its memory does not grow with the site. In these measures it adds nothing measurable at the 95th percentile over the floor (within the noise of the floor), and about 30 to 40 ms at the median; every other option adds 300 ms or more at the 95th percentile (section 3).

Everything ran on invented notes, on test Workers of the hosting account on its `workers.dev` name, never on the preview host. The account and the host names are not written here.

## 1. The setup

1. The map of the real size. The test store of the clone has 183 notes: too small. So the map is the one of the invented corpus (`bun run corpus`, 20,735 notes), made closer to the published notes: one more level of folders with a long name (the paths of the published notes are longer), about 9,000 former paths, 26,000 unpublished notes (with the 20,735 file names, about 47,000 names; the published notes have about 48,000), 11,748 attachments, 2,600 rows of a redirect list. The map is 22.96 MB as JSON (5.1 MB with gzip). The map of the published notes, measured without its former paths, its unpublished notes and its redirect list, is 12.7 MB (private part of issue 20); with them, by their counts, it is near this size (not measured: the export of the published notes is not on this machine). The script that made it is not in the repository (it is a few lines over `resolverMapOf()`).
2. Each test Worker had the same static files: the map, 300 note pages of 20 KB, the error pages. It asked for one of the 300 paths at random. A thin entry around each option marked the first answer of an instance; the Worker of the site now does that itself (`Server-Timing: instance;desc=new`, below).
3. The client: the machine of the author in Belgium, with curl, one new connection per request (as a first visit). The TCP connection takes 25 to 35 ms, the TLS handshake ends at 60 to 70 ms. The time to the first byte holds both. A request on a warm instance answers in 100 to 130 ms (median).
4. A new instance, two ways. Right after a deployment, every instance is new: three deployments of a new version per option, each followed by 24 requests, 4 at a time (`bun run first-request` without `--every`); 30 to 43 of the 72 requests met a new instance. At a low rate: one request about every two minutes per option for 2.1 hours (`--every 120`), all options at the same time, and one Worker of option 3 alone at one request about every ten minutes for one hour (`--every 600`).
5. The memory: the heap of one instance in the runtime of the host on this machine (`wrangler dev`, the inspector of V8, `Runtime.getHeapUsage`), which is the V8 of the host. Node (without pointer compression) gives an upper bound.

## 2. The options, with numbers

Right after a deployment (milliseconds to the first byte, first requests of new instances only):

| Option                                                        | Code upload (gzip) | Start of the Worker (wrangler) | p50 | p95   | max   | First requests |
| ------------------------------------------------------------- | ------------------ | ------------------------------ | --- | ----- | ----- | -------------- |
| No map at all (the floor of the host)                         | 24 KB              | 1 to 2 ms                      | 131 | 278   | 291   | 31             |
| Today: the whole map as a static file                         | 24 KB              | 2 ms                           | 625 | 1,136 | 1,156 | 35             |
| 1. The map in the code, parsed at the first request           | 4.8 MB             | 2 ms                           | 631 | 864   | 933   | 30             |
| 1. The map in the code, parsed at the start                   | 4.8 MB             | 191 to 317 ms                  | 631 | 893   | 999   | 33             |
| 1. The map in the code as a JSON module                       | 4.8 MB             | 98 to 254 ms                   | 749 | 1,230 | 1,607 | 32             |
| 2. A smaller map (16.2 MB), as a static file                  | 24 KB              | 2 ms                           | 591 | 1,846 | 1,858 | 36             |
| 2. A smaller map in the code, parsed at the start             | 4.0 MB             | 128 to 141 ms                  | 591 | 925   | 1,246 | 32             |
| 3. Parts as static files, parts not in the cache of the place | 24 KB              | 2 ms                           | 308 | 374   | 374   | 10             |
| 3. Parts as static files, parts in the cache of the place     | 24 KB              | 2 to 4 ms                      | 170 | 249   | 349   | 33             |
| 3. The same, the first part read with the head (kept)         | 24 KB              | 2 ms                           | 160 | 252   | 288   | 37             |
| 3 in the code: the parts as text of the code (28 MB)          | 5.9 MB             | 2 ms                           | 345 | 460   | 513   | 33             |
| 3 in the code, 6 MB of text only                              | 1.1 MB             | 2 ms                           | 171 | 303   | 319   | 43             |

At a low rate (one request about every two minutes per option, for 2.1 hours, all options at the same time; first requests of new instances only). The parts here are often not in the cache of the place: 300 paths over 1,024 parts, a few requests per hour.

| Option                                                | p50 | p95   | max   | First requests | Requests | Share of new instances |
| ----------------------------------------------------- | --- | ----- | ----- | -------------- | -------- | ---------------------- |
| No map at all (the floor of the host)                 | 152 | 570   | 645   | 25             | 61       | 41 %                   |
| Today: the whole map as a static file                 | 724 | 1,383 | 1,516 | 29             | 63       | 46 %                   |
| 1. The map in the code, parsed at the first request   | 690 | 1,338 | 1,346 | 37             | 60       | 62 %                   |
| 1. The map in the code, parsed at the start           | 651 | 1,047 | 1,137 | 46             | 67       | 69 %                   |
| 1. The map in the code as a JSON module               | 863 | 1,423 | 1,545 | 35             | 62       | 56 %                   |
| 2. A smaller map (16.2 MB), as a static file          | 619 | 1,009 | 1,073 | 43             | 65       | 66 %                   |
| 2. A smaller map in the code, parsed at the start     | 519 | 879   | 1,033 | 34             | 61       | 56 %                   |
| 3. Parts as static files (the Worker of the site)     | 202 | 542   | 562   | 29             | 53       | 55 %                   |
| 3. The same, the first part read with the head (kept) | 192 | 322   | 401   | 26             | 46       | 56 %                   |
| 3. The same, one request about every ten minutes      | 335 | 571   | 571   | 8              | 8        | 100 %                  |
| 3 in the code: the parts as text of the code (28 MB)  | 381 | 856   | 958   | 39             | 63       | 62 %                   |

The memory of one instance:

| Option                                    | Heap of the instance                                                  |
| ----------------------------------------- | --------------------------------------------------------------------- |
| Today: the whole map as a static file     | 33.9 MB once parsed, 66 MB while it is parsed (the text and the map)  |
| 1. The map in the code                    | 57 MB: 24 MB of text of the code, always, and 33 MB of the parsed map |
| 3. Parts as static files, after a request | 1.3 MB                                                                |
| 3. Parts, with 128 parts kept (its limit) | 8.1 MB at most (Node, an upper bound)                                 |

The limit of the host is 128 MB per instance. The map of today and option 1 grow with every note, every former path and every unpublished note (business rule 1 keeps every former path). The map in parts does not: an instance keeps 128 parts at most.

Option 4 (a database of the host) was not measured, as the issue says: each lookup is a network call, a variant needs several, and the data does not switch or revert with a release.

## 3. Findings

1. **The floor of the host.** A Worker with no map answers the first request of a new instance in 131 ms at the median and 278 ms at the 95th percentile from this machine, right after a deployment. So the first rule of the budget (150 ms at the 95th percentile) was met by no option, and not by a Worker with no map: that is why the budget is now what the map adds to this floor (R94). About 65 ms are the connection and the handshake, and the rest of the tail is the host that starts an instance and gives a page.
2. **The whole map is slow wherever it is.** As a static file, in the code as text, or as a JSON module: 590 to 750 ms at the median. The read of 23 MB is part of it, the parse (100 ms in V8 on this machine, 140 to 320 ms at the start of an instance on the host) the other part. A map smaller by 30 percent (option 2: no Markdown path of a note, no folded form that the canonical path gives) is about 7 percent faster: not enough, and it still grows.
3. **The size of the code counts.** A Worker whose code is 28 MB (the parts as text) answers its first request 200 ms later than one with no map; with 6 MB, 40 ms later. About 7 ms per MB, and the code of option 1 grows with the map. The upload limit (64 MiB of code) is not the problem; the time is.
4. **A part that the place of the host has not cached costs about 120 to 150 ms.** 299 requests on one connection for the 300 paths took 156 to 172 ms on average the first time, and 37 to 64 ms the second time. A part, like a page, is in the cache of the place once a request asked for it; the parts of one release are the same files in the next release when their keys did not change, so a deployment does not empty that cache.
5. **The head of the map is one read more.** The Worker reads the head (and the server error page) at its first request, and only then the part of the path: with the count of the parts as a variable of the Worker (`MAP_PARTS`, written by the deployment), it reads the part of the first path at the same time as the head, 10 ms less at the median.
6. **The size limit of a static file.** The whole map of the published notes is near 23 MB, and the host takes 25 MiB per static file: the map as a static file would stop the deployments soon. The deployment no longer uploads it (`.assetsignore`); the parts are about 22 KB each, 1,024 parts for this map (1,025 files with the head: one percent of the file limit of the host).
7. **How often a visit meets a new instance.** At one request about every two minutes, 41 to 69 percent of the requests met a new instance (49 percent when the request before came less than 90 s earlier, 68 percent after 150 s or more); at one request about every ten minutes, all 8 did, in one hour. Each request came on a new connection, and the host spreads new connections over many instances. So on a site with few readers at a time, the first visit of a reader almost always meets a new instance: the first request is the common case, not the rare one. And at such a rate the part of the path is often not in the cache of the place: option 3 then costs about 50 ms at the median over the floor, and the tail is the one of a cold static file (finding 4).

## 4. The choice, and what was built

Option 3: the build cuts the resolver map into a head and parts by a hash of each key (`mapPartsOf()` and `partOfKey()` of `packages/resolver/src/parts.ts`, the integration `apps/site/src/map-parts.ts`), and writes them as static files of the release (`-/resolver-map/head.json`, `-/resolver-map/<n>.json`). They switch and revert with the release, as every static file. The resolver is the same function on a view of the parts that a request has read (`partedResolver()`): its first run stops at the first part that it lacks, so a canonical path reads one part; a variant reads the parts of its forms at once. The Worker and the plain local server read the map this way, and the URL table passes on both (`apps/site/src/urls-page.spec.ts`), and so do the answers of every kind of request against the whole map (`parts.spec.ts`).

Why not option 1: it is as slow as today with the map of this size, it costs 57 MB of the 128 MB of each instance, and both grow with the site. Why not option 2 alone: it gains 7 percent and still grows. A smaller map remains a lever inside option 3 (fewer bytes per part), with no need now.

The check for the author: `bun run first-request --base <preview address> --floor-target <target file>` (`scripts/first-request.ts`), on the preview host with the map of the published notes; it deploys a temporary floor Worker next to the host and deletes it at the end. Right after a deployment it sends a burst; with `--every 600 --requests 144` it runs a day at a low rate and gives the share of new instances. Its summary judges what the map adds at the 95th percentile over the floor against the budget, and gives apart the time after the handshake, which is the part of the host and of the Worker.

## 5. The budget against these numbers

What the map adds at the 95th percentile over the floor (no map), in ms:

| Option                                                 | Right after a deployment | At a low rate (same run as the floor) |
| ------------------------------------------------------ | ------------------------ | ------------------------------------- |
| Today: the whole map as a static file                  | 858                      | 813                                   |
| 1. The map in the code, parsed at the start            | 615                      | 477                                   |
| 2. A smaller map in the code, parsed at the start      | 647                      | 309                                   |
| 3. Parts as static files, the first part with the head | -26                      | -248                                  |
| 3 in the code: the parts as text of the code (28 MB)   | 182                      | 286                                   |

Right after a deployment, the options and the floor ran one after the other in one hour, not in the same run; at the low rate they ran at the same time. A negative number is the noise of the tail of the floor (its 95th percentile came from two or three slow requests): for option 3 the map gives no measurable addition at the 95th percentile, and the other options add far more than 60 ms. That the map in parts passes the budget is not proven until the check of the same run (host and floor together) runs on the preview host with the map of the published notes: the numbers here come from a test Worker with an invented map. The check of the budget now runs the floor in the same run: `bun run first-request --floor-target <target file>` deploys a temporary floor Worker next to the host, asks both in turn, judges the difference at the 95th percentile, and deletes the floor Worker. A lever for the low rate, not built: fewer and larger parts are more often in the cache of the place (a part of 32 KB is the default, `PART_BYTES`).

## 6. What is not verified

1. The preview host and the map of the published notes: the check exists, the author runs it (the issue forbids other work there now).
2. A day at a low rate: it ran 2.1 hours at one request every two minutes and one hour at one every ten minutes (section 2), not a day. `bun run first-request --every 600 --requests 144` on the preview host covers a day.
3. Another place than Belgium, and a client nearer to the edge than about 30 ms.
4. The memory of an instance on the host itself: the runtime of the host on this machine gives the heap; the host does not show it.
5. A release that changes many notes: the parts that change are read cold.

## Sources

- The hosting prototype: `documentation/research/2026-11-24-hosting-prototype.md`, finding 3 and section 4.
- The limits of the host: Cloudflare Workers documentation, "Limits" (startup time of 1 second, 64 MiB of code, 128 MB of memory per instance, 100,000 files and 25 MiB per static file).
- The code: `packages/resolver/src/parts.ts`, `apps/site/worker/worker.ts`, `apps/site/worker/first-request.ts`, `scripts/first-request.ts`.
