# Result per form

Written by run.ts. Cell: pass, or fail/error with failed checks of all checks.

| Form                    | satteri-today | quartz-v5    | parser-plain | parser-rehype-obsidian | astro-loader-obsidian |
| ----------------------- | ------------- | ------------ | ------------ | ---------------------- | --------------------- |
| wikilink-note           | pass          | pass         | fail (1/2)   | fail (1/2)             | pass                  |
| wikilink-heading        | pass          | pass         | fail (2/3)   | fail (2/3)             | fail (1/3)            |
| wikilink-block          | pass          | pass         | fail (2/3)   | fail (2/3)             | pass                  |
| wikilink-alias          | pass          | pass         | fail (1/4)   | fail (1/4)             | pass                  |
| wikilink-hard-names     | pass          | pass         | fail (3/4)   | fail (3/4)             | fail (2/4)            |
| wikilink-unpublished    | pass          | pass         | pass         | pass                   | pass                  |
| wikilink-missing        | pass          | pass         | pass         | pass                   | pass                  |
| wikilink-duplicate-name | pass          | pass         | fail (2/3)   | fail (2/3)             | fail (1/3)            |
| wikilink-own-heading    | pass          | pass         | fail (2/3)   | fail (2/3)             | fail (2/3)            |
| markdown-link-note      | pass          | pass         | pass         | pass                   | fail (1/3)            |
| embed-image-size        | pass          | pass         | fail (4/6)   | fail (4/6)             | fail (4/6)            |
| embed-image-in-link     | pass          | pass         | pass         | pass                   | fail (1/2)            |
| embed-note              | pass          | fail (2/3)   | fail (2/3)   | fail (2/3)             | pass                  |
| embed-heading           | pass          | fail (1/3)   | fail (1/3)   | fail (1/3)             | pass                  |
| embed-block             | pass          | fail (2/4)   | fail (1/4)   | fail (1/4)             | fail (1/4)            |
| embed-cycle             | pass          | fail (2/4)   | fail (2/4)   | fail (2/4)             | fail (2/4)            |
| embed-pdf               | pass          | pass         | fail (1/2)   | fail (1/2)             | fail (1/2)            |
| embed-audio             | pass          | pass         | fail (1/2)   | fail (1/2)             | fail (1/2)            |
| embed-video             | pass          | pass         | fail (1/2)   | fail (1/2)             | fail (1/2)            |
| embed-base              | pass          | pass         | fail (1/3)   | fail (1/3)             | fail (1/3)            |
| embed-canvas            | pass          | pass         | fail (1/3)   | fail (1/3)             | fail (1/3)            |
| callout-types           | pass          | fail (2/5)   | fail (4/5)   | fail (4/5)             | fail (5/5)            |
| callout-folded          | pass          | pass         | fail (3/4)   | fail (3/4)             | fail (4/4)            |
| callout-nested          | pass          | pass         | fail (2/3)   | fail (2/3)             | fail (3/3)            |
| callout-title           | pass          | pass         | fail (2/3)   | fail (2/3)             | fail (3/3)            |
| frozen-dataview-table   | pass          | fail (2/4)   | fail (3/4)   | fail (3/4)             | pass                  |
| frozen-dataview-list    | pass          | fail (2/4)   | fail (3/4)   | fail (3/4)             | pass                  |
| link-block              | pass          | fail (14/32) | fail (18/32) | fail (18/32)           | fail (14/32)          |
| video-url-line          | pass          | fail (3/3)   | fail (2/3)   | fail (3/3)             | fail (2/3)            |
| meta-bind-inline        | pass          | fail (2/3)   | fail (2/3)   | fail (2/3)             | fail (2/3)            |
| meta-bind-block         | pass          | fail (5/5)   | fail (5/5)   | fail (5/5)             | fail (4/5)            |
| live-dataview           | pass          | fail (4/4)   | fail (4/4)   | fail (4/4)             | fail (3/4)            |
| live-base               | pass          | fail (2/2)   | fail (2/2)   | fail (2/2)             | fail (2/2)            |
| comment-percent         | pass          | pass         | pass         | pass                   | fail (3/6)            |
| comment-html            | pass          | fail (3/4)   | fail (3/4)   | fail (3/4)             | pass                  |
| tags                    | pass          | fail (3/5)   | fail (3/5)   | fail (3/5)             | fail (2/5)            |
| footnotes               | pass          | pass         | fail (2/5)   | fail (2/5)             | fail (3/5)            |
| highlights              | pass          | pass         | fail (2/3)   | fail (2/3)             | fail (3/3)            |
| math-inline             | pass          | fail (1/3)   | fail (1/3)   | fail (1/3)             | fail (2/3)            |
| math-block              | pass          | fail (1/3)   | fail (1/3)   | fail (1/3)             | fail (2/3)            |
| mermaid                 | pass          | fail (2/4)   | fail (2/4)   | fail (2/4)             | fail (3/4)            |
| table-pipe-in-link      | pass          | pass         | fail (1/4)   | fail (1/4)             | fail (1/4)            |
| task-list               | pass          | fail (3/4)   | pass         | pass                   | fail (3/4)            |
| properties              | pass          | pass         | pass         | pass                   | pass                  |
| headings-same-text      | pass          | fail (1/4)   | fail (3/4)   | fail (3/4)             | fail (2/4)            |
| code-block              | pass          | fail (1/2)   | pass         | pass                   | fail (1/2)            |
| raw-html                | pass          | fail (3/4)   | fail (3/4)   | fail (3/4)             | fail (3/4)            |
| **passed** (of 47)      | 47            | 25           | 8            | 8                      | 11                    |
