# Result per form

Written by run.ts. Cell: pass, or fail/error with failed checks of all checks.

| Form                    | satteri-today | quartz-v5    | parser-plain | parser-rehype-obsidian | astro-loader-obsidian |
| ----------------------- | ------------- | ------------ | ------------ | ---------------------- | --------------------- |
| wikilink-note           | pass          | pass         | fail (1/2)   | fail (1/2)             | pass                  |
| wikilink-heading        | fail (2/3)    | pass         | fail (2/3)   | fail (2/3)             | fail (1/3)            |
| wikilink-block          | fail (1/2)    | pass         | fail (1/2)   | fail (1/2)             | pass                  |
| wikilink-alias          | pass          | pass         | fail (1/4)   | fail (1/4)             | pass                  |
| wikilink-hard-names     | pass          | pass         | fail (3/4)   | fail (3/4)             | fail (2/4)            |
| wikilink-unpublished    | pass          | pass         | pass         | pass                   | pass                  |
| wikilink-missing        | pass          | pass         | pass         | pass                   | pass                  |
| wikilink-duplicate-name | pass          | pass         | fail (2/3)   | fail (2/3)             | pass                  |
| wikilink-own-heading    | fail (2/3)    | pass         | fail (2/3)   | fail (2/3)             | fail (2/3)            |
| markdown-link-note      | pass          | pass         | pass         | pass                   | fail (1/3)            |
| embed-image-size        | fail (2/6)    | pass         | fail (4/6)   | fail (4/6)             | fail (4/6)            |
| embed-image-in-link     | fail (2/2)    | pass         | pass         | pass                   | fail (1/2)            |
| embed-note              | fail (2/3)    | fail (2/3)   | fail (2/3)   | fail (2/3)             | pass                  |
| embed-heading           | fail (1/3)    | fail (1/3)   | fail (1/3)   | fail (1/3)             | pass                  |
| embed-block             | fail (2/4)    | fail (2/4)   | fail (1/4)   | fail (1/4)             | fail (1/4)            |
| embed-cycle             | fail (2/4)    | fail (2/4)   | fail (2/4)   | fail (2/4)             | fail (2/4)            |
| embed-pdf               | pass          | pass         | fail (1/2)   | fail (1/2)             | fail (1/2)            |
| embed-audio             | pass          | pass         | fail (1/2)   | fail (1/2)             | fail (1/2)            |
| embed-video             | pass          | pass         | fail (1/2)   | fail (1/2)             | fail (1/2)            |
| embed-base              | pass          | pass         | fail (1/3)   | fail (1/3)             | fail (1/3)            |
| embed-canvas            | pass          | pass         | fail (1/3)   | fail (1/3)             | fail (1/3)            |
| callout-types           | fail (5/5)    | fail (2/5)   | fail (4/5)   | fail (4/5)             | fail (5/5)            |
| callout-folded          | fail (4/4)    | pass         | fail (3/4)   | fail (3/4)             | fail (4/4)            |
| callout-nested          | fail (3/3)    | pass         | fail (2/3)   | fail (2/3)             | fail (3/3)            |
| callout-title           | fail (3/3)    | pass         | fail (2/3)   | fail (2/3)             | fail (3/3)            |
| frozen-dataview-table   | fail (2/4)    | fail (2/4)   | fail (3/4)   | fail (3/4)             | pass                  |
| frozen-dataview-list    | fail (2/4)    | fail (2/4)   | fail (3/4)   | fail (3/4)             | pass                  |
| link-block              | fail (15/32)  | fail (14/32) | fail (18/32) | fail (18/32)           | fail (14/32)          |
| video-url-line          | fail (2/3)    | fail (3/3)   | fail (2/3)   | fail (3/3)             | fail (2/3)            |
| meta-bind-inline        | fail (2/3)    | fail (2/3)   | fail (2/3)   | fail (2/3)             | fail (2/3)            |
| meta-bind-block         | fail (4/4)    | fail (4/4)   | fail (4/4)   | fail (4/4)             | fail (3/4)            |
| live-dataview           | fail (4/4)    | fail (4/4)   | fail (4/4)   | fail (4/4)             | fail (3/4)            |
| live-base               | fail (2/2)    | fail (2/2)   | fail (2/2)   | fail (2/2)             | fail (2/2)            |
| comment-percent         | fail (3/6)    | pass         | pass         | pass                   | fail (3/6)            |
| comment-html            | fail (3/4)    | fail (3/4)   | fail (3/4)   | fail (3/4)             | pass                  |
| tags                    | fail (3/5)    | fail (3/5)   | fail (3/5)   | fail (3/5)             | fail (2/5)            |
| footnotes               | fail (3/5)    | pass         | fail (2/5)   | fail (2/5)             | fail (3/5)            |
| highlights              | fail (3/3)    | pass         | fail (2/3)   | fail (2/3)             | fail (3/3)            |
| math-inline             | fail (2/3)    | fail (1/3)   | fail (1/3)   | fail (1/3)             | fail (2/3)            |
| math-block              | fail (2/3)    | fail (1/3)   | fail (1/3)   | fail (1/3)             | fail (2/3)            |
| mermaid                 | fail (2/4)    | fail (2/4)   | fail (2/4)   | fail (2/4)             | fail (3/4)            |
| table-pipe-in-link      | pass          | pass         | fail (1/4)   | fail (1/4)             | fail (1/4)            |
| task-list               | fail (3/4)    | fail (3/4)   | pass         | pass                   | fail (3/4)            |
| properties              | pass          | pass         | pass         | pass                   | pass                  |
| headings-same-text      | fail (2/4)    | fail (1/4)   | fail (3/4)   | fail (3/4)             | fail (2/4)            |
| code-block              | fail (1/2)    | fail (1/2)   | pass         | pass                   | fail (1/2)            |
| raw-html                | fail (3/4)    | fail (3/4)   | fail (3/4)   | fail (3/4)             | fail (3/4)            |
| **passed** (of 47)      | 14            | 25           | 8            | 8                      | 12                    |
