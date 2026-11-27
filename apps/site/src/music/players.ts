import type { NotePlayer } from '@dsebastien/music-notation'

// The sound players that the tab part gives the diagrams of its page, as the
// two bundles of the library share them through `window` on the current site:
// once the tab part is there, the diagrams play through alphaTab and its
// soundfonts too. Each one is made at the first use, with the light player of
// the diagrams as its fallback. A type import only: this module costs no byte
// of the library.

export interface SharedPlayers {
    /** The instrument files (GeneralUser GS) through alphaTab. */
    soundfont?: (fallback: NotePlayer) => NotePlayer
    /** The whole soundfont of alphaTab (sonivox). */
    sonivox?: (fallback: NotePlayer) => NotePlayer
}

export const sharedPlayers: SharedPlayers = {}
