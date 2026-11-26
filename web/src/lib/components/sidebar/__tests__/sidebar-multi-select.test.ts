import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
import SidebarHost from './SidebarHost.svelte';
import { createSidebarSearchStore } from '$lib/sidebar/search/sidebar-search-store.svelte';

const chat = {
	id: 'chat-1',
	projectPath: '/workspace/project',
	orderGroup: 'normal',
	title: 'First chat',
	agentId: 'claude',
	model: 'sonnet',
	permissionMode: 'default',
	thinkingMode: 'none',
	agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
	createdAt: '2025-01-01T00:00:00.000Z',
	lastActivityAt: '2025-01-01T00:00:00.000Z',
	lastReadAt: '2025-01-01T00:00:00.000Z',
	isPinned: false,
	isArchived: false,
	isProcessing: false,
	processingPhase: null,
	isUnread: false,
	activityStatus: null,
	observation: null, canReloadFromNativeHistory: false,
	status: 'draft',
	lastMessage: '',
	firstMessage: '',
	tags: [],
	parentChatId: null,
	lineage: null,
	agentOwnershipEpoch: null,
} satisfies ChatSessionRecord;

afterEach(cleanup);

describe('sidebar multi-select', () => {
	it('keeps filtered parent context navigable but excludes it from selection', async () => {
		const chats = [
			{ ...chat, id: 'parent', title: 'Parent' },
			{
				...chat,
				id: 'child',
				title: 'Match',
				parentChatId: 'parent',
				lineage: null,
			},
		];
		const sidebarSearch = createSidebarSearchStore({
			getChats: () => chats,
			getTranscriptSearchEnabled: () => false,
			getSearchResultSort: () => 'relevance',
			getSelectedChatId: () => null,
			notifyError: vi.fn(),
		});
		sidebarSearch.applyQuery('Match');
		const onChatSelect = vi.fn();
		render(SidebarHost, {
			chats,
			sidebarSearch,
			sidebarNestDelegatedChats: true,
			sidebarGroupingFields: [],
			autoLoadSavedSearches: false,
			onChatSelect,
		});
		const parent = within(
			document.querySelector('[data-sidebar-virtual-row="parent"]') as HTMLElement,
		);
		const child = within(
			document.querySelector('[data-sidebar-virtual-row="child"]') as HTMLElement,
		);
		expect(parent.getByText('Parent context')).toBeTruthy();
		await fireEvent.click(child.getByRole('button', { name: 'Chat actions' }));
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Select' }));
		expect(screen.getAllByRole('checkbox')).toHaveLength(1);
		expect(
			screen.getByRole('checkbox', { name: 'Select Match' }).getAttribute('aria-checked'),
		).toBe('true');
		await fireEvent.click(parent.getByText('Parent'));
		expect(onChatSelect).toHaveBeenCalledWith('parent');
		expect(parent.queryByRole('checkbox')).toBeNull();
	});
	it.each([false, true])(
		'exits on Escape from a focused chat row (mobile: %s)',
		async (isMobile) => {
			const onChatSelect = vi.fn();
			render(SidebarHost, {
				chats: [chat],
				selectedChatId: chat.id,
				isMobile,
				autoLoadSavedSearches: false,
				onChatSelect,
			});

			await fireEvent.click(screen.getByRole('button', { name: 'Chat actions' }));
			await fireEvent.click(await screen.findByRole('menuitem', { name: 'Select' }));
			await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

			const checkbox = screen.getByRole('checkbox', { name: 'Select First chat' });
			expect(checkbox.getAttribute('aria-checked')).toBe('true');
			expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
			checkbox.focus();
			expect(document.activeElement).toBe(checkbox);

			await fireEvent.keyDown(checkbox, { key: 'a', bubbles: true });
			expect(screen.getByRole('checkbox', { name: 'Select First chat' })).toBe(checkbox);
			const escape = new KeyboardEvent('keydown', {
				key: 'Escape',
				bubbles: true,
				cancelable: true,
			});
			await fireEvent(checkbox, escape);

			expect(escape.defaultPrevented).toBe(true);
			expect(screen.queryByRole('checkbox', { name: 'Select First chat' })).toBeNull();
			expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
			expect(screen.getByRole('button', { name: 'Chat actions' })).toBeTruthy();
			expect(onChatSelect).not.toHaveBeenCalled();
		},
	);
});
