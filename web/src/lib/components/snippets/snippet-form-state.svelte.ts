import {
	SNIPPET_ARGUMENTS_MAX_LENGTH,
	SNIPPET_ARGUMENTS_TOKEN,
	SNIPPET_SHORT_NAME_PATTERN,
	SNIPPET_TEMPLATE_MAX_LENGTH,
	snippetTemplateUsesArguments,
	type Snippet,
	type SnippetDefinitionInput,
} from '$shared/snippets';
import * as m from '$lib/paraglide/messages.js';

export class SnippetFormState {
	shortName = $state('');
	defaultArguments = $state('');
	saving = $state(false);
	error = $state<string | null>(null);
	#editingId: string | null = null;
	#template = $state('');
	#templateRevision = $state(0);

	constructor(private readonly getSnippets: () => readonly Snippet[]) {}

	get template(): string {
		return this.#template;
	}

	set template(template: string) {
		if (template === this.#template) return;
		this.#template = template;
		this.#templateRevision += 1;
	}

	get templateRevision(): number {
		return this.#templateRevision;
	}

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

	get defaultArgumentsError(): string | null {
		if (this.defaultArguments.length > SNIPPET_ARGUMENTS_MAX_LENGTH) {
			return m.snippets_default_arguments_too_long();
		}
		if (this.defaultArguments.length > 0 && !snippetTemplateUsesArguments(this.template)) {
			return m.snippets_default_arguments_requires_token({
				argumentsToken: SNIPPET_ARGUMENTS_TOKEN,
			});
		}
		return null;
	}

	get canSave(): boolean {
		return (
			!this.saving && !this.shortNameError && !this.templateError && !this.defaultArgumentsError
		);
	}

	reset(snippet: Snippet | null): void {
		this.#editingId = snippet?.id ?? null;
		this.shortName = snippet?.shortName ?? '';
		this.template = snippet?.template ?? '';
		this.defaultArguments = snippet?.defaultArguments ?? '';
		this.saving = false;
		this.error = null;
	}

	buildDefinition(): SnippetDefinitionInput | null {
		if (this.shortNameError || this.templateError || this.defaultArgumentsError) return null;
		return {
			shortName: this.shortName,
			template: this.template,
			defaultArguments: this.defaultArguments,
		};
	}
}
