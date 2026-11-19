// Invented content for the mockups of issue 24 (PROTO-06). No text comes from
// the vault: this repository is public.

/** The names that the mockups propose for the site (OPEN-06). */
export const SITE_NAMES = [
    'Sébastien’s Notes',
    'The Knowii Garden',
    'DeveloPassion Notes',
    'Open Notebook'
] as const

export const HERO = {
    sentence:
        'Thousands of connected notes about knowledge management, personal productivity, software and the things I read, watch and play.',
    searchHint: 'Search 20,000 notes'
}

export const TOPICS = [
    { name: 'Knowledge management', count: 1840 },
    { name: 'Personal productivity', count: 1215 },
    { name: 'Software development', count: 2310 },
    { name: 'Artificial intelligence', count: 960 },
    { name: 'Writing', count: 540 },
    { name: 'Psychology', count: 610 },
    { name: 'Board games', count: 880 },
    { name: 'Music', count: 320 }
]

export const NOTE_TYPES = [
    { name: 'Concepts', count: 5120, hint: 'Ideas explained in my own words' },
    { name: 'Books', count: 1430, hint: 'What I read, with my highlights' },
    { name: 'Maps of content', count: 210, hint: 'Entry points into a topic' },
    { name: 'Tools', count: 980, hint: 'Software and services I use' },
    { name: 'People', count: 760, hint: 'Authors and thinkers' },
    { name: 'Board games', count: 870, hint: 'My collection, with my notes' },
    { name: 'Movies and series', count: 1190, hint: 'What I watched' },
    { name: 'Quotes', count: 3020, hint: 'Lines worth keeping' }
]

export const RECENTLY_ADDED = [
    { title: 'Spaced repetition', type: 'Concept', date: '2026-11-18' },
    { title: 'The Quiet Workshop', type: 'Book', date: '2026-11-17' },
    { title: 'Progressive summarization', type: 'Concept', date: '2026-11-15' },
    { title: 'Forest Merchants', type: 'Board game', date: '2026-11-14' },
    { title: 'Local-first software', type: 'Concept', date: '2026-11-12' }
]

export const RECENTLY_UPDATED = [
    { title: 'The Zettelkasten method', type: 'Concept', date: '2026-11-19' },
    { title: 'Personal knowledge management', type: 'Map of content', date: '2026-11-18' },
    { title: 'Obsidian', type: 'Tool', date: '2026-11-16' },
    { title: 'Deep work', type: 'Concept', date: '2026-11-13' },
    { title: 'Note types', type: 'Concept', date: '2026-11-11' }
]

export const STATS = { notes: '20,412', links: '148,930', words: '3.1 million', since: '2019' }

/** The note of the note page: a concept note in the folder of permanent notes. */
export const NOTE = {
    fileName: 'Zettelkasten (Permanent)',
    title: 'The Zettelkasten method',
    type: 'Concept',
    created: '2021-03-14',
    updated: '2026-11-19',
    readingTime: '6 min read',
    breadcrumb: [
        { label: 'Home', href: '#' },
        { label: 'Knowledge management', href: '#' },
        { label: 'Note-taking methods', href: '#' }
    ],
    inShort:
        'A way to take notes as small linked cards, so that ideas meet each other and grow into new thoughts over the years.',
    partOf: ['Knowledge management', 'Note-taking methods', 'Thinking tools'],
    properties: [
        { key: 'Type', value: 'Concept' },
        { key: 'Tags', value: 'note_taking, knowledge_management, thinking' },
        { key: 'Created', value: '14 March 2021' },
        { key: 'Updated', value: '19 November 2026' },
        { key: 'Related', value: 'Atomic notes, Evergreen notes, Slip box' }
    ],
    outline: [
        { id: 'idea', label: 'The idea' },
        { id: 'cards', label: 'Small cards, one idea each' },
        { id: 'links', label: 'Links over folders' },
        { id: 'practice', label: 'How I practice it' },
        { id: 'limits', label: 'Limits' }
    ],
    related: [
        { title: 'Atomic notes', type: 'Concept', reason: 'Linked from this note' },
        { title: 'Evergreen notes', type: 'Concept', reason: 'Shares 3 tags' },
        { title: 'How to Take Smart Notes', type: 'Book', reason: 'Linked from this note' },
        { title: 'Linking your thinking', type: 'Concept', reason: 'Shares 2 tags' }
    ],
    backlinks: [
        {
            title: 'Personal knowledge management',
            context:
                'Most methods fall into two families: folders and projects on one side, and the <mark>Zettelkasten method</mark> on the other, where links do the work.'
        },
        {
            title: 'Atomic notes',
            context:
                'An atomic note holds one idea. It is the base unit of the <mark>Zettelkasten method</mark>, and it makes a link mean something.'
        },
        {
            title: 'My note-taking system',
            context:
                'I took the linking habit from the <mark>Zettelkasten method</mark> and dropped the numbering of the cards.'
        }
    ],
    graph: [
        { label: 'Atomic notes', x: 70, y: 40 },
        { label: 'Evergreen notes', x: 250, y: 30 },
        { label: 'Slip box', x: 290, y: 130 },
        { label: 'PKM', x: 40, y: 150 },
        { label: 'Smart Notes', x: 170, y: 175 }
    ],
    cite: 'Sébastien Dubois. “The Zettelkasten method.” Notes, 19 November 2026. https://notes.dsebastien.net/30+Areas/Zettelkasten+(Permanent)',
    license: 'CC BY-NC-SA 4.0'
}

/** A book note, for the key facts box of a media note (PAGE-15). */
export const BOOK_FACTS = [
    { key: 'Author', value: 'Mara Lindqvist' },
    { key: 'Published', value: '2019' },
    { key: 'Pages', value: '312' },
    { key: 'My rating', value: '4 of 5' },
    { key: 'Read', value: 'March 2024' }
]

export const AD = {
    product: 'Obsidian Starter Kit',
    pitch: 'Start your own connected notes with a ready vault: note types, templates and a full action system.',
    cta: 'See the kit'
}

/** The book note, for the layout of a media note (PAGE-15). */
export const BOOK = {
    title: 'The Quiet Workshop',
    type: 'Book',
    created: '2024-03-02',
    updated: '2026-11-17',
    readingTime: '4 min read',
    breadcrumb: [
        { label: 'Home', href: '#' },
        { label: 'Books', href: '#' }
    ],
    inShort:
        'A short book about doing deep, careful work in a small team, and about the habits that protect it.',
    partOf: ['Books about work', 'Deep work'],
    highlights: [
        'A calm room is a decision that a team makes every morning.',
        'Finish one thing before the next one starts to shout.'
    ]
}
