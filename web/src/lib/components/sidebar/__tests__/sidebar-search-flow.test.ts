import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SidebarHarness from './SidebarHarness.svelte';

import { getSavedSearches } from '$lib/api/settings';
import type { ChatSessionRecord } from '$lib/types/chat-session';

vi.mock('$lib/api/settings', async () => {
	const actual = await vi.importActual<typeof import('$lib/api/settings')>('$lib/api/settings');
	return {
		...actual,
		getSavedSearches: vi.fn(),
		createSavedSearch: vi.fn(),
		updateSavedSearch: vi.fn(),
		deleteSavedSearch: vi.fn(),
		reorderSavedSearches: vi.fn(),
	};
});

function createChat(id: string, title: string): ChatSessionRecord {
	return {
		id,
		projectPath: '/tmp/project',
		title,
		provider: 'claude',
		model: 'sonnet',
		permissionMode: 'default',
		thinkingMode: 'think',
		claudeThinkingMode: 'auto',
		ampAgentMode: 'smart',
		createdAt: '2025-01-01T00:00:00.000Z',
		lastActivityAt: '2025-01-01T00:00:00.000Z',
		lastReadAt: '2025-01-01T00:00:00.000Z',
		isPinned: false,
		isArchived: false,
		isProcessing: false,
		isUnread: false,
		status: 'draft',
		lastMessage: `${title} preview`,
		tags: [],
		firstMessage: `${title} first`,
	};
}

describe('sidebar search dialog flow', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getSavedSearches).mockResolvedValue({ savedSearches: [] });
	});

	it('restores the search dialog draft after cancelling add saved search', async () => {
		render(SidebarHarness, {
			chats: [createChat('chat-1', 'First chat')],
		});

		await waitFor(() => {
			expect(getSavedSearches).toHaveBeenCalledTimes(1);
		});

		await fireEvent.click(await screen.findByRole('button', { name: 'Search chats...' }));

		const searchInput = await screen.findByRole('textbox');
		await fireEvent.input(searchInput, { target: { value: 'tag:ops' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Add saved search' }));

		const editorQueryInput = await screen.findByLabelText('Query');
		expect((editorQueryInput as HTMLInputElement).value).toBe('tag:ops');

		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		const resumedInput = await screen.findByRole('textbox');
		expect((resumedInput as HTMLInputElement).value).toBe('tag:ops');
		expect(screen.getByRole('button', { name: 'Manage searches' })).toBeTruthy();
	});
});
