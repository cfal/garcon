import {
	SNIPPET_SHORT_NAME_PATTERN,
	SNIPPET_TEMPLATE_MAX_LENGTH,
	type Snippet,
	type SnippetDefinitionInput,
} from '$shared/snippets';
import * as m from '$lib/paraglide/messages.js';

export class SnippetFormState {
	shortName = $state('');
	template = $state('');
	saving = $state(false);
	error = $state<string | null>(null);
	#editingId: string | null = null;

	constructor(private readonly getSnippets: () => readonly Snippet[]) {}

	get shortNameError(): string | null {
		if (!this.shortName) return m.snippets_short_name_required();
		if (!SNIPPET_SHORT_NAME_PATTERN.test(this.shortName)) {
			return m.snippets_short_name_invalid();
		}
		if (
			this.getSnippets().some(
				(snippet) => snippet.id !== this.#editingId && snippet.shortName === this.shortName,
			)
		) {
			return m.snippets_short_name_duplicate();
		}
		return null;
	}

	get templateError(): string | null {
		if (!this.template.trim()) return m.snippets_template_required();
		if (this.template.length > SNIPPET_TEMPLATE_MAX_LENGTH) {
			return m.snippets_template_too_long();
		}
		return null;
	}

	get canSave(): boolean {
		return !this.saving && !this.shortNameError && !this.templateError;
	}

	reset(snippet: Snippet | null): void {
		this.#editingId = snippet?.id ?? null;
		this.shortName = snippet?.shortName ?? '';
		this.template = snippet?.template ?? '';
		this.saving = false;
		this.error = null;
	}

	buildDefinition(): SnippetDefinitionInput | null {
		if (this.shortNameError || this.templateError) return null;
		return { shortName: this.shortName, template: this.template };
	}
}
