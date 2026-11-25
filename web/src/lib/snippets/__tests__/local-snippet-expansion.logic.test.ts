import { describe, expect, it, vi } from 'vitest';
import type { Preamble, PreamblesSnapshot } from '$shared/preambles';
import {
	SNIPPET_ARGUMENTS_MAX_LENGTH,
	SNIPPET_EXPANDED_MAX_LENGTH,
	SNIPPET_VALIDATION_ERROR_MESSAGE,
	type Snippet,
	type SnippetsSnapshot,
} from '$shared/snippets';
import { SnippetsStore } from '$lib/snippets/snippets-store.svelte.js';
import { PreamblesStore } from '$lib/preambles/preambles-store.svelte.js';
import { preambleToSelectable, snippetToSelectable } from '$lib/snippets/selectable-snippet.js';
import {
	catalogMatchesSelectableSnippet,
	findFreshSelectableSnippetByShortName,
	tryExpandSelectableSnippetLocally,
	type PreambleCatalogLookup,
	type SnippetCatalogLookup,
} from '$lib/snippets/local-snippet-expansion.js';

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
		content: 'Chat {{chat_id}} / {{arguments}} / {{project_path}} / \\{{chat_id}}',
		scope: { type: 'global' },
		agentIds: [],
		tagFilter: { mode: 'any', tags: [] },
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

function snippetCatalog(overrides: Partial<SnippetCatalogLookup> = {}): SnippetCatalogLookup {
	return {
		hasFreshSnapshot: true,
		snippets: [makeSnippet()],
		...overrides,
	};
}

function preambleCatalog(overrides: Partial<PreambleCatalogLookup> = {}): PreambleCatalogLookup {
	return {
		hasFreshSnapshot: true,
		preambles: [makePreamble()],
		...overrides,
	};
}

describe('findFreshSelectableSnippetByShortName', () => {
	it('finds snippets and named preambles when WS is connected and catalogs are fresh', () => {
		expect(
			findFreshSelectableSnippetByShortName('review', {
				wsConnected: true,
				snippets: snippetCatalog(),
				preambles: preambleCatalog(),
			}),
		).toMatchObject({ source: 'snippet', shortName: 'review' });

		expect(
			findFreshSelectableSnippetByShortName('context', {
				wsConnected: true,
				snippets: snippetCatalog(),
				preambles: preambleCatalog(),
			}),
		).toMatchObject({ source: 'preamble', shortName: 'context' });
	});

	it('returns null when WS is disconnected or when the matching catalog is not fresh', () => {
		expect(
			findFreshSelectableSnippetByShortName('review', {
				wsConnected: false,
				snippets: snippetCatalog(),
				preambles: preambleCatalog(),
			}),
		).toBeNull();

		expect(
			findFreshSelectableSnippetByShortName('review', {
				wsConnected: true,
				snippets: snippetCatalog({ hasFreshSnapshot: false }),
				preambles: preambleCatalog(),
			}),
		).toBeNull();
		expect(
			findFreshSelectableSnippetByShortName('context', {
				wsConnected: true,
				snippets: snippetCatalog(),
				preambles: preambleCatalog({ hasFreshSnapshot: false }),
			}),
		).toBeNull();
	});

	it('resolves from one fresh catalog even when the other catalog has not loaded', () => {
		expect(
			findFreshSelectableSnippetByShortName('review', {
				wsConnected: true,
				snippets: snippetCatalog(),
				preambles: preambleCatalog({ hasFreshSnapshot: false }),
			}),
		).toMatchObject({ source: 'snippet', shortName: 'review' });

		expect(
			findFreshSelectableSnippetByShortName('missing', {
				wsConnected: true,
				snippets: snippetCatalog(),
				preambles: preambleCatalog({ hasFreshSnapshot: false }),
			}),
		).toBeNull();
	});

	it('blocks local lookup during a retry GET and reflects restored lower-revision catalogs immediately', async () => {
		let resolveSnippetRetry!: (value: SnippetsSnapshot) => void;
		const snippetsStore = new SnippetsStore({
			get: vi
				.fn()
				.mockImplementationOnce(
					() =>
						new Promise<SnippetsSnapshot>((resolve) => {
							resolveSnippetRetry = resolve;
						}),
				)
				.mockResolvedValueOnce({
					revision: 1,
					snippets: [makeSnippet({ id: 'restored-1', shortName: 'restored', template: 'Restored body' })],
				}),
		});
		snippetsStore.applySnapshot({
			revision: 3,
			snippets: [makeSnippet({ shortName: 'probe', template: 'Old probe' })],
		});
		const preamblesStore = new PreamblesStore({
			get: vi.fn().mockResolvedValueOnce({ revision: 1, preambles: [] } satisfies PreamblesSnapshot),
		});
		preamblesStore.applySnapshot({ revision: 3, preambles: [makePreamble()] });

		const retrying = snippetsStore.refresh();
		expect(
			findFreshSelectableSnippetByShortName('probe', {
				wsConnected: true,
				snippets: snippetsStore,
				preambles: preamblesStore,
			}),
		).toBeNull();

		resolveSnippetRetry({
			revision: 3,
			snippets: [makeSnippet({ shortName: 'probe', template: 'Updated probe' })],
		});
		await retrying;
		expect(
			findFreshSelectableSnippetByShortName('probe', {
				wsConnected: true,
				snippets: snippetsStore,
				preambles: preamblesStore,
			}),
		).toMatchObject({ source: 'snippet', body: 'Updated probe' });

		await Promise.all([snippetsStore.refreshIfLoaded(), preamblesStore.refreshIfLoaded()]);
		expect(
			findFreshSelectableSnippetByShortName('probe', {
				wsConnected: true,
				snippets: snippetsStore,
				preambles: preamblesStore,
			}),
		).toBeNull();
		expect(
			findFreshSelectableSnippetByShortName('restored', {
				wsConnected: true,
				snippets: snippetsStore,
				preambles: preamblesStore,
			}),
		).toMatchObject({ source: 'snippet', body: 'Restored body' });
		expect(
			findFreshSelectableSnippetByShortName('context', {
				wsConnected: true,
				snippets: snippetsStore,
				preambles: preamblesStore,
			}),
		).toBeNull();
	});
});

describe('catalogMatchesSelectableSnippet', () => {
	it('rejects items captured before a 3 -> 2 -> 3 or same-revision restore while allowing fresh post-restore items', async () => {
		const snippetsStore = new SnippetsStore({
			get: vi
				.fn<() => Promise<SnippetsSnapshot>>()
				.mockResolvedValueOnce({ revision: 2, snippets: [] })
				.mockResolvedValueOnce({
					revision: 3,
					snippets: [makeSnippet({ shortName: 'probe', template: 'Restored {{arguments}}' })],
				})
				.mockResolvedValueOnce({
					revision: 3,
					snippets: [makeSnippet({ shortName: 'probe', template: 'Same-rev restored {{arguments}}' })],
				}),
		});
		snippetsStore.applySnapshot({
			revision: 3,
			snippets: [makeSnippet({ shortName: 'probe', template: 'Old {{arguments}}' })],
		});
		const preRestoreItem = snippetToSelectable(snippetsStore.snippets[0]!);
		expect(catalogMatchesSelectableSnippet(preRestoreItem, null)).toBe(false);
		expect(catalogMatchesSelectableSnippet(preRestoreItem, snippetsStore)).toBe(true);

		// Revision regresses 3 -> 2 (deleted in restored backup).
		await snippetsStore.refreshIfLoaded();
		expect(catalogMatchesSelectableSnippet(preRestoreItem, snippetsStore)).toBe(false);

		// Revision recovers 2 -> 3 with restored template: previously captured item still mismatches.
		await snippetsStore.refreshIfLoaded();
		expect(snippetsStore.hasFreshSnapshot).toBe(true);
		expect(catalogMatchesSelectableSnippet(preRestoreItem, snippetsStore)).toBe(false);

		// Fresh selection captured after 3 -> 2 -> 3 recovery matches.
		const postRecoveryItem = snippetToSelectable(snippetsStore.snippets[0]!);
		expect(catalogMatchesSelectableSnippet(postRecoveryItem, snippetsStore)).toBe(true);

		// Same-revision restore (3 -> 3) with changed template invalidates the captured selection even with identical updatedAt.
		await snippetsStore.reconcileAfterReconnect();
		expect(catalogMatchesSelectableSnippet(postRecoveryItem, snippetsStore)).toBe(false);
		expect(
			catalogMatchesSelectableSnippet(snippetToSelectable(snippetsStore.snippets[0]!), snippetsStore),
		).toBe(true);
	});

	it('rejects items when the owning catalog is refreshing, errored, or updated for preambles', async () => {
		const preamble = makePreamble();
		const captured = preambleToSelectable(preamble)!;
		let resolveRead!: (value: PreamblesSnapshot) => void;
		const store = new PreamblesStore({
			get: vi.fn(
				() =>
					new Promise<PreamblesSnapshot>((resolve) => {
						resolveRead = resolve;
					}),
			),
		});
		store.applySnapshot({ revision: 1, preambles: [preamble] });
		expect(catalogMatchesSelectableSnippet(captured, store)).toBe(true);

		const refreshing = store.refresh();
		expect(catalogMatchesSelectableSnippet(captured, store)).toBe(false);

		resolveRead({
			revision: 1,
			preambles: [{ ...preamble, content: 'Restored preamble content' }],
		});
		await refreshing;
		expect(catalogMatchesSelectableSnippet(captured, store)).toBe(false);
		expect(
			catalogMatchesSelectableSnippet(preambleToSelectable(store.preambles[0]!)!, store),
		).toBe(true);
	});
});

describe('tryExpandSelectableSnippetLocally (immediate mode)', () => {
	it('expands static, argument, chat_id, and escaped tokens locally without calling getChatId unnecessarily', () => {
		const getChatId = vi.fn(() => '1787471053739199');

		expect(
			tryExpandSelectableSnippetLocally(
				snippetToSelectable(
					makeSnippet({
						template: 'Review {{arguments}} (\\{{project_path}}, \\{{current_date}}, \\{{current_date_local}})',
						defaultArguments: 'staged diff',
					}),
				),
				{ type: 'default' },
				{ kind: 'immediate', getChatId },
			),
		).toEqual({
			kind: 'expanded',
			expandedText: 'Review staged diff ({{project_path}}, {{current_date}}, {{current_date_local}})',
		});
		expect(getChatId).not.toHaveBeenCalled();

		expect(
			tryExpandSelectableSnippetLocally(
				snippetToSelectable(makeSnippet({ template: 'Chat {{chat_id}}: {{arguments}}' })),
				{ type: 'value', value: 'API\ncontracts' },
				{ kind: 'immediate', getChatId },
			),
		).toEqual({
			kind: 'expanded',
			expandedText: 'Chat 1787471053739199: API\ncontracts',
		});
		expect(getChatId).toHaveBeenCalledTimes(1);
	});

	it('falls back to the server for active project_path or date tokens in snippets', () => {
		const getChatId = vi.fn(() => '1787471053739199');
		for (const template of [
			'Repo {{project_path}}',
			'Today {{current_date}}',
			'Local {{current_date_local}}',
			'\\{{project_path}} and {{project_path}}',
		]) {
			expect(
				tryExpandSelectableSnippetLocally(
					snippetToSelectable(makeSnippet({ template })),
					{ type: 'default' },
					{ kind: 'immediate', getChatId },
				),
			).toEqual({ kind: 'fallback' });
		}
		expect(getChatId).not.toHaveBeenCalled();
	});

	it('expands preambles with preamble token semantics and falls back only for active date tokens', () => {
		const getChatId = vi.fn(() => '1787471053739199');
		const preamble = preambleToSelectable(makePreamble())!;

		expect(
			tryExpandSelectableSnippetLocally(
				preamble,
				{ type: 'value', value: 'ignored' },
				{ kind: 'immediate', getChatId },
			),
		).toEqual({
			kind: 'expanded',
			expandedText: 'Chat 1787471053739199 / {{arguments}} / {{project_path}} / {{chat_id}}',
		});
		expect(getChatId).toHaveBeenCalledTimes(1);

		for (const content of ['Date {{current_date}}', 'Local {{current_date_local}}']) {
			expect(
				tryExpandSelectableSnippetLocally(
					preambleToSelectable(makePreamble({ content }))!,
					{ type: 'default' },
					{ kind: 'immediate', getChatId },
				),
			).toEqual({ kind: 'fallback' });
		}
		expect(getChatId).toHaveBeenCalledTimes(1);
	});

	it('enforces argument and expanded output bounds locally', () => {
		const getChatId = vi.fn(() => '1787471053739199');
		expect(
			tryExpandSelectableSnippetLocally(
				snippetToSelectable(makeSnippet()),
				{ type: 'value', value: 'x'.repeat(SNIPPET_ARGUMENTS_MAX_LENGTH + 1) },
				{ kind: 'immediate', getChatId },
			),
		).toEqual({
			kind: 'error',
			message: SNIPPET_VALIDATION_ERROR_MESSAGE,
		});

		expect(
			tryExpandSelectableSnippetLocally(
				snippetToSelectable(
					makeSnippet({
						template: '{{arguments}}{{arguments}}{{arguments}}',
						defaultArguments: 'x'.repeat(SNIPPET_ARGUMENTS_MAX_LENGTH),
					}),
				),
				{ type: 'default' },
				{ kind: 'immediate', getChatId },
			),
		).toEqual({
			kind: 'error',
			message: `Expanded snippet exceeds ${SNIPPET_EXPANDED_MAX_LENGTH} characters`,
		});
	});
});

describe('tryExpandSelectableSnippetLocally (scheduled mode)', () => {
	it('defers chat_id and date tokens while escaping token-shaped arguments', () => {
		expect(
			tryExpandSelectableSnippetLocally(
				snippetToSelectable(
					makeSnippet({
						template:
							'Review {{arguments}} for {{chat_id}} on {{current_date}} / {{current_date_local}} (\\{{current_date}})',
					}),
				),
				{ type: 'value', value: '{{chat_id}} and \\{{current_date}}' },
				{ kind: 'scheduled' },
			),
		).toEqual({
			kind: 'expanded',
			expandedText:
				'Review \\{{chat_id}} and \\\\{{current_date}} for {{chat_id}} on {{current_date}} / {{current_date_local}} (\\{{current_date}})',
		});
	});

	it('returns named preambles verbatim even when they include date tokens', () => {
		const content = 'Chat {{chat_id}} / {{current_date}} / {{current_date_local}} / \\{{chat_id}}';
		expect(
			tryExpandSelectableSnippetLocally(
				preambleToSelectable(makePreamble({ content }))!,
				{ type: 'default' },
				{ kind: 'scheduled' },
			),
		).toEqual({ kind: 'expanded', expandedText: content });
	});

	it('falls back only for active project_path and rejects ambiguous deferred token boundaries locally', () => {
		expect(
			tryExpandSelectableSnippetLocally(
				snippetToSelectable(makeSnippet({ template: 'In {{project_path}} on {{current_date}}' })),
				{ type: 'default' },
				{ kind: 'scheduled' },
			),
		).toEqual({ kind: 'fallback' });

		expect(
			tryExpandSelectableSnippetLocally(
				snippetToSelectable(makeSnippet({ template: '{{arguments}}{{current_date}}' })),
				{ type: 'value', value: 'report\\' },
				{ kind: 'scheduled' },
			),
		).toEqual({
			kind: 'error',
			message:
				'Scheduled snippet replacements must not create or escape adjacent template variables. Add a separator.',
		});
	});
});
