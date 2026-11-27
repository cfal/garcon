import { describe, expect, it, vi } from 'vitest';
import type { Preamble } from '$shared/preambles';
import { SNIPPET_ARGUMENTS_MAX_LENGTH, SNIPPET_EXPANDED_MAX_LENGTH, type Snippet } from '$shared/snippets';
import {
	findLoadedSelectableSnippetByShortName,
	isSelectedSnippetStaleInLoadedCatalog,
	tryExpandSelectableSnippetLocally,
} from '../local-snippet-expansion.js';
import {
	mismatchedSnippetSources,
	preambleToSelectable,
	snippetToSelectable,
} from '../selectable-snippet.js';

function makeSnippet(overrides: Partial<Snippet> = {}): Snippet {
	return {
		id: 'snippet-1',
		shortName: 'review',
		template: 'Review {{arguments}}',
		defaultArguments: 'changes',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

function makePreamble(overrides: Partial<Preamble> = {}): Preamble {
	return {
		id: '00000000-0000-4000-8000-000000000001',
		enabled: false,
		title: 'Manual context',
		snippetShortName: 'context',
		content: 'Context {{chat_id}}',
		scope: { type: 'global' },
		agentIds: [],
		tagFilter: { mode: 'any', tags: [] },
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

describe('tryExpandSelectableSnippetLocally', () => {
	it('expands immediate snippets with defaults, explicit arguments, escaped tokens, and lazy chat_id', () => {
		const getChatId = vi.fn(() => 'chat-123');
		const snippet = snippetToSelectable(
			makeSnippet({
				template: 'Chat {{chat_id}}: {{arguments}} (\\{{project_path}} \\{{current_date}})',
				defaultArguments: 'staged',
			}),
		);

		expect(
			tryExpandSelectableSnippetLocally(snippet, { type: 'default' }, { kind: 'immediate', getChatId }),
		).toEqual({
			kind: 'expanded',
			expandedText: 'Chat chat-123: staged ({{project_path}} {{current_date}})',
		});
		expect(getChatId).toHaveBeenCalledTimes(1);

		expect(
			tryExpandSelectableSnippetLocally(
				snippet,
				{ type: 'value', value: 'custom' },
				{ kind: 'immediate', getChatId },
			),
		).toEqual({
			kind: 'expanded',
			expandedText: 'Chat chat-123: custom ({{project_path}} {{current_date}})',
		});

		const noChatId = snippetToSelectable(makeSnippet({ template: 'Plain {{arguments}}' }));
		expect(
			tryExpandSelectableSnippetLocally(noChatId, { type: 'default' }, { kind: 'immediate', getChatId }),
		).toEqual({ kind: 'expanded', expandedText: 'Plain changes' });
		expect(getChatId).toHaveBeenCalledTimes(2);
	});

	it('falls back in immediate mode for active project_path or date tokens', () => {
		const getChatId = vi.fn(() => 'chat-123');
		for (const template of ['In {{project_path}}', 'On {{current_date}}', 'Local {{current_date_local}}']) {
			expect(
				tryExpandSelectableSnippetLocally(
					snippetToSelectable(makeSnippet({ template })),
					{ type: 'value', value: '' },
					{ kind: 'immediate', getChatId },
				),
			).toEqual({ kind: 'fallback' });
		}
		expect(getChatId).not.toHaveBeenCalled();
	});

	it('expands scheduled snippets locally for dates and deferred chat_id while falling back for project_path', () => {
		const item = snippetToSelectable(
			makeSnippet({
				template: 'Run {{arguments}} on {{current_date}} for {{chat_id}} and \\{{chat_id}}',
			}),
		);
		expect(
			tryExpandSelectableSnippetLocally(
				item,
				{ type: 'value', value: '{{chat_id}}' },
				{ kind: 'scheduled' },
			),
		).toEqual({
			kind: 'expanded',
			expandedText: 'Run \\{{chat_id}} on {{current_date}} for {{chat_id}} and \\{{chat_id}}',
		});

		expect(
			tryExpandSelectableSnippetLocally(
				snippetToSelectable(makeSnippet({ template: 'Path {{project_path}}' })),
				{ type: 'value', value: '' },
				{ kind: 'scheduled' },
			),
		).toEqual({ kind: 'fallback' });
	});

	it('returns local validation and length errors matching server semantics', () => {
		const item = snippetToSelectable(makeSnippet({ template: '{{arguments}}{{chat_id}}' }));
		expect(
			tryExpandSelectableSnippetLocally(
				item,
				{ type: 'value', value: 'report\\' },
				{ kind: 'scheduled' },
			),
		).toMatchObject({
			kind: 'error',
			message: expect.stringContaining('Add a separator'),
		});

		expect(
			tryExpandSelectableSnippetLocally(
				item,
				{ type: 'value', value: 'x'.repeat(SNIPPET_ARGUMENTS_MAX_LENGTH + 1) },
				{ kind: 'scheduled' },
			),
		).toEqual({ kind: 'error', message: 'Snippet is invalid' });

		const oversized = snippetToSelectable(makeSnippet({ template: '{{arguments}}{{arguments}}{{arguments}}' }));
		expect(
			tryExpandSelectableSnippetLocally(
				oversized,
				{ type: 'value', value: 'x'.repeat(Math.floor(SNIPPET_EXPANDED_MAX_LENGTH / 2)) },
				{ kind: 'immediate', getChatId: () => 'chat-1' },
			),
		).toEqual({
			kind: 'error',
			message: `Expanded snippet exceeds ${SNIPPET_EXPANDED_MAX_LENGTH} characters`,
		});
	});

	it('expands named preambles with preamble semantics and falls back only on active immediate dates', () => {
		const getChatId = vi.fn(() => 'chat-999');
		const literalPreamble = preambleToSelectable(
			makePreamble({
				content: 'Chat {{chat_id}} / {{arguments}} / {{project_path}} / \\{{current_date}}',
			}),
		)!;
		expect(
			tryExpandSelectableSnippetLocally(
				literalPreamble,
				{ type: 'value', value: 'ignored' },
				{ kind: 'immediate', getChatId },
			),
		).toEqual({
			kind: 'expanded',
			expandedText: 'Chat chat-999 / {{arguments}} / {{project_path}} / {{current_date}}',
		});
		expect(
			tryExpandSelectableSnippetLocally(
				literalPreamble,
				{ type: 'value', value: 'ignored' },
				{ kind: 'scheduled' },
			),
		).toEqual({ kind: 'expanded', expandedText: literalPreamble.body });

		const datedPreamble = preambleToSelectable(makePreamble({ content: 'Today {{current_date}}' }))!;
		expect(
			tryExpandSelectableSnippetLocally(datedPreamble, { type: 'default' }, { kind: 'immediate', getChatId }),
		).toEqual({ kind: 'fallback' });
		expect(
			tryExpandSelectableSnippetLocally(datedPreamble, { type: 'default' }, { kind: 'scheduled' }),
		).toEqual({ kind: 'expanded', expandedText: 'Today {{current_date}}' });
	});
});

describe('catalog helpers', () => {
	it('finds loaded snippets and named preambles by short name', () => {
		const snippet = makeSnippet({ shortName: 'alpha' });
		const preamble = makePreamble({ snippetShortName: 'beta' });

		expect(
			findLoadedSelectableSnippetByShortName('alpha', {
				snippets: { hasLoaded: true, snippets: [snippet] },
				preambles: { hasLoaded: true, preambles: [preamble] },
			}),
		).toMatchObject({ source: 'snippet', id: snippet.id });

		expect(
			findLoadedSelectableSnippetByShortName('beta', {
				snippets: { hasLoaded: false, snippets: [snippet] },
				preambles: { hasLoaded: true, preambles: [preamble] },
			}),
		).toMatchObject({ source: 'preamble', id: preamble.id });

		expect(
			findLoadedSelectableSnippetByShortName('alpha', {
				snippets: { hasLoaded: false, snippets: [snippet] },
				preambles: { hasLoaded: true, preambles: [preamble] },
			}),
		).toBeNull();
	});

	it('identifies changed sources across same-source and cross-source responses', () => {
		const item = snippetToSelectable(makeSnippet());
		expect(
			mismatchedSnippetSources(item, {
				source: 'snippet',
				sourceId: item.id,
				sourceUpdatedAt: item.updatedAt,
			}),
		).toEqual([]);
		expect(
			mismatchedSnippetSources(item, {
				source: 'snippet',
				sourceId: item.id,
				sourceUpdatedAt: '2026-01-02T00:00:00.000Z',
			}),
		).toEqual(['snippet']);
		expect(
			mismatchedSnippetSources(item, {
				source: 'preamble',
				sourceId: 'other',
				sourceUpdatedAt: item.updatedAt,
			}),
		).toEqual(['snippet', 'preamble']);
	});

	it('detects when a selected palette item is deleted or changed in loaded catalogs', () => {
		const snippet = makeSnippet();
		const selected = snippetToSelectable(snippet);
		const selectedPreamble = preambleToSelectable(makePreamble())!;

		expect(
			isSelectedSnippetStaleInLoadedCatalog(selected, {
				snippets: { hasLoaded: true, snippets: [snippet] },
				preambles: { hasLoaded: true, preambles: [] },
			}),
		).toBe(false);

		expect(
			isSelectedSnippetStaleInLoadedCatalog(selected, {
				snippets: { hasLoaded: false, snippets: [] },
				preambles: { hasLoaded: true, preambles: [] },
			}),
		).toBe(false);

		expect(
			isSelectedSnippetStaleInLoadedCatalog(selected, {
				snippets: { hasLoaded: true, snippets: [] },
				preambles: { hasLoaded: true, preambles: [] },
			}),
		).toBe(true);

		expect(
			isSelectedSnippetStaleInLoadedCatalog(selected, {
				snippets: { hasLoaded: true, snippets: [{ ...snippet, defaultArguments: 'other' }] },
				preambles: { hasLoaded: true, preambles: [] },
			}),
		).toBe(true);

		expect(
			isSelectedSnippetStaleInLoadedCatalog(selectedPreamble, {
				snippets: { hasLoaded: true, snippets: [{ ...snippet, shortName: 'context' }] },
				preambles: { hasLoaded: true, preambles: [makePreamble()] },
			}),
		).toBe(true);
	});
});
