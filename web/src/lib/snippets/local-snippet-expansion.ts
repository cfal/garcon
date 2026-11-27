import { renderPreambleContent, type Preamble } from '$shared/preambles';
import {
	expandScheduledSnippetTemplate,
	expandSnippetTemplate,
	ScheduledSnippetBoundaryError,
	SnippetExpansionError,
} from '$shared/snippet-template';
import {
	SNIPPET_ARGUMENTS_MAX_LENGTH,
	SNIPPET_TEMPLATE_VARIABLES,
	SNIPPET_VALIDATION_ERROR_MESSAGE,
} from '$shared/snippets';
import {
	matchTemplateTokens,
	RUNTIME_TEMPLATE_VARIABLES,
	TEMPLATE_VALIDATION_VALUES,
	TemplateExpansionTooLongError,
} from '$shared/template-tokens';
import {
	mismatchedSnippetSources,
	preambleToSelectable,
	snippetToSelectable,
	type SelectableSnippet,
} from '$lib/snippets/selectable-snippet.js';
import type { ExpandSnippetResponse, Snippet, SnippetArgumentsInput } from '$shared/snippets';

export type LocalSnippetExpansionMode =
	| { readonly kind: 'immediate'; getChatId(): string }
	| { readonly kind: 'scheduled' };

export type LocalSnippetExpansionResult =
	| { readonly kind: 'expanded'; readonly expandedText: string }
	| { readonly kind: 'error'; readonly message: string }
	| { readonly kind: 'fallback' };

export interface SnippetCatalogLookup {
	readonly hasLoaded: boolean;
	readonly snippets: readonly Snippet[];
}

export interface PreambleCatalogLookup {
	readonly hasLoaded: boolean;
	readonly preambles: readonly Preamble[];
}

export interface SnippetCatalogLookups {
	readonly snippets?: SnippetCatalogLookup | null;
	readonly preambles?: PreambleCatalogLookup | null;
}

function collectActiveVariables<Variable extends string>(
	template: string,
	allowedVariables: readonly Variable[],
): Set<Variable> {
	const active = new Set<Variable>();
	for (const match of matchTemplateTokens(template, allowedVariables)) {
		if (!match.escaped) active.add(match.variable);
	}
	return active;
}

export function hasLoadedShortNameConflict(
	shortName: string,
	options: SnippetCatalogLookups,
): boolean {
	const hasSnippet = Boolean(
		options.snippets?.hasLoaded &&
			options.snippets.snippets.some((entry) => entry.shortName === shortName),
	);
	const hasPreamble = Boolean(
		options.preambles?.hasLoaded &&
			options.preambles.preambles.some((entry) => entry.snippetShortName === shortName),
	);
	return hasSnippet && hasPreamble;
}

export function findLoadedSelectableSnippetByShortName(
	shortName: string,
	options: SnippetCatalogLookups,
): SelectableSnippet | null {
	const snippet = options.snippets?.hasLoaded
		? options.snippets.snippets.find((entry) => entry.shortName === shortName)
		: undefined;
	const preamble = options.preambles?.hasLoaded
		? options.preambles.preambles.find((entry) => entry.snippetShortName === shortName)
		: undefined;
	// Treat cross-catalog duplicates as ambiguous so callers reconcile and defer to server precedence.
	if (snippet && preamble) return null;
	if (snippet) return snippetToSelectable(snippet);
	if (preamble) return preambleToSelectable(preamble);
	return null;
}

export function isSelectedSnippetStaleInLoadedCatalog(
	selected: SelectableSnippet,
	options: SnippetCatalogLookups,
): boolean {
	const owningCatalog = selected.source === 'snippet' ? options.snippets : options.preambles;
	if (!owningCatalog) return false;
	if (!owningCatalog.hasLoaded) return true;
	const current = findLoadedSelectableSnippetByShortName(selected.shortName, options);
	if (!current || current.source !== selected.source) return true;
	if (
		current.id !== selected.id ||
		current.updatedAt !== selected.updatedAt ||
		current.body !== selected.body
	) {
		return true;
	}
	return (
		selected.source === 'snippet' &&
		current.source === 'snippet' &&
		current.snippet.defaultArguments !== selected.snippet.defaultArguments
	);
}

// Returns catalogs to refresh when a palette selection no longer matches loaded catalogs
// or the server response, or null when current. Cross-catalog conflicts run before mismatch
// checks so a same-source server response cannot refresh only one catalog.
export function staleSelectionRefreshSources(
	selected: SelectableSnippet,
	catalogs: SnippetCatalogLookups,
	response?: Pick<ExpandSnippetResponse, 'source' | 'sourceId' | 'sourceUpdatedAt'>,
): readonly SelectableSnippet['source'][] | null {
	if (hasLoadedShortNameConflict(selected.shortName, catalogs)) return ['snippet', 'preamble'];
	if (response) {
		const mismatched = mismatchedSnippetSources(selected, response);
		if (mismatched.length > 0) return mismatched;
	}
	return isSelectedSnippetStaleInLoadedCatalog(selected, catalogs) ? [] : null;
}

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
	const active = collectActiveVariables(preamble.content, RUNTIME_TEMPLATE_VARIABLES);
	if (active.has('current_date') || active.has('current_date_local')) {
		return { kind: 'fallback' };
	}
	const chatId = active.has('chat_id') ? mode.getChatId() : '';
	try {
		return {
			kind: 'expanded',
			// Active date tokens already fell back above, so placeholder dates are never substituted.
			expandedText: renderPreambleContent(preamble.content, {
				...TEMPLATE_VALIDATION_VALUES,
				chat_id: chatId,
			}),
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
	const active = collectActiveVariables(template, SNIPPET_TEMPLATE_VARIABLES);
	if (active.has('project_path')) {
		return { kind: 'fallback' };
	}
	if (
		mode.kind === 'immediate' &&
		(active.has('current_date') || active.has('current_date_local'))
	) {
		return { kind: 'fallback' };
	}
	const values = {
		arguments: argumentsInput.type === 'default' ? snippet.defaultArguments : argumentsInput.value,
		projectPath: '',
	};
	try {
		if (mode.kind === 'scheduled') {
			return {
				kind: 'expanded',
				expandedText: expandScheduledSnippetTemplate(template, values),
			};
		}
		const chatId = active.has('chat_id') ? mode.getChatId() : '';
		return {
			kind: 'expanded',
			expandedText: expandSnippetTemplate(template, {
				...values,
				// Active date tokens already fell back above, so placeholder dates are never substituted.
				context: { ...TEMPLATE_VALIDATION_VALUES, chat_id: chatId },
			}),
		};
	} catch (error) {
		if (error instanceof SnippetExpansionError || error instanceof ScheduledSnippetBoundaryError) {
			return { kind: 'error', message: error.message };
		}
		throw error;
	}
}
