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
	type Snippet,
	type SnippetArgumentsInput,
} from '$shared/snippets';
import {
	matchTemplateTokens,
	RUNTIME_TEMPLATE_VARIABLES,
	TEMPLATE_VALIDATION_VALUES,
	TemplateExpansionTooLongError,
} from '$shared/template-tokens';
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
	readonly hasFreshSnapshot: boolean;
	readonly snippets: readonly Snippet[];
}

export interface PreambleCatalogLookup {
	readonly hasLoaded: boolean;
	readonly hasFreshSnapshot: boolean;
	readonly preambles: readonly Preamble[];
}

export interface SelectableSnippetCatalogs {
	readonly snippets: SnippetCatalogLookup | null;
	readonly preambles: PreambleCatalogLookup | null;
}

export type CatalogSelectableSnippetState = 'matched' | 'changed' | 'unavailable';

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

// Inspects the loaded catalog before checking freshness so an in-flight refresh or error
// cannot mask an already-observed selection mismatch, while a still-matching nonfresh catalog
// continues to fall back safely to the server.
export function inspectSelectableSnippetInCatalog(
	item: SelectableSnippet,
	catalogs: SelectableSnippetCatalogs,
): CatalogSelectableSnippetState {
	if (item.source === 'snippet') {
		const catalog = catalogs.snippets;
		if (!catalog || !catalog.hasLoaded) return 'unavailable';
		const current = catalog.snippets.find((entry) => entry.id === item.id);
		const matches =
			current !== undefined &&
			current.shortName === item.shortName &&
			current.updatedAt === item.updatedAt &&
			current.template === item.body &&
			current.defaultArguments === item.snippet.defaultArguments;
		if (!matches) return 'changed';
		return catalog.hasFreshSnapshot ? 'matched' : 'unavailable';
	}
	const catalog = catalogs.preambles;
	if (!catalog || !catalog.hasLoaded) return 'unavailable';
	const current = catalog.preambles.find((entry) => entry.id === item.id);
	const matches =
		current !== undefined &&
		current.snippetShortName === item.shortName &&
		current.updatedAt === item.updatedAt &&
		current.content === item.body;
	if (!matches) return 'changed';
	return catalog.hasFreshSnapshot ? 'matched' : 'unavailable';
}

// Finds a snippet or named preamble for slash-command fast-path expansion only when the
// owning catalog holds a settled snapshot backed by a live WebSocket.
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
