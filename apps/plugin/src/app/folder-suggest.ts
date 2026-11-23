import { AbstractInputSuggest } from 'obsidian'
import type { App } from 'obsidian'

// The folder picker of the folder filter (B14 of the tool study): the folders
// of the vault whose path holds the text, in any letter case.

export class FolderSuggest extends AbstractInputSuggest<string> {
    constructor(
        app: App,
        private readonly input: HTMLInputElement,
        private readonly chosen: () => void
    ) {
        super(app, input)
    }

    protected override getSuggestions(query: string): string[] {
        const text = query.toLowerCase()
        return this.app.vault
            .getAllFolders(false)
            .map((folder) => folder.path)
            .filter((path) => path.toLowerCase().includes(text))
            .sort((one, two) => one.localeCompare(two))
    }

    override renderSuggestion(path: string, el: HTMLElement): void {
        el.setText(path)
    }

    override selectSuggestion(path: string): void {
        this.input.value = path
        this.chosen()
        this.close()
    }
}
