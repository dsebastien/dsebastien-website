# Configuration

## TypeScript

`tsconfig.json` at the repository root. Maximum strictness, from the Obsidian plugin template of the author, plus `exactOptionalPropertyTypes`, `useUnknownInCatchVariables`, `noUncheckedSideEffectImports` and `forceConsistentCasingInFileNames`.

- `types` is pinned to `bun` and `node`, so that a missing type package is a hard error.
- `allowJs` is off: JavaScript files cannot skip the type check.
- `lib` includes `DOM` for now. Packages that run only on a server get their own configuration without it.
- `jsx` is not set. It is added with the first package that needs it.
- Packages and apps extend this file. An Astro app also extends the strictest Astro preset.

## Formatting

Prettier (`prettier.config.cjs`): no semicolons, single quotes, width 100, 4 spaces, no trailing commas.

## Bun

`bunfig.toml`: exact versions, and a 3-day waiting time for new package versions.
