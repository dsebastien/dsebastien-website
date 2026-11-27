// The instrument files of the playback (PERF-21): GeneralUser GS, one small
// soundfont per instrument, from the pinned npm package
// `@dsebastien/music-notation-sounds`. The build copies its folder into the
// output (`soundsFolder()` of `sounds-integration.ts`), under a name with the
// version of the package, so the host keeps it like any file of `_astro/`. A
// player reads only the files of what it plays, at the first Play.

/** The version of the package of the sounds; a test checks it against the installed one. */
export const SOUNDS_VERSION = '0.1.1'

/** The folder of the instrument files in the output of the build. */
export const SOUNDS_FOLDER = `_astro/music-notation-sounds-${SOUNDS_VERSION}/generaluser`

/** The address of that folder on the site. */
export const SOUNDS_PATH = `/${SOUNDS_FOLDER}`
