import { ApiError } from '$lib/api/client.js';
import * as m from '$lib/paraglide/messages.js';
import { matchesSelectableSnippetExpansion, type SelectableSnippet } from '$lib/snippets/selectable-snippet.js';
import { snippetErrorDetail } from '$lib/snippets/snippet-expansion-controller.svelte.js';
import type { ExpandSnippetResponse } from '$shared/snippets';
import type { SnippetInsertionResult } from './snippet-insertion.js';
import { applySnippetTriggerReplacement } from './snippet-trigger.js';

type Expansion<Prepared> =
	| { kind: 'expanded'; response: ExpandSnippetResponse; prepared: Prepared }
	| { kind: 'cancelled' };

interface InsertionOptions<Prepared> {
	expand(): Promise<Expansion<Prepared>>;
	isCurrent(expanded: Extract<Expansion<Prepared>, { kind: 'expanded' }>): boolean;
	apply(text: string): void;
	insertion?: {
		snippet: SelectableSnippet;
		source: string;
		selection: { start: number; end: number };
		trigger: { start: number; end: number } | null;
	};
}

interface SnippetInsertionPort {
	refreshSnippets(): unknown;
	refreshPreambles(): unknown;
	reportError(message: string): void;
	settle(caret?: number): Promise<void>;
}

export class ChatSnippetInsertionController {
	constructor(private readonly port: SnippetInsertionPort) {}

	async execute<Prepared>(options: InsertionOptions<Prepared>): Promise<SnippetInsertionResult> {
		try {
			const result = await options.expand();
			if (result.kind !== 'expanded') return 'cancelled';
			const { insertion } = options;
			if (insertion && !matchesSelectableSnippetExpansion(insertion.snippet, result.response)) {
				if (insertion.snippet.source === 'snippet') void this.port.refreshSnippets();
				else void this.port.refreshPreambles();
				this.port.reportError(m.snippets_changed_before_expansion());
				await this.port.settle();
				return 'cancelled';
			}
			if (!options.isCurrent(result)) return 'cancelled';
			const expanded = result.response.expandedText;
			const replacement = insertion
				? applySnippetTriggerReplacement(insertion.source, insertion.trigger ?? insertion.selection, expanded)
				: { text: expanded, caret: expanded.length };
			options.apply(replacement.text);
			await this.port.settle(replacement.caret);
			return 'inserted';
		} catch (error) {
			if (error instanceof ApiError && error.status === 404) {
				void this.port.refreshSnippets();
				void this.port.refreshPreambles();
			}
			this.port.reportError(m.snippets_expand_error({ detail: snippetErrorDetail(error) }));
			await this.port.settle();
			return 'failed';
		}
	}
}
