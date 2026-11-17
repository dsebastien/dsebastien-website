import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

// Guard: the compiler options below are the strictness floor of this repository.
// A change that switches one off must fail here, not pass unnoticed in a review.
const MUST_BE_TRUE = [
    'strict',
    'alwaysStrict',
    'strictBindCallApply',
    'strictFunctionTypes',
    'strictNullChecks',
    'strictPropertyInitialization',
    'useUnknownInCatchVariables',
    'exactOptionalPropertyTypes',
    'noFallthroughCasesInSwitch',
    'noImplicitAny',
    'noUncheckedIndexedAccess',
    'noImplicitOverride',
    'noUnusedLocals',
    'noUnusedParameters',
    'noImplicitReturns',
    'noImplicitThis',
    'noPropertyAccessFromIndexSignature',
    'noUncheckedSideEffectImports',
    'forceConsistentCasingInFileNames',
    'verbatimModuleSyntax',
    'isolatedModules',
    'noEmit'
] as const

const MUST_BE_FALSE = ['allowJs', 'checkJs', 'allowUnreachableCode', 'allowUnusedLabels'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readCompilerOptions(): Record<string, unknown> {
    const path = fileURLToPath(new URL('../tsconfig.json', import.meta.url))
    const result = ts.readConfigFile(path, (file) => ts.sys.readFile(file))
    if (result.error !== undefined) {
        throw new Error(ts.flattenDiagnosticMessageText(result.error.messageText, '\n'))
    }
    const config: unknown = result.config
    if (!isRecord(config) || !isRecord(config['compilerOptions'])) {
        throw new Error('tsconfig.json has no compilerOptions')
    }
    return config['compilerOptions']
}

test('tsconfig.json keeps every strictness option on', () => {
    const options = readCompilerOptions()
    const switchedOff = MUST_BE_TRUE.filter((name) => options[name] !== true)
    expect(switchedOff).toEqual([])
})

test('tsconfig.json keeps every leniency option off', () => {
    const options = readCompilerOptions()
    const switchedOn = MUST_BE_FALSE.filter((name) => options[name] !== false)
    expect(switchedOn).toEqual([])
})

test('tsconfig.json pins the ambient types', () => {
    const options = readCompilerOptions()
    expect(options['types']).toEqual(['bun', 'node'])
})
