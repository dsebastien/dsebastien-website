import type { Mode } from '../../mode.ts'

// The color of the bar of the browser in each mode of the theme knowii
// (`theme-color`, issue 133): the surface of the header, so that the bar and
// the header are one band. `apps/site/src/design.spec.ts` checks them against
// the values of `knowii.css`.

/** The color of the bar of the browser, by mode. */
export const BAR_COLORS: Readonly<Record<Mode, string>> = {
    dark: '#3f4957',
    light: '#ffffff'
}
