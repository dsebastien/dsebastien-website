---
tags:
  - type/note
created: 2031-03-13T07:00
updated: 2031-03-13T07:30
---

# Reading list

Every form of a `LINK` block.

One line, with a colon and a URL:

LINK: https://garden.example/soil

One line, without a colon:

LINK https://garden.example/seeds

One line, with the other keyword:

LINKS: https://garden.example/bees

One line, with a Markdown link:

LINK: [A guide to mulch](https://garden.example/mulch)

One line, with a link to a note:

LINK: [[Compost basics]]

One line, with a link to a note and a label:

LINK: [[Rain barrel|The barrel]]

A list, with a URL:

LINK:
- https://garden.example/tools

A list, without a colon, with a link to a note:

LINK
- [[Thyme]]

A list, with the other keyword and without a colon:

LINKS
- https://garden.example/hedges

A list of more than five lines, with every kind of target:

LINKS:
- https://garden.example/spring
- https://garden.example/summer
- [Autumn jobs](https://garden.example/autumn)
- [[Frost dates explained]]
- [[Winter plan (draft)]]
- https://garden.example/winter
- [[Greenhouse alarm code]]

A block where nothing can show, because its only target is on the deny list:

LINK: [[Greenhouse alarm code]]

A block where nothing can show, because its only target does not exist:

LINK
- [[Seed library rules]]

Not a `LINK` line, because it is inside a code block:

```text
LINK: https://garden.example/not-a-card
```

Not a `LINK` line, because it is inline code: `LINK: https://garden.example/inline`.

Not a `LINK` line, because it is in a comment:

%%
LINK: https://garden.example/comment
%%
