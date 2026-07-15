import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

import SidebarSaveFolderDialog from '../SidebarSaveFolderDialog.svelte';
import SidebarTagDialog from '../SidebarTagDialog.svelte';
import SidebarProjectPathDialog from '../SidebarProjectPathDialog.svelte';
import { ApiError } from '$lib/api/client';
import * as chatsApi from '$lib/api/chats';
import * as gitApi from '$lib/api/git';
import type { GitWorktreeItem } from '$lib/api/git';

vi.mock('$lib/api/chats', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/api/chats')>();
	return {
		...actual,
		validateStart: vi.fn(),
	};
});

vi.mock('$lib/api/git', () => ({
	getGitWorktrees: vi.fn(),
	gitCreateWorktree: vi.fn(),
}));

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

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function makeWorktree(path: string, branch: string, isCurrent = false): GitWorktreeItem {
	return {
		name: branch,
		path,
		branch,
		isCurrent,
		isMain: branch === 'main',
		isPathMissing: false,
		lastModifiedAt: null,
	};
}

describe('Sidebar dialogs', () => {
	it('submits a validated project path and keeps server errors inline', async () => {
		vi.useFakeTimers();
		vi.mocked(chatsApi.validateStart).mockResolvedValue({ valid: true, isGitRepo: true });
		const onClose = vi.fn();
		const onConfirm = vi
			.fn()
			.mockRejectedValueOnce(new ApiError(409, 'busy', 'CHAT_NOT_IDLE'))
			.mockResolvedValueOnce(undefined);

		const rendered = render(SidebarProjectPathDialog, {
			projectPathDialog: {
				chatId: 'chat-1',
				chatTitle: 'Feature chat',
				currentProjectPath: '/workspace/repo',
			},
			projectBasePath: '/workspace',
			isMobile: false,
			onClose,
			onConfirm,
		});

		try {
			const input = screen.getByRole('textbox', { name: /new path/i });
			await fireEvent.input(input, { target: { value: '/workspace/repo-worktree' } });
			await vi.advanceTimersByTimeAsync(250);

			await waitFor(() => {
				expect(chatsApi.validateStart).toHaveBeenCalledWith(
					'/workspace/repo-worktree',
					expect.objectContaining({ signal: expect.any(AbortSignal) }),
				);
			});

			const updateButton = await screen.findByRole('button', { name: 'Update path' });
			await fireEvent.click(updateButton);

			await screen.findByText(/wait for the active turn/i);
			expect(onClose).not.toHaveBeenCalled();
			expect(onConfirm).toHaveBeenCalledWith('chat-1', '/workspace/repo-worktree');

			await fireEvent.click(updateButton);
			await waitFor(() => {
				expect(onClose).toHaveBeenCalledTimes(1);
			});
		} finally {
			rendered.unmount();
			await vi.runAllTimersAsync();
			vi.useRealTimers();
		}
	});

	it('applies pinned project paths in the project path dialog', async () => {
		vi.useFakeTimers();
		const pinnedPath = '/workspace/pinned-repo';
		vi.mocked(chatsApi.validateStart).mockResolvedValue({ valid: true, isGitRepo: true });

		const rendered = render(SidebarProjectPathDialog, {
			projectPathDialog: {
				chatId: 'chat-1',
				chatTitle: 'Feature chat',
				currentProjectPath: '/workspace/repo',
			},
			projectBasePath: '/workspace',
			pinnedProjectPaths: [pinnedPath],
			isMobile: false,
			onClose: vi.fn(),
			onConfirm: vi.fn(),
		});

		try {
			await fireEvent.click(screen.getByRole('button', { name: pinnedPath }));

			expect((screen.getByRole('textbox', { name: /new path/i }) as HTMLInputElement).value).toBe(
				pinnedPath,
			);

			await vi.advanceTimersByTimeAsync(250);
			await waitFor(() => {
				expect(chatsApi.validateStart).toHaveBeenCalledWith(
					pinnedPath,
					expect.objectContaining({ signal: expect.any(AbortSignal) }),
				);
			});
		} finally {
			rendered.unmount();
			await vi.runAllTimersAsync();
			vi.useRealTimers();
		}
	});

	it('selects a worktree in the project path dialog without applying until update', async () => {
		vi.useFakeTimers();
		const selectedPath = '/workspace/repo-feature';
		vi.mocked(chatsApi.validateStart).mockResolvedValue({ valid: true, isGitRepo: true });
		vi.mocked(gitApi.getGitWorktrees).mockResolvedValue({
			worktrees: [
				makeWorktree('/workspace/repo', 'main', true),
				makeWorktree(selectedPath, 'feature'),
			],
		});
		const onConfirm = vi.fn();

		const rendered = render(SidebarProjectPathDialog, {
			projectPathDialog: {
				chatId: 'chat-1',
				chatTitle: 'Feature chat',
				currentProjectPath: '/workspace/repo',
			},
			projectBasePath: '/workspace',
			isMobile: false,
			onClose: vi.fn(),
			onConfirm,
		});

		try {
			await vi.advanceTimersByTimeAsync(250);
			const selectWorktree = await screen.findByRole('button', {
				name: 'Select a different worktree',
			});
			await fireEvent.click(selectWorktree);

			const worktreeDialog = await screen.findByRole('dialog', { name: 'Select worktree' });
			expect(worktreeDialog).toBeTruthy();
			expect(gitApi.getGitWorktrees).toHaveBeenCalledWith(
				'/workspace/repo',
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			);
			await fireEvent.click(await screen.findByRole('option', { name: /feature/ }));

			expect((screen.getByRole('textbox', { name: /new path/i }) as HTMLInputElement).value).toBe(
				selectedPath,
			);
			expect(onConfirm).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(250);
			const updateButton = await screen.findByRole('button', { name: 'Update path' });
			await waitFor(() => {
				expect((updateButton as HTMLButtonElement).disabled).toBe(false);
			});
			await fireEvent.click(updateButton);

			await waitFor(() => {
				expect(onConfirm).toHaveBeenCalledWith('chat-1', selectedPath);
			});
		} finally {
			rendered.unmount();
			await vi.runAllTimersAsync();
			vi.useRealTimers();
		}
	});

	it('hides the project path worktree link for valid non-git folders', async () => {
		vi.useFakeTimers();
		vi.mocked(chatsApi.validateStart).mockResolvedValue({ valid: true, isGitRepo: false });

		const rendered = render(SidebarProjectPathDialog, {
			projectPathDialog: {
				chatId: 'chat-1',
				chatTitle: 'Feature chat',
				currentProjectPath: '/workspace/plain-folder',
			},
			projectBasePath: '/workspace',
			isMobile: false,
			onClose: vi.fn(),
			onConfirm: vi.fn(),
		});

		try {
			await vi.advanceTimersByTimeAsync(250);
			await waitFor(() => {
				expect(chatsApi.validateStart).toHaveBeenCalledWith(
					'/workspace/plain-folder',
					expect.objectContaining({ signal: expect.any(AbortSignal) }),
				);
			});
			expect(screen.queryByRole('button', { name: 'Select a different worktree' })).toBeNull();
		} finally {
			rendered.unmount();
			await vi.runAllTimersAsync();
			vi.useRealTimers();
		}
	});

	it('requests pinning the edited project path', async () => {
		vi.useFakeTimers();
		const onTogglePinnedProjectPath = vi.fn();

		const rendered = render(SidebarProjectPathDialog, {
			projectPathDialog: {
				chatId: 'chat-1',
				chatTitle: 'Feature chat',
				currentProjectPath: '/workspace/repo',
			},
			projectBasePath: '/workspace',
			pinnedProjectPaths: [],
			isMobile: false,
			onClose: vi.fn(),
			onConfirm: vi.fn(),
			onTogglePinnedProjectPath,
		});

		try {
			const input = screen.getByRole('textbox', { name: /new path/i });
			await fireEvent.input(input, { target: { value: '/workspace/repo-worktree' } });
			await fireEvent.click(screen.getByRole('button', { name: 'Pin project path' }));

			expect(onTogglePinnedProjectPath).toHaveBeenCalledWith('/workspace/repo-worktree');
		} finally {
			rendered.unmount();
			await vi.runAllTimersAsync();
			vi.useRealTimers();
		}
	});

	it('shows a loading indicator while project path pinning is pending', async () => {
		vi.useFakeTimers();
		vi.mocked(chatsApi.validateStart).mockResolvedValue({ valid: true, isGitRepo: true });
		const pending = deferred<void>();
		const onTogglePinnedProjectPath = vi.fn(() => pending.promise);

		const rendered = render(SidebarProjectPathDialog, {
			projectPathDialog: {
				chatId: 'chat-1',
				chatTitle: 'Feature chat',
				currentProjectPath: '/workspace/repo',
			},
			projectBasePath: '/workspace',
			pinnedProjectPaths: [],
			isMobile: false,
			onClose: vi.fn(),
			onConfirm: vi.fn(),
			onTogglePinnedProjectPath,
		});

		try {
			const input = screen.getByRole('textbox', { name: /new path/i }) as HTMLInputElement;
			await fireEvent.input(input, { target: { value: '/workspace/repo-worktree' } });
			await vi.advanceTimersByTimeAsync(250);
			const updateButton = screen.getByRole('button', {
				name: 'Update path',
			}) as HTMLButtonElement;
			await waitFor(() => {
				expect(updateButton.disabled).toBe(false);
			});

			const toggleButton = screen.getByRole('button', { name: 'Pin project path' });
			await fireEvent.click(toggleButton);

			const browseButton = screen.getByRole('button', {
				name: 'Browse folders',
			}) as HTMLButtonElement;
			expect(toggleButton.getAttribute('aria-busy')).toBe('true');
			expect(toggleButton.querySelector('.animate-spin')).toBeTruthy();
			expect(input.readOnly).toBe(true);
			expect(browseButton.disabled).toBe(true);
			expect(updateButton.disabled).toBe(false);

			pending.resolve();
			await waitFor(() => {
				expect(toggleButton.getAttribute('aria-busy')).toBe('false');
			});
		} finally {
			rendered.unmount();
			await vi.runAllTimersAsync();
			vi.useRealTimers();
		}
	});

	it('requests unpinning the edited project path when it is already pinned', async () => {
		vi.useFakeTimers();
		const onTogglePinnedProjectPath = vi.fn();

		const rendered = render(SidebarProjectPathDialog, {
			projectPathDialog: {
				chatId: 'chat-1',
				chatTitle: 'Feature chat',
				currentProjectPath: '/workspace/repo',
			},
			projectBasePath: '/workspace',
			pinnedProjectPaths: ['/workspace/repo'],
			isMobile: false,
			onClose: vi.fn(),
			onConfirm: vi.fn(),
			onTogglePinnedProjectPath,
		});

		try {
			await fireEvent.click(screen.getByRole('button', { name: 'Unpin project path' }));

			expect(onTogglePinnedProjectPath).toHaveBeenCalledWith('/workspace/repo');
		} finally {
			rendered.unmount();
			await vi.runAllTimersAsync();
			vi.useRealTimers();
		}
	});

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
			() =>
				new Promise<void>((resolve) => {
					resolveSave = resolve;
				}),
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
