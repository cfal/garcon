import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatBoard, ChatBoardCatalog } from '$shared/chat-boards';
import type { ChatBoardApi } from '$lib/api/chat-boards';
import { ChatBoardController } from '$lib/chat-board/catalog/chat-board-controller.svelte';
import { ChatBoardInvalidationHub } from '$lib/chat-board/catalog/chat-board-invalidation-hub';
import EditColumnsDialog from '../EditColumnsDialog.svelte';

const ready = {
	id: '22222222-2222-4222-8222-222222222222',
	name: 'Ready',
	match: 'all' as const,
	tags: ['ready'],
};
const review = {
	id: '33333333-3333-4333-8333-333333333333',
	name: 'Review',
	match: 'any' as const,
	tags: ['review', 'verify'],
};
const board: ChatBoard = {
	id: '11111111-1111-4111-8111-111111111111',
	name: 'Delivery',
	columns: [ready, review],
};

async function setup() {
	let current: ChatBoardCatalog = { revision: 1, boards: [board] };
	const api = {
		load: vi.fn(async () => current),
		create: vi.fn(),
		update: vi.fn(async (_revision: number, updated: ChatBoard) => {
			current = { revision: current.revision + 1, boards: [updated] };
			return { success: true as const, catalog: current };
		}),
		remove: vi.fn(),
		reorder: vi.fn(),
	} satisfies ChatBoardApi;
	const controller = new ChatBoardController({
		api,
		invalidations: new ChatBoardInvalidationHub(),
		preferences: {
			get selectedBoardId() {
				return board.id;
			},
			setSelectedBoardId() {},
			get itemLayout() {
				return 'compact' as const;
			},
			setItemLayout() {},
			getActiveColumnId() {
				return ready.id;
			},
			setActiveColumnId() {},
		},
		sidebarLayout: () => 'compact',
	});
	await controller.refresh(true);
	return {
		api,
		controller,
		setRemoteCatalog(next: ChatBoardCatalog) {
			current = next;
		},
	};
}

afterEach(() => cleanup());

describe('EditColumnsDialog', () => {
	it('stages drag reordering and submits the immutable opening revision atomically', async () => {
		const { api, controller } = await setup();
		const onClose = vi.fn();
		render(EditColumnsDialog, { open: true, controller, board, onClose });

		const source = screen.getByRole('button', { name: 'Drag Ready to reorder columns' });
		const target = document.querySelector<HTMLElement>(
			`[data-chat-board-column-editor="${review.id}"]`,
		)!;
		const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
		await fireEvent.dragStart(source, { dataTransfer });
		await fireEvent.dragOver(target, { dataTransfer });
		await fireEvent.drop(target, { dataTransfer });
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		await waitFor(() => expect(api.update).toHaveBeenCalledOnce());
		const [revision, submitted] = api.update.mock.calls[0]!;
		expect(revision).toBe(1);
		expect(submitted.columns.map((column) => column.id)).toEqual([review.id, ready.id]);
		expect(onClose).toHaveBeenCalledOnce();
	});

	it('keeps edits local on Cancel and requires an explicit restart after invalidation', async () => {
		const { api, controller, setRemoteCatalog } = await setup();
		const onClose = vi.fn();
		const view = render(EditColumnsDialog, { open: true, controller, board, onClose });
		await fireEvent.input(screen.getByLabelText('Board name'), {
			target: { value: 'Local draft' },
		});

		const remoteBoard = { ...board, name: 'Remote version' };
		setRemoteCatalog({ revision: 2, boards: [remoteBoard] });
		await controller.refresh(false);
		expect(
			screen.getByText('This board changed elsewhere. Review the latest version before saving.'),
		).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
		expect((screen.getByLabelText('Board name') as HTMLInputElement).value).toBe('Local draft');

		await fireEvent.click(screen.getByRole('button', { name: 'Start again from latest' }));
		expect((screen.getByLabelText('Board name') as HTMLInputElement).value).toBe('Remote version');
		expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false);

		await fireEvent.input(screen.getByLabelText('Board name'), { target: { value: 'Discard me' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(onClose).toHaveBeenCalledOnce();
		expect(api.update).not.toHaveBeenCalled();
		view.unmount();
	});
});
