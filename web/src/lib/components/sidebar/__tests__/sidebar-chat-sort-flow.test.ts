import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SidebarHost from './SidebarHost.svelte';
import { sortChatOrder } from '$lib/api/chats.js';
import type { ChatSessionRecord } from '$lib/types/chat-session';

vi.mock('$lib/api/chats.js', async () => {
	const actual = await vi.importActual<typeof import('$lib/api/chats.js')>('$lib/api/chats.js');
	return {
		...actual,
		sortChatOrder: vi.fn(),
	};
});

const mockSortChatOrder = vi.mocked(sortChatOrder);

function createChat(): ChatSessionRecord {
	return {
		id: 'chat-1',
		projectPath: '/tmp/project',
		effectiveProjectKey: '/tmp/project',
		projectIdentityState: 'available',
		orderGroup: 'normal',
		title: 'First chat',
		agentId: 'claude',
		model: 'sonnet',
		permissionMode: 'default',
		thinkingMode: 'low',
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
		createdAt: '2025-01-01T00:00:00.000Z',
		lastActivityAt: '2025-01-01T00:00:00.000Z',
		lastReadAt: '2025-01-01T00:00:00.000Z',
		isPinned: false,
		isArchived: false,
		isProcessing: false,
		processingPhase: null,
		isUnread: false,
		canReloadFromNativeHistory: false,
		status: 'running',
		lastMessage: 'First chat preview',
		firstMessage: 'First chat first',
		tags: [],
		parentChat: null,
		agentOwnershipEpoch: null,
	};
}

async function selectSortPreset(label: 'By creation time' | 'By recent activity'): Promise<void> {
	await fireEvent.click(screen.getByRole('button', { name: 'Chat actions' }));
	const reorderSubmenu = screen.getByRole('menuitem', { name: 'Reorder chats' });
	reorderSubmenu.focus();
	await fireEvent.keyDown(reorderSubmenu, { key: 'ArrowRight' });
	await fireEvent.click(await screen.findByRole('menuitem', { name: label }));
}

describe('sidebar chat sort flow', () => {
	beforeEach(() => {
		mockSortChatOrder.mockReset();
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it('refreshes, notifies, and recenters after a changed sort', async () => {
		const events: string[] = [];
		const notifications = {
			error: vi.fn(),
			info: vi.fn((message: string) => events.push(`info:${message}`)),
		};
		const onQuietRefresh = vi.fn(async () => {
			events.push('refresh');
		});
		const onRequestRecenter = vi.fn(() => {
			events.push('recenter');
		});
		mockSortChatOrder.mockImplementation(async (request) => {
			events.push(`api:${request.sortKey}`);
			return { success: true, sortKey: request.sortKey, changed: true };
		});

		render(SidebarHost, {
			chats: [createChat()],
			selectedChatId: 'chat-1',
			autoLoadSavedSearches: false,
			notifications,
			onQuietRefresh,
			onRequestRecenter,
		});

		await selectSortPreset('By creation time');

		await waitFor(() => {
			expect(events).toEqual(['api:created', 'refresh', 'info:Chats reordered.', 'recenter']);
		});
		expect(mockSortChatOrder).toHaveBeenCalledWith({ sortKey: 'created' });
		expect(onQuietRefresh).toHaveBeenCalledOnce();
		expect(notifications.error).not.toHaveBeenCalled();
		expect(onRequestRecenter).toHaveBeenCalledOnce();
	});

	it('refreshes silently without recentering after an unchanged sort', async () => {
		const notifications = { error: vi.fn(), info: vi.fn() };
		const onQuietRefresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
		const onRequestRecenter = vi.fn();
		mockSortChatOrder.mockResolvedValue({
			success: true,
			sortKey: 'activity',
			changed: false,
		});

		render(SidebarHost, {
			chats: [createChat()],
			autoLoadSavedSearches: false,
			notifications,
			onQuietRefresh,
			onRequestRecenter,
		});

		await selectSortPreset('By recent activity');

		await waitFor(() => expect(onQuietRefresh).toHaveBeenCalledOnce());
		expect(notifications.info).not.toHaveBeenCalled();
		expect(notifications.error).not.toHaveBeenCalled();
		expect(onRequestRecenter).not.toHaveBeenCalled();
	});

	it('reports an API failure without refreshing or reporting success', async () => {
		const notifications = { error: vi.fn(), info: vi.fn() };
		const onQuietRefresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
		const onRequestRecenter = vi.fn();
		mockSortChatOrder.mockRejectedValue(new Error('sort failed'));
		vi.spyOn(console, 'error').mockImplementation(() => {});

		render(SidebarHost, {
			chats: [createChat()],
			autoLoadSavedSearches: false,
			notifications,
			onQuietRefresh,
			onRequestRecenter,
		});

		await selectSortPreset('By creation time');

		await waitFor(() => {
			expect(notifications.error).toHaveBeenCalledWith('Failed to reorder chats.');
		});
		expect(onQuietRefresh).not.toHaveBeenCalled();
		expect(notifications.info).not.toHaveBeenCalled();
		expect(onRequestRecenter).not.toHaveBeenCalled();
	});
});
