import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ScheduledPromptSnippets } from '../scheduled-prompt-snippets.svelte';
import { expandSnippet } from '$lib/api/snippets.js';
import {
	preambleToSelectable,
	snippetToSelectable,
	type SelectableSnippet,
} from '$lib/snippets/selectable-snippet.js';
import { catalogMatchesSelectableSnippet } from '$lib/snippets/local-snippet-expansion.js';
import { SnippetsStore } from '$lib/snippets/snippets-store.svelte.js';

vi.mock('$lib/api/snippets.js', () => ({ expandSnippet: vi.fn() }));
const expand = vi.mocked(expandSnippet);
const item = snippetToSelectable({
	id: 'review',
	shortName: 'review',
	template: 'Review {{arguments}} in {{project_path}} {{chat_id}}',
	defaultArguments: 'API',
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
});
const localItem = snippetToSelectable({
	id: 'daily',
	shortName: 'daily',
	template: 'Review {{arguments}} for {{chat_id}} on {{current_date}} / {{current_date_local}}',
	defaultArguments: 'API',
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
});
const preambleItem = preambleToSelectable({
	id: '00000000-0000-4000-8000-000000000001',
	enabled: true,
	title: 'Daily context',
	snippetShortName: 'context',
	content: 'Chat {{chat_id}} on {{current_date}} / {{current_date_local}}',
	scope: { type: 'global' },
	agentIds: [],
	tagFilter: { mode: 'any', tags: [] },
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
})!;
const boundaryItem = snippetToSelectable({
	id: 'boundary',
	shortName: 'boundary',
	template: '{{arguments}}{{current_date}}',
	defaultArguments: '',
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
});
const response = {
	success: true as const,
	source: 'snippet' as const,
	sourceId: 'review',
	sourceUpdatedAt: item.updatedAt,
	shortName: 'review',
	contextProjectPath: '/repo',
	contextExecutorId: 'local',
	expandedText: 'Review API in /repo {{chat_id}}',
};

function fixture(
	options: {
		matchesCatalogItem?: (item: SelectableSnippet) => boolean;
		onInsert?: (text: string, caret: number) => Promise<void>;
	} = {},
) {
	const input = { prompt: 'Before selected after', key: 'new-chat:/repo' };
	const onInsert = vi.fn(options.onInsert ?? (async (_text: string, _caret: number) => {}));
	const onPendingChange = vi.fn();
	const onSourceChanged = vi.fn();
	const controller = new ScheduledPromptSnippets({
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
		...(options.matchesCatalogItem ? { matchesCatalogItem: options.matchesCatalogItem } : {}),
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
	it('replaces the selection and supplies the caret while blocking save during expansion', async () => {
		const { controller, onInsert, onPendingChange } = fixture({ matchesCatalogItem: () => true });
		controller.open(7, 15);
		expect(await controller.insert(item, 'API')).toBe('inserted');
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

	it('expands scheduled snippets without project_path locally without hitting the server', async () => {
		const { controller, onInsert, onPendingChange } = fixture({ matchesCatalogItem: () => true });
		controller.open(7, 15);
		expect(await controller.insert(localItem, '{{chat_id}}')).toBe('inserted');
		expect(expand).not.toHaveBeenCalled();
		expect(onPendingChange).not.toHaveBeenCalled();
		expect(onInsert).toHaveBeenCalledWith(
			'Before Review \\{{chat_id}} for {{chat_id}} on {{current_date}} / {{current_date_local}} after',
			'Before Review \\{{chat_id}} for {{chat_id}} on {{current_date}} / {{current_date_local}}'.length,
		);
	});

	it('inserts named preambles verbatim locally in scheduled prompts', async () => {
		const { controller, onInsert, onPendingChange } = fixture({ matchesCatalogItem: () => true });
		controller.open(7, 15);
		expect(await controller.insert(preambleItem, '')).toBe('inserted');
		expect(expand).not.toHaveBeenCalled();
		expect(onPendingChange).not.toHaveBeenCalled();
		expect(onInsert).toHaveBeenCalledWith(
			'Before Chat {{chat_id}} on {{current_date}} / {{current_date_local}} after',
			'Before Chat {{chat_id}} on {{current_date}} / {{current_date_local}}'.length,
		);
	});

	it('falls back to the server when the captured selection no longer matches the catalog after a restore', async () => {
		const store = new SnippetsStore({
			get: vi
				.fn()
				.mockResolvedValueOnce({ revision: 2, snippets: [] })
				.mockResolvedValueOnce({
					revision: 3,
					snippets: [
						{
							...localItem.snippet,
							template: 'Restored {{arguments}}',
							updatedAt: '2026-01-02T00:00:00.000Z',
						},
					],
				}),
		});
		store.applySnapshot({ revision: 3, snippets: [localItem.snippet] });
		const capturedItem = snippetToSelectable(store.snippets[0]!);
		const { controller, onInsert } = fixture({
			matchesCatalogItem: (selected) => catalogMatchesSelectableSnippet(selected, store),
		});

		await store.refreshIfLoaded();
		await store.refreshIfLoaded();
		expect(store.hasFreshSnapshot).toBe(true);

		expand.mockResolvedValueOnce({
			...response,
			sourceId: capturedItem.id,
			sourceUpdatedAt: '2026-01-02T00:00:00.000Z',
			shortName: capturedItem.shortName,
			expandedText: 'Restored API',
		});
		controller.open(7, 15);
		expect(await controller.insert(capturedItem, 'API')).toBe('cancelled');
		expect(expand).toHaveBeenCalledOnce();
		expect(onInsert).not.toHaveBeenCalled();
		expect(controller.error).toContain('changed');
	});

	it('rejects ambiguous deferred token boundaries locally without calling the server', async () => {
		const { controller, onInsert, onPendingChange } = fixture({ matchesCatalogItem: () => true });
		controller.open(7, 15);
		expect(await controller.insert(boundaryItem, 'report\\')).toBe('failed');
		expect(expand).not.toHaveBeenCalled();
		expect(onPendingChange).not.toHaveBeenCalled();
		expect(onInsert).not.toHaveBeenCalled();
		expect(controller.error).toContain('Add a separator');
	});

	it('falls back to the server when no catalog matcher is provided', async () => {
		const { controller, onInsert } = fixture();
		expand.mockResolvedValueOnce({
			...response,
			sourceId: localItem.id,
			sourceUpdatedAt: localItem.updatedAt,
			shortName: localItem.shortName,
			expandedText: 'Server expanded',
		});
		controller.open(7, 15);
		expect(await controller.insert(localItem, 'API')).toBe('inserted');
		expect(expand).toHaveBeenCalledOnce();
		expect(onInsert).toHaveBeenCalledWith(
			'Before Server expanded after',
			'Before Server expanded'.length,
		);
	});

	it('catches unexpected errors thrown during local insertion without toggling pending state', async () => {
		const { controller, onPendingChange } = fixture({
			matchesCatalogItem: () => true,
			onInsert: async () => {
				throw new Error('insert callback failed');
			},
		});
		controller.open(7, 15);
		expect(await controller.insert(localItem, 'API')).toBe('failed');
		expect(controller.error).toBe('insert callback failed');
		expect(onPendingChange).not.toHaveBeenCalled();
	});

	it('replaces the configured inline trigger while preserving surrounding prose', async () => {
		const { input, controller, onInsert } = fixture();
		input.prompt = 'Before ;;review after';
		controller.detectTrigger(15, ';;');
		expect(controller.palette.isOpen).toBe(true);
		expect(controller.palette.initialQuery).toBe('review');
		expect(await controller.insert(item, '')).toBe('inserted');
		expect(onInsert.mock.calls[0][0]).toBe('Before Review API in /repo {{chat_id}} after');
	});

	it('detects input before its parent prompt prop updates', async () => {
		const { input, controller, onInsert } = fixture();
		input.prompt = 'Before ; after';
		controller.detectTrigger(9, ';;', 'Before ;; after');
		expect(controller.palette.isOpen).toBe(true);
		expect(controller.palette.initialQuery).toBe('');
		input.prompt = 'Before ;; after';
		expect(await controller.insert(item, '')).toBe('inserted');
		expect(onInsert.mock.calls[0][0]).toBe('Before Review API in /repo {{chat_id}} after');
	});

	it.each(['edit', 'target', 'close'])('discards a delayed response after %s', async (change) => {
		const { input, controller, onInsert } = fixture();
		let resolve!: (value: typeof response) => void;
		expand.mockImplementation(() => new Promise((done) => (resolve = done)));
		controller.open(7, 15);
		const pending = controller.insert(item, 'API');
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
		expect(await controller.insert(item, '')).toBe('failed');
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
		expect(await controller.insert(item, '')).toBe('cancelled');
		expect(controller.error).toContain('changed');
		expect(onSourceChanged.mock.calls).toEqual(
			'source' in changed ? [['snippet'], ['preamble']] : [['snippet']],
		);
		expect(onInsert).not.toHaveBeenCalled();
	});
});
