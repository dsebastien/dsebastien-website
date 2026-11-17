import { RuleConfigSeverity, type UserConfig } from '@commitlint/types'

const Configuration: UserConfig = {
    extends: ['@commitlint/config-conventional'],
    rules: {
        'header-max-length': [RuleConfigSeverity.Error, 'always', 100],
        'scope-enum': [
            RuleConfigSeverity.Error,
            'always',
            ['all', 'build', 'ci', 'cli', 'deps', 'docs', 'plugin', 'release', 'site']
        ],
        'scope-case': [RuleConfigSeverity.Error, 'always', 'lowercase']
    }
}

export default Configuration
