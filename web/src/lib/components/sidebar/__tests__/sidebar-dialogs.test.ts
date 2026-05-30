import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

import SidebarSaveFolderDialog from '../SidebarSaveFolderDialog.svelte';
import SidebarTagDialog from '../SidebarTagDialog.svelte';

interface RenderedDialog {
	unmount: () => void;
}

async function unmountDialog(rendered: RenderedDialog): Promise<void> {
	vi.useFakeTimers();
	try {
		rendered.unmount();
		await vi.runAllTimersAsync();
	} finally {
		vi.useRealTimers();
	}
}

describe('Sidebar dialogs', () => {
	it('includes the pending tag input when saving tags', async () => {
		const onSave = vi.fn().mockResolvedValue(undefined);

		const rendered = render(SidebarTagDialog, {
			tagDialog: {
				chatId: 'chat-1',
				chatTitle: 'Folder bug hunt',
				tags: ['existing'],
			},
			allKnownTags: [],
			onClose: vi.fn(),
			onSave,
		});

		try {
			const input = screen.getByRole('textbox', { name: 'Type a tag and press Enter' });
			await fireEvent.input(input, { target: { value: 'pending-tag' } });
			await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

			await waitFor(() => {
				expect(onSave).toHaveBeenCalledWith('chat-1', ['existing', 'pending-tag']);
			});
		} finally {
			await unmountDialog(rendered);
		}
	});

	it('keeps the save-folder dialog open and shows the error when folder creation fails', async () => {
		const onClose = vi.fn();
		const onSave = vi.fn().mockRejectedValue(new Error('Folder create failed'));

		const rendered = render(SidebarSaveFolderDialog, {
			saveFolderDialog: {
				mode: 'create' as const,
				filter: {
					textTokens: [],
					tags: [],
					agents: [],
					models: [],
					project: [],
					status: 'unread' as const,
				},
				suggestedName: 'Unread follow-up',
			},
			onClose,
			onSave,
		});

		try {
			await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

			await screen.findByText('Folder create failed');
			expect(screen.getByRole('dialog', { name: 'Save folder' })).toBeTruthy();
			expect(onClose).not.toHaveBeenCalled();
		} finally {
			await unmountDialog(rendered);
		}
	});

	it('normalizes tag input with spaces to slug form', async () => {
		const onSave = vi.fn().mockResolvedValue(undefined);

		const rendered = render(SidebarTagDialog, {
			tagDialog: {
				chatId: 'chat-1',
				chatTitle: 'Test chat',
				tags: [],
			},
			allKnownTags: [],
			onClose: vi.fn(),
			onSave,
		});

		try {
			const input = screen.getByRole('textbox', { name: 'Type a tag and press Enter' });
			await fireEvent.input(input, { target: { value: 'hello world' } });
			await fireEvent.keyDown(input, { key: 'Enter' });

			// The normalized tag should appear as a button in the editing list
			expect(screen.getByRole('button', { name: /hello-world/ })).toBeTruthy();
		} finally {
			await unmountDialog(rendered);
		}
	});

	it('shows quick assign section when input is empty and known tags exist', async () => {
		const rendered = render(SidebarTagDialog, {
			tagDialog: {
				chatId: 'chat-1',
				chatTitle: 'Test chat',
				tags: [],
			},
			allKnownTags: ['ops', 'bugs'],
			onClose: vi.fn(),
			onSave: vi.fn(),
		});

		try {
			expect(screen.getByText('ops')).toBeTruthy();
			expect(screen.getByText('bugs')).toBeTruthy();
		} finally {
			await unmountDialog(rendered);
		}
	});

	it('clicking a quick assign tag adds it to the editing list', async () => {
		const onSave = vi.fn().mockResolvedValue(undefined);

		const rendered = render(SidebarTagDialog, {
			tagDialog: {
				chatId: 'chat-1',
				chatTitle: 'Test chat',
				tags: [],
			},
			allKnownTags: ['ops'],
			onClose: vi.fn(),
			onSave,
		});

		try {
			// Click the quick-assign 'ops' tag
			const opsTag = screen.getByText('ops');
			await fireEvent.click(opsTag);

			// Save and verify 'ops' was included
			await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
			await waitFor(() => {
				expect(onSave).toHaveBeenCalledWith('chat-1', ['ops']);
			});
		} finally {
			await unmountDialog(rendered);
		}
	});

	it('prevents duplicate tags case-insensitively', async () => {
		const onSave = vi.fn().mockResolvedValue(undefined);

		const rendered = render(SidebarTagDialog, {
			tagDialog: {
				chatId: 'chat-1',
				chatTitle: 'Test chat',
				tags: ['ops'],
			},
			allKnownTags: [],
			onClose: vi.fn(),
			onSave,
		});

		try {
			const input = screen.getByRole('textbox', { name: 'Type a tag and press Enter' });
			await fireEvent.input(input, { target: { value: 'OPS' } });
			await fireEvent.keyDown(input, { key: 'Enter' });

			// Save should still only have the original 'ops', no duplicate
			await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
			await waitFor(() => {
				expect(onSave).toHaveBeenCalledWith('chat-1', ['ops']);
			});
		} finally {
			await unmountDialog(rendered);
		}
	});

	it('keeps the save-folder dialog modal while the save request is pending', async () => {
		const onClose = vi.fn();
		let resolveSave: (() => void) | null = null;
		const onSave = vi.fn(
			() => new Promise<void>((resolve) => {
				resolveSave = resolve;
			})
		);

		const rendered = render(SidebarSaveFolderDialog, {
			saveFolderDialog: {
				mode: 'create' as const,
				filter: {
					textTokens: ['follow-up'],
					tags: [],
					agents: [],
					models: [],
				project: [],
},
				suggestedName: 'Follow-up',
			},
			onClose,
			onSave,
		});

		try {
			const input = screen.getByRole('textbox');
			const saveButton = screen.getByRole('button', { name: 'Save' });
			const cancelButton = screen.getByRole('button', { name: 'Cancel' });

			await fireEvent.click(saveButton);

			await waitFor(() => {
				expect(onSave).toHaveBeenCalledTimes(1);
			});
			expect((input as HTMLInputElement).disabled).toBe(true);
			expect((saveButton as HTMLButtonElement).disabled).toBe(true);
			expect((cancelButton as HTMLButtonElement).disabled).toBe(true);
			expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();

			await fireEvent.keyDown(document, { key: 'Escape' });
			expect(onClose).not.toHaveBeenCalled();
			expect(screen.getByRole('dialog', { name: 'Save folder' })).toBeTruthy();

			expect(resolveSave).not.toBeNull();
			resolveSave!();
			await waitFor(() => {
				expect((saveButton as HTMLButtonElement).disabled).toBe(false);
			});
		} finally {
			await unmountDialog(rendered);
		}
	});
});
