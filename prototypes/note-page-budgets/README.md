# Note page budgets (issue 25, PROTO-07)

The prototype that measured the note page of variant B. The result, the method and the budgets that the author set (R57) are in `documentation/research/2026-11-20-note-page-budgets.md` on main. This branch is not merged.

- `apps/site/src/pages/-/note/[id].astro`: the note page of variant B on the rendering of issue 45, with the blocks of the mockups (`apps/site/src/budget/`) and the real backlinks from the manifest. `BUDGET_BACKLINKS` caps the backlinks (50 by default); `BUDGET_PRELOAD=1` preloads the Latin font and loads the first image at once with a high priority.
- `vault.ts`: the invented vault (a long note, a media note, a hub note with 489 backlinks), made with ImageMagick and ffmpeg.
- `measure.ts`: publishes the vault, builds the site three times (`capped`, `tuned`, `uncapped`), serves it behind a Brotli proxy and runs Lighthouse (mobile and desktop, 5 runs each). A run waits until the load of the machine is low.
- `results/results.json`: the medians of the run of the research file.

```bash
bun prototypes/note-page-budgets/measure.ts --runs 5
```

It needs Chrome (`CHROME_PATH`, `/usr/bin/google-chrome-stable` by default), `magick` and `ffmpeg`. The Lighthouse reports go to `.cache/budgets/`.
