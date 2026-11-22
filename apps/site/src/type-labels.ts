// The labels of the note types on the site (decision R61, issue 49): the
// word of the title of a page, the type badge and the name of a type hub. The
// Starter Kit gives a plural display name only, so the site keeps its own
// table: a singular label, a plural label, and whether the type is a media
// type (its type tag is under `type/media/` in the vault), which puts its hub
// in the library (NAV-03). A type that is not in the table uses the display
// name of the Starter Kit for both labels. The author corrects the table.

/** The labels of one note type. */
export interface TypeLabel {
    /** The label of one note: the badge and the word of the title. */
    readonly one: string
    /** The label of the type hub. */
    readonly many: string
    /** True when the hub of the type is in the library. */
    readonly media: boolean
}

/** What the site knows of a note type: its canonical name and its display name in the Starter Kit. */
export interface SiteNoteType {
    readonly name: string
    readonly displayName: string
}

function label(one: string, many: string, media = false): TypeLabel {
    return { one, many, media }
}

/** The labels of the note types of the author, by canonical name. */
const LABELS: Readonly<Record<string, TypeLabel>> = {
    'ai-wiki-articles': label('AI wiki article', 'AI wiki articles'),
    'anime': label('Anime', 'Anime', true),
    'board-game-items': label('Board game item', 'Board game items', true),
    'board-games': label('Board game', 'Board games', true),
    'book-notes': label('Book', 'Books'),
    'comic-albums': label('Comic', 'Comics', true),
    'comic-series': label('Comic series', 'Comic series', true),
    'dots': label('Dot', 'Dots'),
    'expressions': label('Expression', 'Expressions'),
    'folder-notes': label('Folder note', 'Folder notes'),
    'guitar-arrangements': label('Guitar arrangement', 'Guitar arrangements'),
    'guitar-chords': label('Guitar chord', 'Guitar chords'),
    'guitar-strumming-patterns': label('Strumming pattern', 'Strumming patterns'),
    'knowii-event-transcripts': label('Knowii event transcript', 'Knowii event transcripts'),
    'literature-notes': label('Literature note', 'Literature notes'),
    'manga': label('Manga', 'Manga', true),
    'maps-of-content': label('Map of content', 'Maps of content'),
    'movies': label('Movie', 'Movies', true),
    'music-albums': label('Album', 'Albums', true),
    'music-artists': label('Music artist', 'Music artists'),
    'music-recordings': label('Music recording', 'Music recordings', true),
    'music-theory': label('Music theory', 'Music theory'),
    'music-works': label('Music work', 'Music works'),
    'own-articles': label('Article', 'Articles'),
    'own-books': label('My book', 'My books'),
    'own-news': label('News', 'News'),
    'own-newsletters': label('Newsletter', 'Newsletters'),
    'own-poems': label('My poem', 'My poems'),
    'own-products': label('Product', 'Products'),
    'own-quotes': label('My quote', 'My quotes'),
    'own-stories': label('My story', 'My stories'),
    'permanent-notes': label('Permanent note', 'Permanent notes'),
    'personal-notes': label('Personal note', 'Personal notes'),
    'persons': label('Person', 'People'),
    'poems': label('Poem', 'Poems'),
    'quotes': label('Quote', 'Quotes'),
    'tv-seasons': label('TV season', 'TV seasons', true),
    'tv-shows': label('TV show', 'TV shows', true),
    'video-games': label('Video game', 'Video games', true)
}

/** The labels of a note type: from the table, else the display name of the Starter Kit. */
export function typeLabelOf(type: SiteNoteType): TypeLabel {
    return Object.hasOwn(LABELS, type.name)
        ? (LABELS[type.name] ?? label(type.displayName, type.displayName))
        : label(type.displayName, type.displayName)
}
