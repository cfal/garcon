import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/client.js';
import { expandSnippet } from '$lib/api/snippets.js';
import {
	ComposerSnippetController,
	type ComposerSnippetControllerOptions,
} from '$lib/chat/composer/composer-snippet-controller.js';
import type { SnippetPaletteTriggerState } from '$lib/chat/composer/snippet-palette-trigger-state.svelte.js';
import {
	preambleToSelectable,
	snippetToSelectable,
} from '$lib/snippets/selectable-snippet.js';
import type { Preamble } from '$shared/preambles';
import type { ExpandSnippetResponse, Snippet } from '$shared/snippets';

vi.mock('$lib/api/snippets.js', () => ({ expandSnippet: vi.fn() }));
const mockExpandSnippet = vi.mocked(expandSnippet);

const snippet: Snippet = {
	id: 'snippet-1',
	shortName: 'review',
	template: 'Review {{arguments}} for {{chat_id}}',
	defaultArguments: 'open PRs',
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
};

const pathSnippet: Snippet = {
	...snippet,
	id: 'snippet-path',
	shortName: 'path_review',
	template: 'Review {{arguments}} in {{project_path}}',
};

const preamble: Preamble = {
	id: '00000000-0000-4000-8000-000000000001',
	enabled: false,
	title: 'Manual context',
	snippetShortName: 'ctx',
	content: 'Context {{chat_id}}',
	scope: { type: 'global' },
	agentIds: [],
	tagFilter: { mode: 'any', tags: [] },
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
};

function setup(overrides: Partial<ComposerSnippetControllerOptions<string>> = {}) {
	let text = 'Before ;;review after';
	let selection: { start: number; end: number } | null = { start: 0, end: 0 };
	let executionKey = 'local\u0000claude';
	const notifyError = vi.fn();
	const onExpanded = vi.fn();
	const onSettled = vi.fn();
	const beforeExpand = vi.fn();
	const refreshSnippets = vi.fn(async () => {});
	const refreshPreambles = vi.fn(async () => {});
	const buildServerContext = vi.fn(() => ({
		requestContext: { type: 'chat' as const, chatId: 'chat-1' },
		prepared: '/repo',
	}));
	const controller = new ComposerSnippetController<string>({
		snippets: {
			hasLoaded: true,
			snippets: [snippet, pathSnippet],
			refreshIfLoaded: refreshSnippets,
		},
		preambles: {
			hasLoaded: true,
			preambles: [preamble],
			refreshIfLoaded: refreshPreambles,
		},
		notifications: { error: notifyError },
		getExecutionKey: () => executionKey,
		isConversationInput: () => true,
		isTransformPending: () => false,
		getText: () => text,
		getSelection: () => selection,
		hasProjectPath: () => true,
		getLocalChatId: () => 'chat-1',
		buildServerContext,
		matchesServerContext: (prepared, response) =>
			prepared === '/repo' &&
			response.contextExecutorId === 'local' &&
			response.contextProjectPath === '/repo',
		beforeExpand,
		onExpanded,
		onSettled,
		...overrides,
	});
	const palette: Pick<SnippetPaletteTriggerState, 'trigger' | 'complete' | 'dismiss'> = {
		trigger: { start: 7, end: 15, query: 'review' },
		complete: vi.fn(),
		dismiss: vi.fn(),
	};
	return {
		controller,
		palette,
		notifyError,
		onExpanded,
		onSettled,
		beforeExpand,
		refreshSnippets,
		refreshPreambles,
		buildServerContext,
		setText: (next: string) => {
			text = next;
		},
		setSelection: (next: { start: number; end: number } | null) => {
			selection = next;
		},
		setExecutionKey: (next: string) => {
			executionKey = next;
		},
	};
}

beforeEach(() => {
	mockExpandSnippet.mockReset();
});

describe('ComposerSnippetController', () => {
	it('expands eligible palette snippets locally without calling expandSnippet', async () => {
		const env = setup();
		const result = await env.controller.insertFromPalette(
			env.palette,
			snippetToSelectable(snippet),
			'API',
		);

		expect(result).toBe('inserted');
		expect(mockExpandSnippet).not.toHaveBeenCalled();
		expect(env.buildServerContext).not.toHaveBeenCalled();
		expect(env.onExpanded).toHaveBeenCalledWith(
			'Before Review API for chat-1 after',
			'Before Review API for chat-1'.length,
		);
		expect(env.palette.complete).toHaveBeenCalledTimes(1);
		expect(env.palette.dismiss).not.toHaveBeenCalled();
	});

	it('expands loaded slash invocations locally and preserves omitted vs empty arguments', async () => {
		const env = setup();
		env.setText('/s review');
		await env.controller.expandInvocation({
			kind: 'valid',
			shortName: 'review',
			arguments: { type: 'default' },
		});
		expect(env.onExpanded).toHaveBeenLastCalledWith(
			'Review open PRs for chat-1',
			'Review open PRs for chat-1'.length,
		);

		env.setText('/s review ');
		await env.controller.expandInvocation({
			kind: 'valid',
			shortName: 'review',
			arguments: { type: 'value', value: '' },
		});
		expect(env.onExpanded).toHaveBeenLastCalledWith(
			'Review  for chat-1',
			'Review  for chat-1'.length,
		);

		env.setText('/s ctx');
		await env.controller.expandInvocation({
			kind: 'valid',
			shortName: 'ctx',
			arguments: { type: 'default' },
		});
		expect(env.onExpanded).toHaveBeenLastCalledWith('Context chat-1', 'Context chat-1'.length);
		expect(mockExpandSnippet).not.toHaveBeenCalled();
	});

	it('falls back to server expansion for project_path snippets and unknown slash names', async () => {
		const env = setup();
		mockExpandSnippet.mockResolvedValueOnce({
			success: true,
			source: 'snippet',
			sourceId: pathSnippet.id,
			sourceUpdatedAt: pathSnippet.updatedAt,
			shortName: pathSnippet.shortName,
			contextExecutorId: 'local',
			contextProjectPath: '/repo',
			expandedText: 'Review docs in /repo',
		});

		const paletteResult = await env.controller.insertFromPalette(
			env.palette,
			snippetToSelectable(pathSnippet),
			'docs',
		);
		expect(paletteResult).toBe('inserted');
		expect(mockExpandSnippet).toHaveBeenCalledTimes(1);
		expect(env.onExpanded).toHaveBeenLastCalledWith(
			'Before Review docs in /repo after',
			'Before Review docs in /repo'.length,
		);

		env.setText('/s unknown_on_client');
		mockExpandSnippet.mockResolvedValueOnce({
			success: true,
			source: 'snippet',
			sourceId: 'server-only',
			sourceUpdatedAt: '2026-01-01T00:00:00.000Z',
			shortName: 'unknown_on_client',
			contextExecutorId: 'local',
			contextProjectPath: '/repo',
			expandedText: 'Expanded from server',
		});
		await env.controller.expandInvocation({
			kind: 'valid',
			shortName: 'unknown_on_client',
			arguments: { type: 'default' },
		});
		expect(mockExpandSnippet).toHaveBeenCalledTimes(2);
		expect(env.onExpanded).toHaveBeenLastCalledWith(
			'Expanded from server',
			'Expanded from server'.length,
		);
	});

	it('refreshes both affected catalogs when a palette server fallback returns another source', async () => {
		const datePreamble = { ...preamble, content: 'Today {{current_date}}' };
		const refreshPreambles = vi.fn(async () => {});
		const env = setup({
			preambles: {
				hasLoaded: true,
				preambles: [datePreamble],
				refreshIfLoaded: refreshPreambles,
			},
		});
		const selectablePreamble = preambleToSelectable(datePreamble)!;
		mockExpandSnippet.mockResolvedValueOnce({
			success: true,
			source: 'snippet',
			sourceId: 'moved-to-snippet',
			sourceUpdatedAt: '2026-01-02T00:00:00.000Z',
			shortName: selectablePreamble.shortName,
			contextExecutorId: 'local',
			contextProjectPath: '/repo',
			expandedText: 'should not apply',
		});

		const result = await env.controller.insertFromPalette(env.palette, selectablePreamble, '');
		expect(result).toBe('cancelled');
		expect(refreshPreambles).toHaveBeenCalledTimes(1);
		expect(env.refreshSnippets).toHaveBeenCalledTimes(1);
		expect(env.notifyError).toHaveBeenCalled();
		expect(env.onExpanded).not.toHaveBeenCalled();
		expect(env.palette.dismiss).toHaveBeenCalledTimes(1);
	});

	it('keeps arguments dialog open on local validation failure and refreshes on 404', async () => {
		const env = setup();
		const failResult = await env.controller.insertFromPalette(
			env.palette,
			snippetToSelectable(snippet),
			'x'.repeat(32_001),
		);
		expect(failResult).toBe('failed');
		expect(env.palette.dismiss).not.toHaveBeenCalled();
		expect(env.palette.complete).not.toHaveBeenCalled();
		expect(env.notifyError).toHaveBeenCalledTimes(1);

		mockExpandSnippet.mockRejectedValueOnce(new ApiError(404, 'Not found'));
		await env.controller.expandInvocation({
			kind: 'valid',
			shortName: 'missing',
			arguments: { type: 'default' },
		});
		expect(env.refreshSnippets).toHaveBeenCalledTimes(1);
		expect(env.refreshPreambles).toHaveBeenCalledTimes(1);
	});

	it('discards stale server fallback results when text or execution key changes in flight', async () => {
		const env = setup();
		let resolve!: (value: ExpandSnippetResponse) => void;
		mockExpandSnippet.mockReturnValueOnce(new Promise((done) => (resolve = done)));

		const running = env.controller.insertFromPalette(
			env.palette,
			snippetToSelectable(pathSnippet),
			'docs',
		);
		env.setText('Edited in flight');
		resolve({
			success: true,
			source: 'snippet',
			sourceId: pathSnippet.id,
			sourceUpdatedAt: pathSnippet.updatedAt,
			shortName: pathSnippet.shortName,
			contextExecutorId: 'local',
			contextProjectPath: '/repo',
			expandedText: 'stale expansion',
		});

		expect(await running).toBe('cancelled');
		expect(env.onExpanded).not.toHaveBeenCalled();
	});

	it('handles missing project path with optional callback', async () => {
		const onMissingProjectPath = vi.fn();
		const env = setup({ hasProjectPath: () => false, onMissingProjectPath });

		expect(
			await env.controller.insertFromPalette(
				env.palette,
				snippetToSelectable(snippet),
				'API',
			),
		).toBe('cancelled');
		expect(onMissingProjectPath).toHaveBeenCalledTimes(1);
		expect(env.onSettled).toHaveBeenCalledTimes(1);
		expect(mockExpandSnippet).not.toHaveBeenCalled();
	});

	it('dismisses the palette when insertion cancels early before execution', async () => {
		const pendingEnv = setup({ isTransformPending: () => true });
		expect(
			await pendingEnv.controller.insertFromPalette(
				pendingEnv.palette,
				snippetToSelectable(snippet),
				'API',
			),
		).toBe('cancelled');
		expect(pendingEnv.palette.dismiss).toHaveBeenCalledTimes(1);
		expect(pendingEnv.palette.complete).not.toHaveBeenCalled();
		expect(pendingEnv.beforeExpand).not.toHaveBeenCalled();
		expect(pendingEnv.onExpanded).not.toHaveBeenCalled();

		const detachedEnv = setup({ getSelection: () => null });
		expect(
			await detachedEnv.controller.insertFromPalette(
				detachedEnv.palette,
				snippetToSelectable(snippet),
				'API',
			),
		).toBe('cancelled');
		expect(detachedEnv.palette.dismiss).toHaveBeenCalledTimes(1);
		expect(detachedEnv.beforeExpand).not.toHaveBeenCalled();
	});

	it('cancels palette insertion without expanding when the loaded catalog changed or removed the item', async () => {
		let loadedSnippets: Snippet[] = [snippet];
		const env = setup({
			snippets: {
				hasLoaded: true,
				get snippets() {
					return loadedSnippets;
				},
				refreshIfLoaded: vi.fn(async () => {}),
			},
		});
		const selected = snippetToSelectable(snippet);
		loadedSnippets = [{ ...snippet, template: 'Changed {{arguments}}', updatedAt: '2026-01-02T00:00:00.000Z' }];

		expect(await env.controller.insertFromPalette(env.palette, selected, 'API')).toBe('cancelled');
		expect(mockExpandSnippet).not.toHaveBeenCalled();
		expect(env.onExpanded).not.toHaveBeenCalled();
		expect(env.notifyError).toHaveBeenCalledWith('That snippet changed. Select it again.');
		expect(env.palette.dismiss).toHaveBeenCalledTimes(1);

		loadedSnippets = [];
		expect(await env.controller.insertFromPalette(env.palette, selected, 'API')).toBe('cancelled');
		expect(mockExpandSnippet).not.toHaveBeenCalled();
		expect(env.onExpanded).not.toHaveBeenCalled();
	});
});
