import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ScheduledPromptSnippets } from '../scheduled-prompt-snippets.svelte';
import { expandSnippet } from '$lib/api/snippets.js';
import type { SnippetCatalogLookups } from '$lib/snippets/local-snippet-expansion.js';
import { preambleToSelectable, snippetToSelectable } from '$lib/snippets/selectable-snippet.js';
import type { Preamble } from '$shared/preambles';

vi.mock('$lib/api/snippets.js', () => ({ expandSnippet: vi.fn() }));
const expand = vi.mocked(expandSnippet);
const serverItem = snippetToSelectable({
	id: 'review',
	shortName: 'review',
	template: 'Review {{arguments}} in {{project_path}} {{chat_id}}',
	defaultArguments: 'API',
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
});
const localItem = snippetToSelectable({
	id: 'review-local',
	shortName: 'review-local',
	template: 'Review {{arguments}} on {{current_date}} for {{chat_id}}',
	defaultArguments: 'API',
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
});
const localPreamble = preambleToSelectable({
	id: '00000000-0000-4000-8000-000000000001',
	enabled: false,
	title: 'Manual',
	snippetShortName: 'manual',
	content: 'Preamble {{chat_id}} {{project_path}} {{current_date}}',
	scope: { type: 'global' },
	agentIds: [],
	tagFilter: { mode: 'any', tags: [] },
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
})!;
const response = {
	success: true as const,
	source: 'snippet' as const,
	sourceId: 'review',
	sourceUpdatedAt: serverItem.updatedAt,
	shortName: 'review',
	contextProjectPath: '/repo',
	contextExecutorId: 'local',
	expandedText: 'Review API in /repo {{chat_id}}',
};

function fixture(catalogs: SnippetCatalogLookups = {}) {
	const input = { prompt: 'Before selected after', key: 'new-chat:/repo' };
	const onInsert = vi.fn(async (_text: string, _caret: number) => {});
	const onPendingChange = vi.fn();
	const onSourceChanged = vi.fn();
	const controller = new ScheduledPromptSnippets({
		...catalogs,
		get prompt() {
			return input.prompt;
		},
		get interactionKey() {
			return input.key;
		},
		get context() {
			return {
				type: 'scheduled-prompt' as const,
				target: { type: 'new-chat' as const, projectPath: '/repo' },
			};
		},
		onInsert,
		onPendingChange,
		onSourceChanged,
	});
	return { input, controller, onInsert, onPendingChange, onSourceChanged };
}

beforeEach(() => {
	expand.mockReset();
	expand.mockResolvedValue(response);
});

describe('scheduled prompt snippets', () => {
	it('expands non-project_path snippets and named preambles locally without pending toggles', async () => {
		const { controller, onInsert, onPendingChange } = fixture();
		controller.open(7, 15);
		expect(await controller.insert(localItem, 'API')).toBe('inserted');
		expect(onInsert).toHaveBeenCalledWith(
			'Before Review API on {{current_date}} for {{chat_id}} after',
			'Before Review API on {{current_date}} for {{chat_id}}'.length,
		);
		expect(await controller.insert(localPreamble, '')).toBe('inserted');
		expect(expand).not.toHaveBeenCalled();
		expect(onPendingChange).not.toHaveBeenCalled();
	});

	it('surfaces local scheduled boundary errors without calling expandSnippet', async () => {
		const { controller, onInsert, onPendingChange } = fixture();
		const boundaryItem = snippetToSelectable({
			id: 'boundary',
			shortName: 'boundary',
			template: 'Run {{arguments}}{{chat_id}}',
			defaultArguments: 'API',
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		});
		controller.open(7, 15);
		expect(await controller.insert(boundaryItem, 'x\\')).toBe('failed');
		expect(controller.error).toContain('Add a separator');
		expect(expand).not.toHaveBeenCalled();
		expect(onPendingChange).not.toHaveBeenCalled();
		expect(onInsert).not.toHaveBeenCalled();
	});

	it('replaces the selection and supplies the caret while blocking save during server expansion', async () => {
		const { controller, onInsert, onPendingChange } = fixture();
		controller.open(7, 15);
		expect(await controller.insert(serverItem, 'API')).toBe('inserted');
		expect(expand.mock.calls[0][0]).toEqual({
			shortName: 'review',
			arguments: { type: 'value', value: 'API' },
			context: { type: 'scheduled-prompt', target: { type: 'new-chat', projectPath: '/repo' } },
		});
		expect(onInsert).toHaveBeenCalledWith(
			'Before Review API in /repo {{chat_id}} after',
			'Before Review API in /repo {{chat_id}}'.length,
		);
		expect(onPendingChange.mock.calls).toEqual([[true], [false]]);
	});

	it('replaces the configured inline trigger while preserving surrounding prose', async () => {
		const { input, controller, onInsert } = fixture();
		input.prompt = 'Before ;;review after';
		controller.detectTrigger(15, ';;');
		expect(controller.palette.isOpen).toBe(true);
		expect(controller.palette.initialQuery).toBe('review');
		expect(await controller.insert(serverItem, '')).toBe('inserted');
		expect(onInsert.mock.calls[0][0]).toBe('Before Review API in /repo {{chat_id}} after');
	});

	it('detects input before its parent prompt prop updates', async () => {
		const { input, controller, onInsert } = fixture();
		input.prompt = 'Before ; after';
		controller.detectTrigger(9, ';;', 'Before ;; after');
		expect(controller.palette.isOpen).toBe(true);
		expect(controller.palette.initialQuery).toBe('');
		input.prompt = 'Before ;; after';
		expect(await controller.insert(serverItem, '')).toBe('inserted');
		expect(onInsert.mock.calls[0][0]).toBe('Before Review API in /repo {{chat_id}} after');
	});

	it.each(['edit', 'target', 'close'])('discards a delayed response after %s', async (change) => {
		const { input, controller, onInsert } = fixture();
		let resolve!: (value: typeof response) => void;
		expand.mockImplementation(() => new Promise((done) => (resolve = done)));
		controller.open(7, 15);
		const pending = controller.insert(serverItem, 'API');
		if (change === 'edit') input.prompt = 'Edited';
		if (change === 'target') input.key = 'chat:other';
		if (change === 'close') controller.cancel();
		resolve(response);
		expect(await pending).toBe('cancelled');
		expect(onInsert).not.toHaveBeenCalled();
	});

	it('keeps text intact and exposes retryable expansion failures', async () => {
		const { controller, onInsert, onSourceChanged } = fixture();
		expand.mockRejectedValueOnce(new Error('Path unavailable'));
		expect(await controller.insert(serverItem, '')).toBe('failed');
		expect(controller.error).toBe('Path unavailable');
		expect(onInsert).not.toHaveBeenCalled();
		expect(onSourceChanged).not.toHaveBeenCalled();
	});

	it.each([
		{ sourceUpdatedAt: '2026-01-02T00:00:00.000Z' },
		{ sourceId: 'replacement' },
		{ source: 'preamble' as const },
	])('cancels stale identity and refreshes affected catalogs: %j', async (changed) => {
		const { controller, onInsert, onSourceChanged } = fixture();
		expand.mockResolvedValueOnce({ ...response, ...changed });
		expect(await controller.insert(serverItem, '')).toBe('cancelled');
		expect(controller.error).toContain('changed');
		expect(onSourceChanged.mock.calls).toEqual(
			'source' in changed ? [['snippet'], ['preamble']] : [['snippet']],
		);
		expect(onInsert).not.toHaveBeenCalled();
	});

	it('cancels stale selections locally when the loaded catalog no longer matches', async () => {
		let currentSnippets = [localItem.snippet];
		const { controller, onInsert } = fixture({
			snippets: {
				hasLoaded: true,
				get snippets() {
					return currentSnippets;
				},
			},
			preambles: { hasLoaded: true, preambles: [] },
		});
		controller.open(7, 15);
		currentSnippets = [];

		expect(await controller.insert(localItem, 'API')).toBe('cancelled');
		expect(controller.error).toContain('changed');
		expect(expand).not.toHaveBeenCalled();
		expect(onInsert).not.toHaveBeenCalled();
	});

	it('cancels a delayed server fallback if the loaded catalog updates or deletes the snippet in flight', async () => {
		for (const mutation of ['updated', 'deleted'] as const) {
			let currentSnippets = [serverItem.snippet];
			const { controller, onInsert } = fixture({
				snippets: {
					hasLoaded: true,
					get snippets() {
						return currentSnippets;
					},
				},
				preambles: { hasLoaded: true, preambles: [] },
			});
			let resolve!: (value: typeof response) => void;
			expand.mockImplementationOnce(() => new Promise((done) => (resolve = done)));
			controller.open(7, 15);
			const pending = controller.insert(serverItem, 'API');
			currentSnippets =
				mutation === 'updated'
					? [{ ...serverItem.snippet, updatedAt: '2026-01-03T00:00:00.000Z' }]
					: [];
			resolve(response);

			expect(await pending).toBe('cancelled');
			expect(controller.error).toContain('changed');
			expect(onInsert).not.toHaveBeenCalled();
		}
	});

	it('cancels held palette insertion when the owning catalog becomes invalidated', async () => {
		let snippetsLoaded = true;
		const { controller, onInsert } = fixture({
			snippets: {
				get hasLoaded() {
					return snippetsLoaded;
				},
				get snippets() {
					return snippetsLoaded ? [localItem.snippet] : [];
				},
			},
			preambles: { hasLoaded: true, preambles: [] },
		});
		controller.open(7, 15);
		snippetsLoaded = false;

		expect(await controller.insert(localItem, 'API')).toBe('cancelled');
		expect(controller.error).toContain('changed');
		expect(expand).not.toHaveBeenCalled();
		expect(onInsert).not.toHaveBeenCalled();
	});

	it('cancels palette insertion and reconciles both catalogs on cross-catalog short-name conflict', async () => {
		const conflictingPreamble: Preamble = {
			id: '00000000-0000-4000-8000-000000000077',
			enabled: false,
			title: 'Conflicting',
			snippetShortName: localItem.shortName,
			content: 'New preamble content',
			scope: { type: 'global' },
			agentIds: [],
			tagFilter: { mode: 'any', tags: [] },
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		};
		const { controller, onInsert, onSourceChanged } = fixture({
			snippets: { hasLoaded: true, snippets: [localItem.snippet] },
			preambles: { hasLoaded: true, preambles: [conflictingPreamble] },
		});

		for (const candidate of [
			localItem,
			preambleToSelectable(conflictingPreamble)!,
		]) {
			onSourceChanged.mockClear();
			controller.open(7, 15);
			expect(await controller.insert(candidate, 'API')).toBe('cancelled');
			expect(controller.error).toContain('changed');
			expect(onSourceChanged).toHaveBeenCalledWith('snippet');
			expect(onSourceChanged).toHaveBeenCalledWith('preamble');
			expect(expand).not.toHaveBeenCalled();
			expect(onInsert).not.toHaveBeenCalled();
		}
	});

	it('reconciles both catalogs before same-source mismatch when an ambiguous preamble arrives in flight', async () => {
		let currentPreambles: Preamble[] = [];
		const { controller, onInsert, onSourceChanged } = fixture({
			snippets: { hasLoaded: true, snippets: [serverItem.snippet] },
			preambles: {
				hasLoaded: true,
				get preambles() {
					return currentPreambles;
				},
			},
		});
		let resolve!: (value: typeof response) => void;
		expand.mockImplementationOnce(() => new Promise((done) => (resolve = done)));
		controller.open(7, 15);
		const pending = controller.insert(serverItem, 'API');
		currentPreambles = [
			{
				id: '00000000-0000-4000-8000-000000000088',
				enabled: false,
				title: 'Conflicting',
				snippetShortName: serverItem.shortName,
				content: 'New preamble content',
				scope: { type: 'global' },
				agentIds: [],
				tagFilter: { mode: 'any', tags: [] },
				createdAt: '2026-01-01T00:00:00.000Z',
				updatedAt: '2026-01-01T00:00:00.000Z',
			},
		];
		resolve({
			...response,
			source: 'snippet',
			sourceId: serverItem.id,
			sourceUpdatedAt: '2026-01-02T00:00:00.000Z',
		});

		expect(await pending).toBe('cancelled');
		expect(controller.error).toContain('changed');
		expect(onInsert).not.toHaveBeenCalled();
		expect(onSourceChanged).toHaveBeenCalledWith('snippet');
		expect(onSourceChanged).toHaveBeenCalledWith('preamble');
	});
});
