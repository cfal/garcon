import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

import SidebarSaveFolderDialog from '../SidebarSaveFolderDialog.svelte';
import SidebarTagDialog from '../SidebarTagDialog.svelte';

describe('Sidebar dialogs', () => {
	it('includes the pending tag input when saving tags', async () => {
		const onSave = vi.fn().mockResolvedValue(undefined);

		render(SidebarTagDialog, {
			tagDialog: {
				chatId: 'chat-1',
				chatTitle: 'Folder bug hunt',
				tags: ['existing'],
			},
			allKnownTags: [],
			onClose: vi.fn(),
			onSave,
		});

		const input = screen.getByRole('textbox', { name: 'Type a tag and press Enter' });
		await fireEvent.input(input, { target: { value: 'pending-tag' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		await waitFor(() => {
			expect(onSave).toHaveBeenCalledWith('chat-1', ['existing', 'pending-tag']);
		});
	});

	it('keeps the save-folder dialog open and shows the error when folder creation fails', async () => {
		const onClose = vi.fn();
		const onSave = vi.fn().mockRejectedValue(new Error('Folder create failed'));

		render(SidebarSaveFolderDialog, {
			saveFolderDialog: {
				filter: {
					textTokens: [],
					tags: [],
					providers: [],
					models: [],
					status: 'unread',
				},
				suggestedName: 'Unread follow-up',
			},
			onClose,
			onSave,
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		await screen.findByText('Folder create failed');
		expect(screen.getByRole('dialog', { name: 'Save folder' })).toBeTruthy();
		expect(onClose).not.toHaveBeenCalled();
	});
});
