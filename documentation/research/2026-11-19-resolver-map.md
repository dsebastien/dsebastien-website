# The resolver map at full size (2026-11-19)

Issue 43 holds the measure of the prototype of the resolver (issue 20, PROTO-03): the size and the read time of the resolver map, and the time of one resolution. Measured with `bun scripts/measure-resolver-map.ts` on the invented corpus of `bun run corpus` (seed 1), as if every note of it were published, on the Linux machine of the author with Bun 1.4.4.

| Measure                                    | Value                 |
| ------------------------------------------ | --------------------- |
| Notes                                      | 20,735                |
| Notes with aliases                         | 5,468                 |
| Pages (notes, home, folder lists)          | 20,751                |
| Files (Markdown of each note, robots.txt)  | 20,736                |
| Folded texts (notes and folders)           | 20,750                |
| File names                                 | 20,735                |
| Aliases                                    | 5,385                 |
| Lists of several notes ("not found" pages) | 58                    |
| Size of the map                            | 7.4 MB                |
| Size with gzip                             | 1.7 MB                |
| Read time of the map (`JSON.parse`)        | 54 ms                 |
| Time of one resolution                     | 4 µs (4,244 requests) |

The map of the published notes of the author is larger: its paths are longer, and it has more folders. Its numbers are in the private repository, as the private part of issue 20 says.

## Where the map lives

The map is one JSON file of the output of the build (`-/resolver-map.json`). The plain server reads it one time at its start. The edge of the host reads it too, in one of two ways: as a part of its code, or as a file of the release that it loads on its first request. The hosting prototype (issue 21) chooses with the limits of the host (the size of the code, the size of one static file) and the time of a cold start, measured there. Two cuts exist when they are needed: the edge does not need `pages` and `files` when the host serves the files of the build by their paths, and the keys of `folded` repeat most canonical paths. No cut is made now (decision R43: no speed work before a first version).

## Sources

- The script: `scripts/measure-resolver-map.ts`.
- The rules of the resolver: `documentation/Configuration.md`, section "The URL contract".
