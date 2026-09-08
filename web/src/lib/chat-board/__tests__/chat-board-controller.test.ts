import { describe, expect, it, vi } from 'vitest';
import type { ChatBoard, ChatBoardCatalog } from '$shared/chat-boards';
import type { ChatBoardApi } from '$lib/api/chat-boards';
import {
	ChatBoardController,
	type ChatBoardPreferencesPort,
} from '../catalog/chat-board-controller.svelte';
import { ChatBoardInvalidationHub } from '../catalog/chat-board-invalidation-hub';

const first: ChatBoard = {
	id: '11111111-1111-4111-8111-111111111111',
	name: 'First',
	columns: [
		{ id: '22222222-2222-4222-8222-222222222222', name: 'Ready', match: 'all', tags: ['ready'] },
	],
};
const second: ChatBoard = {
	id: '33333333-3333-4333-8333-333333333333',
	name: 'Second',
	columns: [],
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function catalog(
	revision: number,
	boards: readonly ChatBoard[] = [first, second],
): ChatBoardCatalog {
	return { revision, boards };
}

function harness(initialCatalog = catalog(1), initialActiveColumns: Record<string, string> = {}) {
	let selectedBoardId: string | null = null;
	let itemLayout: ChatBoardPreferencesPort['itemLayout'] = null;
	const activeColumns = { ...initialActiveColumns };
	const preferences: ChatBoardPreferencesPort = {
		get selectedBoardId() {
			return selectedBoardId;
		},
		setSelectedBoardId(value) {
			selectedBoardId = value;
		},
		get itemLayout() {
			return itemLayout;
		},
		setItemLayout(value) {
			itemLayout = value;
		},
		getActiveColumnId(boardId) {
			return activeColumns[boardId] ?? null;
		},
		setActiveColumnId(boardId, columnId) {
			activeColumns[boardId] = columnId;
		},
		pruneActiveColumns(boards) {
			const columnsByBoardId = new Map(
				boards.map((board) => [board.id, new Set(board.columns.map((column) => column.id))]),
			);
			for (const [boardId, columnId] of Object.entries(activeColumns)) {
				if (!columnsByBoardId.get(boardId)?.has(columnId)) delete activeColumns[boardId];
			}
		},
	};
	const api = {
		load: vi.fn(async () => initialCatalog),
		create: vi.fn(),
		update: vi.fn(),
		remove: vi.fn(),
		reorder: vi.fn(),
	} satisfies ChatBoardApi;
	const invalidations = new ChatBoardInvalidationHub();
	const controller = new ChatBoardController({
		api,
		invalidations,
		preferences,
		sidebarLayout: () => 'compact',
	});
	return {
		controller,
		api,
		invalidations,
		get selectedBoardId() {
			return selectedBoardId;
		},
		get itemLayout() {
			return itemLayout;
		},
		get activeColumns() {
			return { ...activeColumns };
		},
		setActiveColumnPreference(boardId: string, columnId: string) {
			activeColumns[boardId] = columnId;
		},
	};
}

describe('ChatBoardController', () => {
	it('loads lazily on workspace visibility and inherits sidebar density once', async () => {
		const test = harness();
		expect(test.api.load).not.toHaveBeenCalled();
		test.controller.setPresentationVisible(true);
		await test.controller.refresh();

		expect(test.controller.status).toBe('ready');
		expect(test.controller.selectedBoard?.id).toBe(first.id);
		expect(test.selectedBoardId).toBe(first.id);
		expect(test.itemLayout).toBe('compact');

		test.controller.setItemLayout('detailed');
		test.controller.setPresentationVisible(false);
		test.controller.setPresentationVisible(true);
		expect(test.controller.itemLayout).toBe('detailed');
	});

	it('retains a ready catalog when a background refresh fails', async () => {
		const test = harness();
		await test.controller.refresh(true);
		test.api.load.mockRejectedValueOnce(new Error('offline'));
		await test.controller.refresh(false);

		expect(test.controller.status).toBe('ready');
		expect(test.controller.catalog.revision).toBe(1);
		expect(test.controller.error).toBe('offline');
	});

	it('repairs a remotely deleted selection to next then previous board', async () => {
		const test = harness(catalog(1, [first, second]));
		await test.controller.refresh(true);
		test.controller.selectBoard(first.id);
		test.api.load.mockResolvedValueOnce(catalog(2, [second]));
		await test.controller.refresh(false);
		expect(test.selectedBoardId).toBe(second.id);

		test.api.load.mockResolvedValueOnce(catalog(3, []));
		await test.controller.refresh(false);
		expect(test.selectedBoardId).toBeNull();
	});

	it('prunes active-column preferences when boards or columns disappear', async () => {
		const removedBoardId = '44444444-4444-4444-8444-444444444444';
		const removedColumnId = '55555555-5555-4555-8555-555555555555';
		const test = harness(catalog(1), {
			[first.id]: first.columns[0]!.id,
			[second.id]: removedColumnId,
			[removedBoardId]: removedColumnId,
		});

		await test.controller.refresh(true);

		expect(test.activeColumns).toEqual({ [first.id]: first.columns[0]!.id });
	});

	it('refreshes a visible loaded controller after catalog invalidation and reconnect', async () => {
		const test = harness();
		test.controller.setPresentationVisible(true);
		await vi.waitFor(() => expect(test.controller.status).toBe('ready'));
		test.api.load.mockResolvedValueOnce(catalog(2));
		test.invalidations.publish({ kind: 'catalog', revision: 2, reason: 'updated' });
		await vi.waitFor(() => expect(test.controller.catalog.revision).toBe(2));
		test.invalidations.publishReconnect();
		await vi.waitFor(() => expect(test.api.load).toHaveBeenCalledTimes(3));
	});

	it('fetches again when an invalidation response is older than the announced revision', async () => {
		const test = harness();
		test.controller.setPresentationVisible(true);
		await vi.waitFor(() => expect(test.controller.status).toBe('ready'));
		test.api.load.mockResolvedValueOnce(catalog(1)).mockResolvedValueOnce(catalog(2));

		test.invalidations.publish({ kind: 'catalog', revision: 2, reason: 'updated' });

		await vi.waitFor(() => expect(test.controller.catalog.revision).toBe(2));
		expect(test.api.load).toHaveBeenCalledTimes(3);
	});

	it('does not prune a newer cross-tab selection with an in-flight stale catalog', async () => {
		const addedColumn = {
			id: '66666666-6666-4666-8666-666666666666',
			name: 'Review',
			match: 'all' as const,
			tags: ['review'],
		};
		const updatedFirst = { ...first, columns: [...first.columns, addedColumn] };
		const staleResponse = deferred<ChatBoardCatalog>();
		const test = harness();
		test.api.load
			.mockImplementationOnce(() => staleResponse.promise)
			.mockResolvedValueOnce(catalog(2, [updatedFirst, second]));

		test.controller.setPresentationVisible(true);
		test.invalidations.publish({ kind: 'catalog', revision: 2, reason: 'updated' });
		test.setActiveColumnPreference(first.id, addedColumn.id);
		staleResponse.resolve(catalog(1));

		await vi.waitFor(() => expect(test.controller.catalog.revision).toBe(2));
		expect(test.activeColumns[first.id]).toBe(addedColumn.id);
		expect(test.controller.activeColumnId).toBe(addedColumn.id);
	});

	it('stops responding after disposal', async () => {
		const test = harness();
		await test.controller.refresh(true);
		test.controller.dispose();
		test.invalidations.publish({ kind: 'catalog', revision: 2, reason: 'removed' });
		expect(test.api.load).toHaveBeenCalledOnce();
	});
});
