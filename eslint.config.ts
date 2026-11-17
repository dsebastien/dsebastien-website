import eslint from '@eslint/js'
import eslintConfigPrettier from 'eslint-config-prettier'
import eslintPluginAstro from 'eslint-plugin-astro'
import { defineConfig } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

// Every rule is an error. The lint script adds `--max-warnings 0`, so that a
// rule that a preset or an override sets to "warn" also fails the run.
export default defineConfig([
    {
        ignores: [
            '**/node_modules/**',
            '**/dist/**',
            '**/.astro/**',
            '**/target/**',
            '.content/**',
            '**/.cache/**',
            '.private/**',
            '.claude/**',
            'prettier.config.cjs'
        ]
    },
    {
        files: ['**/*.{ts,mts,cts,js,mjs,cjs}'],
        extends: [eslint.configs.recommended, ...tseslint.configs.strictTypeChecked],
        languageOptions: {
            globals: {
                ...globals.node,
                // Tests and scripts run under the Bun runtime
                Bun: 'readonly'
            },
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname
            }
        },
        linterOptions: {
            reportUnusedDisableDirectives: 'error',
            reportUnusedInlineConfigs: 'error'
        },
        rules: {
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
            ],
            '@typescript-eslint/ban-ts-comment': 'error',
            '@typescript-eslint/consistent-type-imports': 'error',
            '@typescript-eslint/no-deprecated': 'error',
            '@typescript-eslint/no-require-imports': 'error',
            'no-alert': 'error',
            'no-console': ['error', { allow: ['warn', 'error'] }],
            'no-implied-eval': 'error',
            'no-new-func': 'error',
            'prefer-const': 'error'
        }
    },
    // The publishing logic exists two times, and the Rust program has no
    // Obsidian (ADR 0009). The TypeScript logic takes what it needs as input.
    {
        files: ['apps/plugin/src/publishing/**/*.ts'],
        rules: {
            'no-restricted-imports': [
                'error',
                {
                    paths: [
                        {
                            name: 'obsidian',
                            message:
                                'The publishing logic never imports Obsidian. The plugin gives it what it needs.'
                        }
                    ],
                    patterns: [
                        {
                            group: ['**/app/**'],
                            message: 'The publishing logic never imports the plugin.'
                        }
                    ]
                }
            ]
        }
    },
    // Astro components. `astro check` does the type check of these files, so
    // the rules that need type information stay with the TypeScript files.
    ...eslintPluginAstro.configs['flat/recommended'],
    eslintConfigPrettier
])
