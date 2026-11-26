import { describe, expect, it, vi } from 'vitest';
import type { Preamble } from '$shared/preambles';
import {
	SNIPPET_ARGUMENTS_MAX_LENGTH,
	SNIPPET_EXPANDED_MAX_LENGTH,
	SNIPPET_VALIDATION_ERROR_MESSAGE,
	type Snippet,
	type SnippetsSnapshot,
} from '$shared/snippets';
import { SnippetsStore } from '$lib/snippets/snippets-store.svelte.js';
import { preambleToSelectable, snippetToSelectable } from '$lib/snippets/selectable-snippet.js';
import {
	findFreshSelectableSnippetByShortName,
	inspectSelectableSnippetInCatalog,
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
		hasLoaded: true,
		hasFreshSnapshot: true,
		snippets: [makeSnippet()],
		...overrides,
	};
}

function preambleCatalog(overrides: Partial<PreambleCatalogLookup> = {}): PreambleCatalogLookup {
	return {
		hasLoaded: true,
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

	it('blocks live-store lookup while a refresh GET is in flight and resumes once settled', async () => {
		const retryRead = Promise.withResolvers<SnippetsSnapshot>();
		const snippetsStore = new SnippetsStore({
			get: vi.fn<() => Promise<SnippetsSnapshot>>().mockReturnValueOnce(retryRead.promise),
		});
		snippetsStore.applySnapshot({
			revision: 3,
			snippets: [makeSnippet({ shortName: 'probe', template: 'Old probe' })],
		});
		const preamblesStore = new SnippetsStore();
		const liveStores = {
			wsConnected: true,
			snippets: snippetsStore,
			preambles: { hasLoaded: true, hasFreshSnapshot: true, preambles: [] },
		};
		expect(preamblesStore.hasLoaded).toBe(false);

		const refreshing = snippetsStore.refresh();
		expect(findFreshSelectableSnippetByShortName('probe', liveStores)).toBeNull();

		retryRead.resolve({
			revision: 3,
			snippets: [makeSnippet({ shortName: 'probe', template: 'Updated probe' })],
		});
		await refreshing;
		expect(findFreshSelectableSnippetByShortName('probe', liveStores)).toMatchObject({
			source: 'snippet',
			body: 'Updated probe',
		});
	});
});

describe('inspectSelectableSnippetInCatalog', () => {
	it('returns unavailable when the owning catalog is absent or unloaded', () => {
		const snippet = snippetToSelectable(makeSnippet());
		const preamble = preambleToSelectable(makePreamble())!;

		expect(
			inspectSelectableSnippetInCatalog(snippet, { snippets: null, preambles: preambleCatalog() }),
		).toBe('unavailable');
		expect(
			inspectSelectableSnippetInCatalog(snippet, {
				snippets: snippetCatalog({ hasLoaded: false, hasFreshSnapshot: false }),
				preambles: preambleCatalog(),
			}),
		).toBe('unavailable');
		expect(
			inspectSelectableSnippetInCatalog(preamble, { snippets: snippetCatalog(), preambles: null }),
		).toBe('unavailable');
		expect(
			inspectSelectableSnippetInCatalog(preamble, {
				snippets: snippetCatalog(),
				preambles: preambleCatalog({ hasLoaded: false, hasFreshSnapshot: false }),
			}),
		).toBe('unavailable');
	});

	it('returns matched when fresh and unchanged, and unavailable when nonfresh but unchanged', () => {
		const snippet = snippetToSelectable(makeSnippet());
		const preamble = preambleToSelectable(makePreamble())!;

		expect(
			inspectSelectableSnippetInCatalog(snippet, {
				snippets: snippetCatalog(),
				preambles: preambleCatalog({ hasFreshSnapshot: false }),
			}),
		).toBe('matched');
		expect(
			inspectSelectableSnippetInCatalog(snippet, {
				snippets: snippetCatalog({ hasFreshSnapshot: false }),
				preambles: preambleCatalog(),
			}),
		).toBe('unavailable');
		expect(
			inspectSelectableSnippetInCatalog(preamble, {
				snippets: snippetCatalog({ hasFreshSnapshot: false }),
				preambles: preambleCatalog(),
			}),
		).toBe('matched');
		expect(
			inspectSelectableSnippetInCatalog(preamble, {
				snippets: snippetCatalog(),
				preambles: preambleCatalog({ hasFreshSnapshot: false }),
			}),
		).toBe('unavailable');
	});

	it.each([false, true])(
		'returns changed for mismatched or missing entries even when hasFreshSnapshot=%s',
		(hasFreshSnapshot) => {
			const originalSnippet = makeSnippet();
			const originalPreamble = makePreamble();
			const capturedSnippet = snippetToSelectable(originalSnippet);
			const capturedPreamble = preambleToSelectable(originalPreamble)!;

			for (const snippets of [
				snippetCatalog({ hasFreshSnapshot, snippets: [] }),
				snippetCatalog({
					hasFreshSnapshot,
					snippets: [makeSnippet({ shortName: 'renamed' })],
				}),
				snippetCatalog({
					hasFreshSnapshot,
					snippets: [makeSnippet({ updatedAt: '2026-01-02T00:00:00.000Z' })],
				}),
				snippetCatalog({
					hasFreshSnapshot,
					snippets: [makeSnippet({ template: 'Different {{arguments}}' })],
				}),
				snippetCatalog({
					hasFreshSnapshot,
					snippets: [makeSnippet({ defaultArguments: 'other defaults' })],
				}),
			]) {
				expect(
					inspectSelectableSnippetInCatalog(capturedSnippet, {
						snippets,
						preambles: preambleCatalog(),
					}),
				).toBe('changed');
			}

			for (const preambles of [
				preambleCatalog({ hasFreshSnapshot, preambles: [] }),
				preambleCatalog({
					hasFreshSnapshot,
					preambles: [makePreamble({ snippetShortName: 'other_name' })],
				}),
				preambleCatalog({
					hasFreshSnapshot,
					preambles: [makePreamble({ updatedAt: '2026-01-02T00:00:00.000Z' })],
				}),
				preambleCatalog({
					hasFreshSnapshot,
					preambles: [makePreamble({ content: 'Updated preamble content' })],
				}),
			]) {
				expect(
					inspectSelectableSnippetInCatalog(capturedPreamble, {
						snippets: snippetCatalog(),
						preambles,
					}),
				).toBe('changed');
			}
		},
	);
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
