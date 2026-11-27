import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

// The one `<style>` element that alphaTab adds to a page with a tab or a
// score (issue 53): it declares the music font. The policy of the pages
// (SEC-01) allows no inline style, so the build adds the hash of its text, as
// alphaTab writes it: the first music font of a page (no suffix) at the music
// font size of Bravura. This text follows the version of alphaTab
// (`_createStyleElements` of `BrowserUiFacade`): when an update changes it,
// the Chrome test of the music page sees a violation of the policy.

/** The music font size of alphaTab with Bravura, in pixels. */
const MUSIC_FONT_SIZE = 36

/** The file of the music font in a build, under `_astro`. */
const MUSIC_FONT_FILE = /^Bravura\.[^.]+\.woff2$/u

/** The text of the `<style>` element of alphaTab for a music font at an address. */
export function tabFontStyle(fontAddress: string): string {
    return `
            @font-face {
                font-display: block;
                font-family: 'alphaTab';
                src: url(${JSON.stringify(fontAddress)}) format('woff2');
                font-weight: normal;
                font-style: normal;
            }
            .at-surface.at .at {
                font-family: 'alphaTab';
                speak: none;
                font-style: normal;
                font-weight: normal;
                font-variant: normal;
                text-transform: none;
                line-height: 1;
                line-height: 1;
                -webkit-font-smoothing: antialiased;
                -moz-osx-font-smoothing: grayscale;
                font-size: ${String(MUSIC_FONT_SIZE)}px;
                overflow: visible !important;
            }`
}

/** The style texts that alphaTab adds to the pages of a build: none without a music font. */
export async function tabStylesOf(output: string): Promise<string[]> {
    const files = await readdir(join(output, '_astro')).catch(() => [])
    return files
        .filter((file) => MUSIC_FONT_FILE.test(file))
        .map((file) => tabFontStyle(`/_astro/${file}`))
}
