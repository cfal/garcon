import { fireEvent, render, screen, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';

import WorkspaceGroupHarness from './WorkspaceGroupHarness.svelte';

import type { ChatSessionRecord } from '$lib/types/chat-session';

afterEach(() => {
	cleanup();
});

function createChat(overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
	return {
		id: 'chat-1',
		projectPath: '/my-project/chat-1',
		title: 'Chat 1',
		provider: 'claude',
		model: null,
		permissionMode: 'default',
		thinkingMode: 'think',
		claudeThinkingMode: 'auto',
		ampAgentMode: 'smart',
		createdAt: null,
		lastActivityAt: null,
		lastReadAt: null,
		isPinned: false,
		isArchived: false,
		isProcessing: false,
		isUnread: false,
		status: 'draft',
		tags: [],
			...overrides,
	};
}

function createManyChat(n: number): ChatSessionRecord[] {
	return Array.from({ length: n }, (_, i) =>
		createChat({ id: String(i), projectPath: '/my-project/chat' })
	);
}

function baseProps(): Record<string, unknown> {
	return {
		chats: [] as ChatSessionRecord[],
		selectedChatId: null,
		currentTime: new Date('2025-01-01T00:00:00.000Z'),
	};
}

function allCallbacks(): Record<string, () => void> {
	return {
		onChatSelect: () => {},
		onDeleteChat: () => {},
		onStartRenameChat: () => {},
		onTogglePinned: () => {},
		onToggleArchive: () => {},
		onShowDetails: () => {},
		onForkChat: () => {},
		onShareChat: () => {},
	};
}

describe('WorkspaceGroup', () => {
	it('renders the workspace name and chat count', () => {
		const chats = [createChat({ id: '1', projectPath: '/my-project/chat1' })];
		render(WorkspaceGroupHarness, {
				...baseProps(),
			chats,
			workspaceName: 'my-project',
			...allCallbacks(),
			});
		expect(screen.getByText('my-project')).toBeTruthy();
		expect(screen.getByText('1')).toBeTruthy();
	});

	it('shows all chats when count is less than default limit', () => {
		const chats = createManyChat(3);
		render(WorkspaceGroupHarness, {
				...baseProps(),
			chats,
			workspaceName: 'my-project',
			...allCallbacks(),
			});
		const chatTitles = screen.getAllByText(/Chat 1/);
		expect(chatTitles).toHaveLength(6);
		expect(screen.queryAllByText(/show more/i)).toHaveLength(0);
	});

	it('shows "show more" button when there are more chats than the limit', () => {
		const chats = createManyChat(8);
		render(WorkspaceGroupHarness, {
				...baseProps(),
			chats,
			workspaceName: 'my-project',
			...allCallbacks(),
			});
		expect(screen.getByText(/show \d+ more/i)).toBeTruthy();
		const chatTitles = screen.getAllByText(/Chat 1/);
		expect(chatTitles).toHaveLength(10);
	});

	it('expands to show 5 more chats on "show more" click', async () => {
		const chats = createManyChat(12);
		render(WorkspaceGroupHarness, {
				...baseProps(),
			chats,
			workspaceName: 'my-project',
			...allCallbacks(),
			});
		const chatTitles1 = screen.getAllByText(/Chat 1/);
		expect(chatTitles1).toHaveLength(10);
		await fireEvent.click(screen.getByText(/show \d+ more/i));
		const chatTitles2 = screen.getAllByText(/Chat 1/);
		expect(chatTitles2).toHaveLength(20);
		expect(screen.queryAllByText(/show \d+ more/i)).toHaveLength(1);
	});

	it('collapses and expands the workspace group header', async () => {
		const chats = createManyChat(1);
		render(WorkspaceGroupHarness, {
				...baseProps(),
			chats,
			workspaceName: 'my-project',
			...allCallbacks(),
			});
		expect(screen.getAllByText(/Chat 1/)).toHaveLength(2);
		await fireEvent.click(screen.getByText('my-project'));
		expect(screen.queryAllByText(/Chat 1/)).toHaveLength(0);
		await fireEvent.click(screen.getByText('my-project'));
		expect(screen.getAllByText(/Chat 1/)).toHaveLength(2);
	});

	it('resets visible count after closing and reopening the group', async () => {
		const chats = createManyChat(10);
		render(WorkspaceGroupHarness, {
				...baseProps(),
			chats,
			workspaceName: 'my-project',
			...allCallbacks(),
			});
		expect(screen.getAllByText(/Chat 1/)).toHaveLength(10);
		await fireEvent.click(screen.getByText(/show \d+ more/i));
		expect(screen.getAllByText(/Chat 1/)).toHaveLength(20);
		await fireEvent.click(screen.getByText('my-project'));
		expect(screen.queryAllByText(/Chat 1/)).toHaveLength(0);
		await fireEvent.click(screen.getByText('my-project'));
		expect(screen.getAllByText(/Chat 1/)).toHaveLength(10);
		expect(screen.queryAllByText(/show \d+ more/i)).toHaveLength(1);
	});

	it('respects aria-expanded attribute', async () => {
		const chats = createManyChat(1);
		render(WorkspaceGroupHarness, {
				...baseProps(),
			chats,
			workspaceName: 'my-project',
			...allCallbacks(),
			});
		const button = screen.getByRole('button', { name: 'my-project' }) as HTMLButtonElement;
		expect(button.getAttribute('aria-expanded')).toBe('true');
		await fireEvent.click(button);
		expect(button.getAttribute('aria-expanded')).toBe('false');
	});

	it('renders Unassigned for empty projectPath', () => {
		const chats = [createChat({ id: '1', projectPath: '' })];
		render(WorkspaceGroupHarness, {
				...baseProps(),
			chats,
			workspaceName: 'Unassigned',
			...allCallbacks(),
			});
		expect(screen.getByText('Unassigned')).toBeTruthy();
	});
});
