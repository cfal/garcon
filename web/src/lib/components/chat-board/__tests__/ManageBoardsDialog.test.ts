import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatBoard, ChatBoardCatalog } from '$shared/chat-boards';
import type { ChatBoardApi } from '$lib/api/chat-boards';
import { ChatBoardController } from '$lib/chat-board/catalog/chat-board-controller.svelte';
import { ChatBoardInvalidationHub } from '$lib/chat-board/catalog/chat-board-invalidation-hub';
import ManageBoardsDialog from '../ManageBoardsDialog.svelte';

const first: ChatBoard = {
	id: '11111111-1111-4111-8111-111111111111',
	name: 'Delivery',
	columns: [],
};
const second: ChatBoard = {
	id: '22222222-2222-4222-8222-222222222222',
	name: 'By owner',
	columns: [],
};

async function setup() {
	let current: ChatBoardCatalog = { revision: 1, boards: [first, second] };
	const api = {
		load: vi.fn(async () => current),
		create: vi.fn(),
		update: vi.fn(),
		remove: vi.fn(async (_revision: number, boardId: string) => {
			current = {
				revision: current.revision + 1,
				boards: current.boards.filter((board) => board.id !== boardId),
			};
			return { success: true as const, catalog: current };
		}),
		reorder: vi.fn(async (_revision: number, ids: readonly string[]) => {
			current = {
				revision: current.revision + 1,
				boards: ids.map((id) => current.boards.find((board) => board.id === id)!),
			};
			return { success: true as const, catalog: current };
		}),
	} satisfies ChatBoardApi;
	const controller = new ChatBoardController({
		api,
		invalidations: new ChatBoardInvalidationHub(),
		preferences: {
			get selectedBoardId() {
				return first.id;
			},
			setSelectedBoardId() {},
			get itemLayout() {
				return 'compact' as const;
			},
			setItemLayout() {},
			getActiveColumnId() {
				return null;
			},
			setActiveColumnId() {},
		},
		sidebarLayout: () => 'compact',
	});
	await controller.refresh(true);
	return { api, controller };
}

afterEach(() => cleanup());

describe('ManageBoardsDialog', () => {
	it('supports drag and button reorder through the same revisioned operation', async () => {
		const { api, controller } = await setup();
		render(ManageBoardsDialog, {
			open: true,
			controller,
			onClose: vi.fn(),
			onEditBoard: vi.fn(),
		});

		await fireEvent.click(screen.getAllByRole('button', { name: 'Move down' })[0]!);
		await waitFor(() => expect(api.reorder).toHaveBeenLastCalledWith(1, [second.id, first.id]));

		const handle = screen.getByRole('button', { name: 'Drag Delivery to reorder boards' });
		const target = document.querySelector<HTMLElement>(
			`[data-chat-board-manager-row="${second.id}"]`,
		)!;
		const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
		await fireEvent.dragStart(handle, { dataTransfer });
		await fireEvent.dragOver(target, { dataTransfer });
		await fireEvent.drop(target, { dataTransfer });
		await waitFor(() => expect(api.reorder).toHaveBeenCalledTimes(2));
	});

	it('makes deletion consequences explicit before removing only configuration', async () => {
		const { api, controller } = await setup();
		render(ManageBoardsDialog, {
			open: true,
			controller,
			onClose: vi.fn(),
			onEditBoard: vi.fn(),
		});

		await fireEvent.click(screen.getAllByRole('button', { name: 'Delete board' })[0]!);
		expect(
			screen.getByText(
				'Delete “Delivery”? This removes only the board configuration. Chats and tags will not change.',
			),
		).toBeTruthy();
		expect(api.remove).not.toHaveBeenCalled();
		await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
		await waitFor(() => expect(api.remove).toHaveBeenCalledWith(1, first.id));
	});
});
