# PROTOTYPE: hosting (issue 21, PROTO-01)

Throwaway code. It answers one question: does one Worker with static files, plus object storage for the attachments, serve the site at full size (HOST-01)? It stays on the branch `prototype/hosting` and never goes into main. The answer is in the research file of main (`documentation/research/`), and the code that the answer keeps (the handler of the site, the Worker, the command `bun run urls`) is in main.

No name of the hosting account is in this folder: the names come from the command line.

## The parts

- `entry.ts`: the entry of the test Worker. The Worker of the site, with Markdown on request (URL-11), the time of the first request of an isolate, and a switch that gives the files of Pagefind from the object storage.
- `config.ts`: writes the wrangler configuration of a test Worker into `.cache/hosting-prototype/<name>/`.
- `media.ts`: writes invented media files (a sound of 30 MiB, a small sound, a PDF, an SVG with a script) and adds them to the resolver map of a built site.
- `second-release.ts`: changes 5 notes and 300 files of a copy of a built site (check 5).
- `load.ts`: asks a host for every address of a built site and for invented wrong addresses, and counts the answers (checks 2 and 6).
- `probe.ts`: prints the answers of a host for HTML and Markdown on request and for the attachments with ranges (checks 3 and 4).

## One command per step

```sh
# The site of the URL table, and the table on a host
bun run urls build
bun run urls check --base <address>

# A local run in the runtime of the host, with no account
bun prototype/hosting/config.ts --name proto-local --dist apps/site/.cache/url-table-site/dist --bucket proto-local-bucket
npx wrangler@4.166.0 dev --config .cache/hosting-prototype/proto-local/wrangler.jsonc

# The exit drill: the same output on the plain local server
bun run serve --dist <dist> --attachments <folder>
bun prototype/hosting/load.ts --base http://127.0.0.1:4322 --map <dist>/-/resolver-map.json
```

The full-size output comes from `bun run corpus`, a publication of every note with the command line program into a local content store, and `CONTENT_STORE=<copy> bun run build:site` (the steps are a comment on issue 19).
