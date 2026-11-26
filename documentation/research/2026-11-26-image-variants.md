# Image variants (issue 87, PERF-25)

Date: measured on 2026-11-26, on a Windows machine of the author (Chrome of the machine, Lighthouse 13.6.0 of `package.json`, sharp 0.35.5 with libvips 8.18.7 and libwebp 1.6.0). Every image of the measure is invented: the budget sample of `packages/testing` (`samplePhoto()`). The decisions are R92 in `documentation/plans/decisions.md`.

## Question

Which format, which widths and which place to make them bring the mobile LCP of a media note back within 2.0 s (R57, R58), for the thousands of images of the published notes?

## The sample

The covers of the budget sample were PNG files of one flat color with a private chunk of random bytes: the right size on the wire, but no detail. A variant of such a file is a few hundred bytes, so it would measure nothing. The sample now has invented photos: JPEG files of noise at five scales (300 to 3 pixels), at the highest quality that fits the size, with a comment for the rest of the bytes. The cover is 1,000 by 1,500 pixels and 142,000 bytes, as before. Noise compresses worse than most covers and screenshots: the numbers below are on the side of caution.

## Format

The cover of the sample, made with the settings of `encodeVariants()` (WebP at quality 75, effort 4) and with AVIF at quality 50, effort 4, one width at a time:

| Width | WebP (bytes) | AVIF (bytes) | AVIF less than WebP | Time of WebP | Time of AVIF |
| ----- | ------------ | ------------ | ------------------- | ------------ | ------------ |
| 480   | 37,334       | 30,075       | 19 %                | 30 ms        | 104 ms       |
| 800   | 76,366       | 60,872       | 20 %                | 60 ms        | 194 ms       |
| 1,000 | 105,266      | 91,731       | 13 %                | 90 ms        | 330 ms       |

On a smoother invented photo (a first try of the sample), AVIF saved 3 to 6 % only, for twice the time. The three WebP variants of the cover take 130 ms together. WebP is the format: AVIF saves less than the gain of the right width, takes two to four times longer for thousands of images on the first deployment, and the two qualities are not the same picture quality, so its gain is not clear.

## Widths and sizes

Widths 480, 800, 1,200 and 1,600 pixels; an image gets each width below its own, and the first width at or above its own is the image at its own width in WebP. An image of 480 pixels or less gets none.

The page gives `sizes`: the screen less 2rem on a small screen, and from the screen where the column holds the image, the width of the image, at most the column of the text. Chrome lays the column out at 656 CSS pixels (`max-w-[72ch]` at `text-lg`).

What the browser loads on the media note of the sample:

| Preset of Lighthouse                       | Image on the page | Variant loaded       | Bytes (with headers) |
| ------------------------------------------ | ----------------- | -------------------- | -------------------- |
| Mobile (412 pixels wide, pixel ratio 1.75) | 380 by 570        | 800 pixels wide WebP | 76,686               |
| Desktop (1,350 pixels wide, pixel ratio 1) | 656 by 984        | 800 pixels wide WebP | 76,686               |
| Before: either preset, with no variant     | the same          | the JPEG             | 142,000              |

## LCP

`bun run budgets` on the same machine, the same sample, five runs and five more when a median fails:

| Page       | Preset  | Before (no variant): median, ms | After: median, ms | Budget, ms  |
| ---------- | ------- | ------------------------------- | ----------------- | ----------- |
| Media note | mobile  | 2,087, then 2,084 (fails)       | 1,746             | 2,000 (R57) |
| Media note | desktop | 555                             | 459               | 800         |
| Long note  | mobile  | 1,747, then 1,735 (fails)       | 1,442, then 852   | 1,200       |
| Long note  | desktop | 386                             | 417               | 800         |
| Hub note   | mobile  | 834                             | 842               | 1,200       |
| Hub note   | desktop | 316                             | 282               | 800         |

The LCP of the long note on mobile is the first paragraph, with two values on this machine (about 830 ms and about 1,740 ms, in turn): the first image of the page loads with a high priority below the fold (R58), and the simulation of Lighthouse counts it in or out. On the CI runner of `main` the same page gives 838 ms in four runs of five. A smaller first image makes the slow value rarer and lower, but does not remove it: the long note on mobile can still need the second round of five runs, and on this machine it can still fail it.

## Where they are made

On the machine that publishes, in the deploy, never in the Worker: the deploy makes each variant that the object storage lacks from the attachment folder and uploads it before the build. The object storage is the cache, so an unchanged image is never encoded again, and the build reads no image: it writes `srcset` from the size in the manifest with the same rule. sharp installs with prebuilt binaries for Windows and for Linux (it was already in the lock file, through wrangler).

## Sources

- Lighthouse reports of the runs: `.cache/page-budgets/` of the machine, not kept.
- The CI run of `main` at d7474bf, job `budgets`.
