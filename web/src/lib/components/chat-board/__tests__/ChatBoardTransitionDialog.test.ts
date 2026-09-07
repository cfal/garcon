import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatBoard } from '$shared/chat-boards';
import type { TransitionChatTagsRequest } from '$shared/chat-tag-mutations';
import type { ChatBoardApi } from '$lib/api/chat-boards';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import { ChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte';
import { ChatBoardController } from '$lib/chat-board/catalog/chat-board-controller.svelte';
import { ChatBoardInvalidationHub } from '$lib/chat-board/catalog/chat-board-invalidation-hub';
import ChatBoardTransitionDialog from '../ChatBoardTransitionDialog.svelte';

const source = {
	id: '22222222-2222-4222-8222-222222222222',
	name: 'Ready',
	match: 'all' as const,
	tags: ['ready'],
};
const target = {
	id: '33333333-3333-4333-8333-333333333333',
	name: 'Review',
	match: 'any' as const,
	tags: ['needs-design', 'review'],
};
const board: ChatBoard = {
	id: '11111111-1111-4111-8111-111111111111',
	name: 'Delivery',
	columns: [source, target],
};

function chat(): ChatSessionRecord {
	return {
		id: 'chat-1',
		parentChat: null,
		projectPath: '/workspace',
		orderGroup: 'normal',
		title: 'Refine authentication',
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
		canReloadFromNativeHistory: false,
		isUnread: false,
		status: 'running',
		agentOwnershipEpoch: null,
		tags: ['context', 'ready'],
	};
}

async function controller() {
	const api = {
		load: vi.fn(async () => ({ revision: 4, boards: [board] })),
		create: vi.fn(),
		update: vi.fn(),
		remove: vi.fn(),
		reorder: vi.fn(),
	} satisfies ChatBoardApi;
	const value = new ChatBoardController({
		api,
		invalidations: new ChatBoardInvalidationHub(),
		preferences: {
			get selectedBoardId() {
				return board.id;
			},
			setSelectedBoardId() {},
			get itemLayout() {
				return 'compact' as const;
			},
			setItemLayout() {},
			getActiveColumnId() {
				return source.id;
			},
			setActiveColumnId() {},
		},
		sidebarLayout: () => 'compact',
	});
	await value.refresh(true);
	return value;
}

afterEach(() => cleanup());

describe('ChatBoardTransitionDialog', () => {
	it('requires an explicit ANY selection and mutates only after confirmation', async () => {
		const transition = vi.fn(async (_request: TransitionChatTagsRequest) => ({
			success: true as const,
			chatId: 'chat-1',
			tags: ['context', 'review'],
			addedTags: ['review'],
			removedTags: ['ready'],
		}));
		const sessions = new ChatSessionsStore({
			transitionChatTags: transition,
			listChats: async () => ({ sessions: [], lastSelectedChatId: null, total: 0 }),
		});
		sessions.byId = { 'chat-1': chat() };
		sessions.order = ['chat-1'];
		const onApplied = vi.fn();
		render(ChatBoardTransitionDialog, {
			open: true,
			controller: await controller(),
			sessions,
			board,
			occurrence: { key: `${source.id}:chat-1`, columnId: source.id, chat: chat() },
			onClose: vi.fn(),
			onApplied,
		});

		const apply = screen.getByRole('button', { name: 'Apply tag changes' });
		expect(apply.hasAttribute('disabled')).toBe(true);
		expect(transition).not.toHaveBeenCalled();
		await fireEvent.click(screen.getByRole('checkbox', { name: 'review' }));
		expect(apply.hasAttribute('disabled')).toBe(false);
		expect(screen.getAllByText('ready')).toHaveLength(2);
		await fireEvent.click(apply);

		await waitFor(() => expect(onApplied).toHaveBeenCalledWith('chat-1', target.id));
		expect(transition).toHaveBeenCalledWith({
			chatId: 'chat-1',
			boardId: board.id,
			sourceColumnId: source.id,
			targetColumnId: target.id,
			expectedCatalogRevision: 4,
			expectedTags: ['context', 'ready'],
			selectedTargetTags: ['review'],
		});
	});

	it('preserves its opening baseline until the user reviews newer tags', async () => {
		const transition = vi.fn(async (_request: TransitionChatTagsRequest) => ({
			success: true as const,
			chatId: 'chat-1',
			tags: ['context', 'extra', 'review'],
			addedTags: ['review'],
			removedTags: ['ready'],
		}));
		const sessions = new ChatSessionsStore({
			transitionChatTags: transition,
			listChats: async () => ({ sessions: [], lastSelectedChatId: null, total: 0 }),
		});
		sessions.byId = { 'chat-1': chat() };
		sessions.order = ['chat-1'];
		render(ChatBoardTransitionDialog, {
			open: true,
			controller: await controller(),
			sessions,
			board,
			occurrence: { key: `${source.id}:chat-1`, columnId: source.id, chat: chat() },
			onClose: vi.fn(),
			onApplied: vi.fn(),
		});

		sessions.patchChat('chat-1', { tags: ['context', 'extra', 'ready'] });
		await waitFor(() =>
			expect(
				screen.getByText('Tags or columns changed. Review the latest state before applying.'),
			).toBeTruthy(),
		);
		expect(screen.getByRole('button', { name: 'Apply tag changes' }).hasAttribute('disabled')).toBe(
			true,
		);

		await fireEvent.click(screen.getByRole('button', { name: 'Review latest changes' }));
		await fireEvent.click(screen.getByRole('checkbox', { name: 'review' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Apply tag changes' }));

		await waitFor(() => expect(transition).toHaveBeenCalledOnce());
		expect(transition.mock.calls[0]?.[0]).toMatchObject({
			expectedCatalogRevision: 4,
			expectedTags: ['context', 'extra', 'ready'],
			selectedTargetTags: ['review'],
		});
	});
});
