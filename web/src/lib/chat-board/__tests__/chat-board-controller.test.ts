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

function catalog(
	revision: number,
	boards: readonly ChatBoard[] = [first, second],
): ChatBoardCatalog {
	return { revision, boards };
}

function harness(initialCatalog = catalog(1)) {
	let selectedBoardId: string | null = null;
	let itemLayout: ChatBoardPreferencesPort['itemLayout'] = null;
	const activeColumns: Record<string, string> = {};
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

	it('stops responding after disposal', async () => {
		const test = harness();
		await test.controller.refresh(true);
		test.controller.dispose();
		test.invalidations.publish({ kind: 'catalog', revision: 2, reason: 'removed' });
		expect(test.api.load).toHaveBeenCalledOnce();
	});
});
