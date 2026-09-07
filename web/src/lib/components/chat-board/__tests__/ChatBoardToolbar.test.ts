import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatBoard } from '$shared/chat-boards';
import ChatBoardToolbar from '../ChatBoardToolbar.svelte';

const boards: readonly ChatBoard[] = [
	{ id: '11111111-1111-4111-8111-111111111111', name: 'Delivery', columns: [] },
	{ id: '22222222-2222-4222-8222-222222222222', name: 'By owner', columns: [] },
];

afterEach(() => cleanup());

describe('ChatBoardToolbar', () => {
	it('keeps board selection, configuration, and local density as distinct actions', async () => {
		const onSelectBoard = vi.fn();
		const onSetLayout = vi.fn();
		render(ChatBoardToolbar, {
			boards,
			selectedBoard: boards[0]!,
			itemLayout: 'compact',
			onSelectBoard,
			onEditColumns: vi.fn(),
			onCreateBoard: vi.fn(),
			onManageBoards: vi.fn(),
				onSetLayout,
			});

		expect(screen.getByRole('button', { name: 'Edit columns' }).getAttribute('title')).toBe(
			'Edit columns',
		);
		expect(screen.getByRole('button', { name: 'View' }).getAttribute('title')).toBe('View');

		await fireEvent.click(screen.getByRole('button', { name: 'Delivery' }));
		await fireEvent.click(await screen.findByRole('menuitemradio', { name: 'By owner' }));
		expect(onSelectBoard).toHaveBeenCalledWith(boards[1]!.id);

		await fireEvent.click(screen.getByRole('button', { name: 'View' }));
		await fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Detailed' }));
		await waitFor(() => expect(onSetLayout).toHaveBeenCalledWith('detailed'));
	});
});
