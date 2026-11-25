import {
	preambleContentUsesChatId,
	preambleContentUsesCurrentDate,
	preambleContentUsesCurrentDateLocal,
	renderPreambleContent,
	type Preamble,
} from '$shared/preambles';
import {
	expandScheduledSnippetTemplate,
	expandSnippetTemplate,
	ScheduledSnippetBoundaryError,
	SnippetExpansionError,
} from '$shared/snippet-template';
import {
	SNIPPET_ARGUMENTS_MAX_LENGTH,
	SNIPPET_VALIDATION_ERROR_MESSAGE,
	snippetTemplateUsesChatId,
	snippetTemplateUsesCurrentDate,
	snippetTemplateUsesCurrentDateLocal,
	snippetTemplateUsesProjectPath,
	type Snippet,
	type SnippetArgumentsInput,
} from '$shared/snippets';
import { runtimeTemplateValues, TemplateExpansionTooLongError } from '$shared/template-tokens';
import {
	preambleToSelectable,
	snippetToSelectable,
	type SelectableSnippet,
} from '$lib/snippets/selectable-snippet.js';

export type LocalSnippetExpansionMode =
	| { readonly kind: 'immediate'; getChatId(): string }
	| { readonly kind: 'scheduled' };

export type LocalSnippetExpansionResult =
	| { readonly kind: 'expanded'; readonly expandedText: string }
	| { readonly kind: 'error'; readonly message: string }
	| { readonly kind: 'fallback' };

export interface SnippetCatalogLookup {
	readonly hasFreshSnapshot: boolean;
	readonly snippets: readonly Snippet[];
}

export interface PreambleCatalogLookup {
	readonly hasFreshSnapshot: boolean;
	readonly preambles: readonly Preamble[];
}

const UNUSED_DATE = new Date(0);

// Returns true when the owning catalog holds a settled snapshot whose entry still matches
// the captured selection, so edits, restores, or in-flight refreshes while a dialog is open
// fall back to the server instead of expanding stale captured text.
export function catalogMatchesSelectableSnippet(
	item: SelectableSnippet,
	catalog: SnippetCatalogLookup | PreambleCatalogLookup | null,
): boolean {
	if (!catalog || !catalog.hasFreshSnapshot) return false;
	if (item.source === 'snippet') {
		if (!('snippets' in catalog)) return false;
		const current = catalog.snippets.find((entry) => entry.id === item.id);
		return (
			current !== undefined &&
			current.shortName === item.shortName &&
			current.updatedAt === item.updatedAt &&
			current.template === item.body &&
			current.defaultArguments === item.snippet.defaultArguments
		);
	}
	if (!('preambles' in catalog)) return false;
	const current = catalog.preambles.find((entry) => entry.id === item.id);
	return (
		current !== undefined &&
		current.snippetShortName === item.shortName &&
		current.updatedAt === item.updatedAt &&
		current.content === item.body
	);
}

// Finds a snippet or named preamble for slash-command fast-path expansion only when the
// owning catalog holds an uncontradicted, settled snapshot backed by a live WebSocket.
export function findFreshSelectableSnippetByShortName(
	shortName: string,
	options: {
		readonly wsConnected: boolean;
		readonly snippets: SnippetCatalogLookup;
		readonly preambles: PreambleCatalogLookup;
	},
): SelectableSnippet | null {
	if (!options.wsConnected) return null;
	if (options.snippets.hasFreshSnapshot) {
		const snippet = options.snippets.snippets.find((entry) => entry.shortName === shortName);
		if (snippet) return snippetToSelectable(snippet);
	}
	if (options.preambles.hasFreshSnapshot) {
		const preamble = options.preambles.preambles.find(
			(entry) => entry.snippetShortName === shortName,
		);
		if (preamble) return preambleToSelectable(preamble);
	}
	return null;
}

// Expands a snippet or named preamble locally when all active tokens can be resolved
// authoritatively on the client; otherwise signals callers to fall back to the server.
export function tryExpandSelectableSnippetLocally(
	item: SelectableSnippet,
	argumentsInput: SnippetArgumentsInput,
	mode: LocalSnippetExpansionMode,
): LocalSnippetExpansionResult {
	if (
		argumentsInput.type === 'value' &&
		argumentsInput.value.length > SNIPPET_ARGUMENTS_MAX_LENGTH
	) {
		return {
			kind: 'error',
			message: SNIPPET_VALIDATION_ERROR_MESSAGE,
		};
	}
	if (item.source === 'preamble') {
		return expandPreambleLocally(item.preamble, mode);
	}
	return expandSnippetLocally(item.snippet, argumentsInput, mode);
}

function expandPreambleLocally(
	preamble: Preamble,
	mode: LocalSnippetExpansionMode,
): LocalSnippetExpansionResult {
	if (mode.kind === 'scheduled') {
		return { kind: 'expanded', expandedText: preamble.content };
	}
	if (
		preambleContentUsesCurrentDate(preamble.content) ||
		preambleContentUsesCurrentDateLocal(preamble.content)
	) {
		return { kind: 'fallback' };
	}
	const chatId = preambleContentUsesChatId(preamble.content) ? mode.getChatId() : '';
	try {
		return {
			kind: 'expanded',
			expandedText: renderPreambleContent(
				preamble.content,
				runtimeTemplateValues(chatId, UNUSED_DATE),
			),
		};
	} catch (error) {
		if (error instanceof TemplateExpansionTooLongError) {
			return { kind: 'error', message: error.message };
		}
		throw error;
	}
}

function expandSnippetLocally(
	snippet: Snippet,
	argumentsInput: SnippetArgumentsInput,
	mode: LocalSnippetExpansionMode,
): LocalSnippetExpansionResult {
	const template = snippet.template;
	if (snippetTemplateUsesProjectPath(template)) {
		return { kind: 'fallback' };
	}
	if (
		mode.kind === 'immediate' &&
		(snippetTemplateUsesCurrentDate(template) || snippetTemplateUsesCurrentDateLocal(template))
	) {
		return { kind: 'fallback' };
	}
	const argumentsText =
		argumentsInput.type === 'default' ? snippet.defaultArguments : argumentsInput.value;
	try {
		const expandedText =
			mode.kind === 'scheduled'
				? expandScheduledSnippetTemplate(template, {
						arguments: argumentsText,
						projectPath: '',
					})
				: expandSnippetTemplate(template, {
						arguments: argumentsText,
						projectPath: '',
						context: runtimeTemplateValues(
							snippetTemplateUsesChatId(template) ? mode.getChatId() : '',
							UNUSED_DATE,
						),
					});
		return { kind: 'expanded', expandedText };
	} catch (error) {
		if (error instanceof SnippetExpansionError || error instanceof ScheduledSnippetBoundaryError) {
			return { kind: 'error', message: error.message };
		}
		throw error;
	}
}
