// The vocabulary of the matching of the ads, ported from the script of the
// current site (`publish.js`, "Product CTAs"): the alias map and the phrases of
// a title. Vault tags use underscores and nesting; product tags use hyphens.
// The values of the alias map are additions: a token that equals a product tag
// matches already.

/** The alias map: the tokens that a token adds (one step, no chain). */
export const ALIASES: Readonly<Record<string, readonly string[]>> = {
    // PKM cluster
    'pkm': ['personal-knowledge-management', 'knowledge-management'],
    'personal-knowledge-management': ['pkm', 'knowledge-management'],
    'knowledge-management': ['pkm', 'personal-knowledge-management'],
    'knowledge': ['knowledge-management'],
    'second-brain': ['pkm'],
    'tools-for-thought': ['pkm', 'second-brain'],
    'notes': ['note-taking'],
    'note': ['note-taking'],
    'atomic-notes': ['note-taking'],
    'evergreen-notes': ['note-taking'],
    'osk': ['obsidian', 'templates', 'pkm'],
    'kwk': ['knowledge-work'],
    'knowledge-worker': ['knowledge-work'],
    // Software development
    'software-development': ['programming', 'it-fundamentals'],
    'software-developer': ['programming', 'it-fundamentals'],
    'programming': ['it-fundamentals'],
    'coding': ['programming'],
    'development': ['programming'],
    'developer': ['programming'],
    'it': ['it-fundamentals'],
    'computer-science': ['it-fundamentals', 'concepts'],
    // AI
    'llm': ['llms', 'ai'],
    'llms': ['ai'],
    'generative-ai': ['ai', 'llms'],
    'genai': ['ai', 'llms'],
    'agents': ['ai', 'ai-assistants'],
    'ai-agents': ['ai', 'ai-assistants'],
    'agentic': ['ai', 'ai-assistants'],
    'claude-code': ['claude', 'ai-assistants'],
    'copilot': ['ai-assistants'],
    'prompt': ['prompt-engineering', 'ai-prompts'],
    'prompts': ['prompt-engineering', 'ai-prompts'],
    'prompting': ['prompt-engineering', 'ai-prompts'],
    'mcp': ['model-context-protocol'],
    // Writing & content
    'writer': ['writing', 'content-creation'],
    'writing': ['content-creation'],
    'blogging': ['writing', 'content-creation', 'personal-brand'],
    'blog': ['writing', 'content-creation'],
    'content': ['content-creation'],
    'newsletter': ['writing', 'content-creation'],
    // Organization & productivity
    'journal': ['journaling'],
    'diary': ['journaling'],
    'reviews': ['periodic-reviews'],
    'weekly-review': ['periodic-reviews', 'journaling'],
    'organization': ['personal-organization'],
    'time': ['time-management'],
    'attention': ['focus'],
    'habit': ['habits', 'routines'],
    'habits': ['routines'],
    'routine': ['routines'],
    'goal': ['goals', 'smart-goals'],
    'goals': ['smart-goals'],
    // Life design
    'purpose': ['life-design', 'ikigai', 'clarity'],
    'life-design': ['ikigai', 'clarity'],
    'meditation': ['mindfulness'],
    'mental-health': ['mindfulness', 'journaling'],
    'personal-development': ['clarity', 'values', 'smart-goals'],
    // Learning & career
    'learn': ['learning'],
    'education': ['learning'],
    'study': ['learning'],
    'studying': ['learning'],
    'career': ['career-development'],
    'beginner': ['beginners'],
    // Misc
    'para': ['para-method'],
    'template': ['templates'],
    'voice': ['voice-to-text', 'speech-recognition'],
    'speech': ['speech-recognition', 'voice-to-text'],
    'transcription': ['voice-to-text', 'speech-recognition'],
    'dictation': ['voice-to-text', 'speech-recognition'],
    'whisper': ['voice-to-text', 'speech-recognition'],
    'tool': ['tools'],
    'directory': ['directories', 'curated', 'resources'],
    'directories': ['curated', 'resources']
}

/** The phrases of several words that a title holds, in small letters: each gives its hyphenated token. */
export const TITLE_PHRASES: readonly string[] = [
    'personal knowledge management',
    'knowledge management',
    'knowledge work',
    'second brain',
    'note taking',
    'note-taking',
    'atomic notes',
    'evergreen notes',
    'time management',
    'model context protocol',
    'prompt engineering',
    'career development',
    'interstitial journaling',
    'tools for thought',
    'mental health',
    'content creation',
    'periodic reviews',
    'personal organization',
    'para method',
    'johnny decimal',
    'speech recognition',
    'voice to text',
    'personal development'
]
