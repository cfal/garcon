import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as chatsApi from '$lib/api/chats';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import SidebarHost from './SidebarHost.svelte';

vi.mock('$lib/api/chats', async () => {
	const actual = await vi.importActual<typeof import('$lib/api/chats')>('$lib/api/chats');
	return { ...actual, toggleArchive: vi.fn() };
});

function makeChat(id: string): ChatSessionRecord {
	return {
		id,
		projectPath: '/workspace/repo',
		effectiveProjectKey: '/workspace/repo',
		projectIdentityState: 'available',
		orderGroup: 'normal',
		title: id,
		agentId: 'claude',
		model: 'sonnet',
		permissionMode: 'default',
		thinkingMode: 'none',
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
		createdAt: null,
		lastActivityAt: null,
		lastReadAt: null,
		isPinned: false,
		isArchived: false,
		isProcessing: false,
		processingPhase: null,
		isUnread: false,
		canReloadFromNativeHistory: false,
		status: 'draft',
		tags: [],
		parentChat: null,
		agentOwnershipEpoch: null,
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
	it('selects a replacement before the archive request completes', async () => {
		const archive = deferred<Awaited<ReturnType<typeof chatsApi.toggleArchive>>>();
		vi.mocked(chatsApi.toggleArchive).mockReturnValueOnce(archive.promise);
		const onChatSelect = vi.fn();
		const onQuietRefresh = vi.fn(async () => undefined);
		render(SidebarHost, {
			chats: [makeChat('selected'), makeChat('next')],
			selectedChatId: 'selected',
			autoLoadSavedSearches: false,
			onChatSelect,
			onQuietRefresh,
		});

		await fireEvent.click(screen.getAllByRole('button', { name: 'Chat actions' })[0]);
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Select' }));
		await fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));

		expect(chatsApi.toggleArchive).toHaveBeenCalledWith('selected');
		expect(onChatSelect).toHaveBeenCalledOnce();
		expect(onChatSelect).toHaveBeenCalledWith('next');
		expect(screen.getByText('selected')).toBeTruthy();

		archive.resolve({ success: true, isArchived: true });
		await waitFor(() => expect(onQuietRefresh).toHaveBeenCalledOnce());
		expect(onChatSelect).toHaveBeenCalledOnce();
	});
});
