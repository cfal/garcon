import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as chatsApi from '$lib/api/chats';
import { ChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte';
import type { ChatSession } from '$lib/types/session';
import SidebarHost from './SidebarHost.svelte';

vi.mock('$lib/api/chats', async () => {
	const actual = await vi.importActual<typeof import('$lib/api/chats')>('$lib/api/chats');
	return { ...actual, toggleArchive: vi.fn() };
});

function makeServerChat(
	id: string,
	archived = false,
	lastActivityAt: string | null = null,
): ChatSession {
	return {
		id,
		projectPath: '/workspace/repo',
		orderGroup: archived ? 'archived' : 'normal',
		title: id,
		agentId: 'claude',
		model: 'sonnet',
		permissionMode: 'default',
		thinkingMode: 'none',
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
		activity: { createdAt: null, lastActivityAt, lastReadAt: null },
		preview: { lastMessage: '' },
		isPinned: false,
		isArchived: archived,
		isActive: false,
		isProcessing: false,
		processingPhase: null,
		isUnread: false,
		canReloadFromNativeHistory: false,
		tags: [],
		parentChat: null,
		agentOwnershipEpoch: 'epoch-1',
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	cleanup();
});

describe('sidebar bulk archive flow', () => {
	it('moves selected chats ahead of archived rows before the requests complete', async () => {
		const archive = deferred<Awaited<ReturnType<typeof chatsApi.toggleArchive>>>();
		vi.mocked(chatsApi.toggleArchive).mockReturnValueOnce(archive.promise);
		const listChats = vi.fn(async () => ({
			sessions: [
				makeServerChat('next', false, '2026-01-01T00:00:00.000Z'),
				makeServerChat('selected', true, '2026-02-01T00:00:00.000Z'),
				makeServerChat('archived', true, '2026-03-01T00:00:00.000Z'),
			],
			total: 3,
			lastSelectedChatId: 'next',
		}));
		const chatSessions = new ChatSessionsStore({
			toggleArchive: chatsApi.toggleArchive,
			listChats,
		});
		chatSessions.upsertFromServer([
			makeServerChat('selected', false, '2026-02-01T00:00:00.000Z'),
			makeServerChat('next', false, '2026-01-01T00:00:00.000Z'),
			makeServerChat('archived', true, '2026-03-01T00:00:00.000Z'),
		]);
		const onChatSelect = vi.fn();
		const { container } = render(SidebarHost, {
			chatSessions,
			selectedChatId: 'selected',
			autoLoadSavedSearches: false,
			sidebarSortMode: 'recent',
			onChatSelect,
		});

		await fireEvent.click(screen.getAllByRole('button', { name: 'Chat actions' })[0]);
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Select' }));
		await fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));

		expect(chatsApi.toggleArchive).toHaveBeenCalledWith('selected');
		expect(onChatSelect).toHaveBeenCalledOnce();
		expect(onChatSelect).toHaveBeenCalledWith('next');
		expect(
			Array.from(container.querySelectorAll('[data-sidebar-virtual-list-row="archived"]')).map(
				(row) => row.getAttribute('data-sidebar-virtual-row'),
			),
		).toEqual(['selected', 'archived']);

		expect(screen.getByRole('button', { name: 'Unarchive' }).hasAttribute('disabled')).toBe(true);
		expect(chatsApi.toggleArchive).toHaveBeenCalledOnce();

		archive.resolve({ success: true, isArchived: true });
		await waitFor(() => expect(listChats).toHaveBeenCalledOnce());
		expect(onChatSelect).toHaveBeenCalledOnce();
		expect(chatSessions.isArchiveMutationPending('selected')).toBe(false);
	});
});
