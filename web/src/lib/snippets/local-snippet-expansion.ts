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
	readonly hasLoaded: boolean;
	readonly isRefreshing: boolean;
	readonly error: string | null;
	readonly snippets: readonly Snippet[];
}

export interface PreambleCatalogLookup {
	readonly hasLoaded: boolean;
	readonly isRefreshing: boolean;
	readonly error: string | null;
	readonly preambles: readonly Preamble[];
}

const UNUSED_DATE = new Date(0);

function isCatalogFresh(catalog: {
	readonly hasLoaded: boolean;
	readonly isRefreshing: boolean;
	readonly error: string | null;
}): boolean {
	return catalog.hasLoaded && !catalog.isRefreshing && catalog.error === null;
}

// Finds a snippet or named preamble for slash-command fast-path expansion only when the
// owning catalog is loaded, clean, and backed by a live WebSocket for invalidations.
export function findFreshSelectableSnippetByShortName(
	shortName: string,
	options: {
		readonly wsConnected: boolean;
		readonly snippets: SnippetCatalogLookup;
		readonly preambles: PreambleCatalogLookup;
	},
): SelectableSnippet | null {
	if (!options.wsConnected) return null;
	if (isCatalogFresh(options.snippets)) {
		const snippet = options.snippets.snippets.find((entry) => entry.shortName === shortName);
		if (snippet) return snippetToSelectable(snippet);
	}
	if (isCatalogFresh(options.preambles)) {
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
			message: `Snippet arguments exceed ${SNIPPET_ARGUMENTS_MAX_LENGTH} characters`,
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
