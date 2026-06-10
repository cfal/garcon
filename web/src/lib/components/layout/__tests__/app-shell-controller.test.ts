import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppShellController, type AppShellControllerDeps } from '../app-shell-controller.svelte';

// Mock API modules so no real HTTP requests are made.
vi.mock('$lib/api/chats.js', () => ({
	listChats: vi.fn(),
	deleteChat: vi.fn(),
}));
vi.mock('$lib/api/settings.js', () => ({
	updateSessionName: vi.fn(),
}));

import { listChats, deleteChat } from '$lib/api/chats.js';
import { updateSessionName } from '$lib/api/settings.js';

const mockListChats = vi.mocked(listChats);
const mockDeleteChat = vi.mocked(deleteChat);
const mockUpdateSessionName = vi.mocked(updateSessionName);

describe('AppShellController', () => {
	let deps: AppShellControllerDeps;
	let controller: AppShellController;

	beforeEach(() => {
		vi.clearAllMocks();
		deps = {
			upsertFromServer: vi.fn(),
			setLoadingChats: vi.fn(),
		};
		controller = new AppShellController(deps);
	});

	describe('fetchChats', () => {
		it('sets loading true, upserts sessions, then sets loading false', async () => {
			const sessions = [{ id: 'c-1' }] as any;
			mockListChats.mockResolvedValue({ sessions, total: 1 });

			await controller.fetchChats();

			expect(deps.setLoadingChats).toHaveBeenCalledWith(true);
			expect(deps.upsertFromServer).toHaveBeenCalledWith(sessions);
			expect(deps.setLoadingChats).toHaveBeenCalledWith(false);
		});

		it('sets loading false even on failure', async () => {
			mockListChats.mockRejectedValue(new Error('network'));

			await controller.fetchChats();

			expect(deps.setLoadingChats).toHaveBeenCalledWith(true);
			expect(deps.setLoadingChats).toHaveBeenCalledWith(false);
			expect(deps.upsertFromServer).not.toHaveBeenCalled();
		});

		it('upserts empty array when sessions field is missing', async () => {
			mockListChats.mockResolvedValue({ sessions: undefined as any, total: 0 });

			await controller.fetchChats();

			expect(deps.upsertFromServer).toHaveBeenCalledWith([]);
		});
	});

	describe('quietRefresh', () => {
		it('upserts without toggling loading state', async () => {
			const sessions = [{ id: 'c-2' }] as any;
			mockListChats.mockResolvedValue({ sessions, total: 1 });

			await controller.quietRefresh();

			expect(deps.setLoadingChats).not.toHaveBeenCalled();
			expect(deps.upsertFromServer).toHaveBeenCalledWith(sessions);
		});

		it('silently catches errors', async () => {
			mockListChats.mockRejectedValue(new Error('network'));

			await expect(controller.quietRefresh()).resolves.toBeUndefined();
			expect(deps.upsertFromServer).not.toHaveBeenCalled();
		});

		it('runs a follow-up fetch when refresh is requested during an in-flight fetch', async () => {
			let resolveFirst: (value: { sessions: any[]; total: number }) => void = () => {};
			const first = new Promise<{ sessions: any[]; total: number }>((resolve) => {
				resolveFirst = resolve;
			});
			const staleSessions = [{ id: 'stale' }] as any;
			const freshSessions = [{ id: 'fresh' }] as any;
			mockListChats
				.mockReturnValueOnce(first)
				.mockResolvedValueOnce({ sessions: freshSessions, total: 1 });

			const firstRefresh = controller.quietRefresh();
			const secondRefresh = controller.quietRefresh();
			resolveFirst({ sessions: staleSessions, total: 1 });
			await Promise.all([firstRefresh, secondRefresh]);

			expect(mockListChats).toHaveBeenCalledTimes(2);
			expect(deps.upsertFromServer).toHaveBeenNthCalledWith(1, staleSessions);
			expect(deps.upsertFromServer).toHaveBeenNthCalledWith(2, freshSessions);
		});
	});

	describe('deleteChat', () => {
		it('delegates to API deleteChat', async () => {
			mockDeleteChat.mockResolvedValue({ success: true });

			await controller.deleteChat('c-1');

			expect(mockDeleteChat).toHaveBeenCalledWith('c-1');
		});

		it('silently catches errors', async () => {
			mockDeleteChat.mockRejectedValue(new Error('fail'));

			await expect(controller.deleteChat('c-1')).resolves.toBeUndefined();
		});
	});

	describe('renameChat', () => {
		it('delegates to API updateSessionName', async () => {
			mockUpdateSessionName.mockResolvedValue({ success: true });

			await controller.renameChat('c-1', 'New Title');

			expect(mockUpdateSessionName).toHaveBeenCalledWith('c-1', 'New Title');
		});

		it('silently catches errors', async () => {
			mockUpdateSessionName.mockRejectedValue(new Error('fail'));

			await expect(controller.renameChat('c-1', 'Title')).resolves.toBeUndefined();
		});
	});
});
