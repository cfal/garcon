import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
import SidebarHost from './SidebarHost.svelte';

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
	canReloadFromNativeHistory: false,
	status: 'draft',
	lastMessage: '',
	firstMessage: '',
	tags: [],
	parentChat: null,
	agentOwnershipEpoch: null,
} satisfies ChatSessionRecord;

afterEach(cleanup);

describe('sidebar multi-select', () => {
	it.each([false, true])('exits on Escape from a focused chat row (mobile: %s)', async (isMobile) => {
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
	});
});
