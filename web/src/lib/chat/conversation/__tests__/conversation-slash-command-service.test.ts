import { beforeEach, describe, expect, it, vi } from 'vitest';

import { compactChat, forkChat, forkRunChat } from '$lib/api/chats.js';
import { scheduleChatPrompt } from '$lib/api/scheduled-prompts.js';
import { ApiError } from '$lib/api/client.js';
import { AssistantMessage } from '$shared/chat-types';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import {
	ConversationSlashCommandService,
	type ConversationSlashCommandDeps,
} from '$lib/chat/conversation/conversation-slash-command-service.js';

vi.mock('$lib/api/chats.js', () => ({
	compactChat: vi.fn(),
	createQueuedInput: vi.fn(),
	forkChat: vi.fn(),
	forkRunChat: vi.fn(),
	runChat: vi.fn(),
	steerChat: vi.fn(),
	submitGoalControl: vi.fn(),
	startChat: vi.fn(),
}));

vi.mock('$lib/api/scheduled-prompts.js', () => ({
	scheduleChatPrompt: vi.fn(),
}));

const mockCompactChat = vi.mocked(compactChat);
const mockForkChat = vi.mocked(forkChat);
const mockForkRunChat = vi.mocked(forkRunChat);
const mockScheduleChatPrompt = vi.mocked(scheduleChatPrompt);

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function createChat(overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
	return {
		id: 'chat-1',
		projectPath: '/workspace/project',
		effectiveProjectKey: '/workspace/project',
		projectIdentityState: 'available',
		orderGroup: 'normal',
		title: 'Chat',
		agentId: 'claude',
		model: 'sonnet',
		apiProviderId: null,
		modelEndpointId: null,
		modelProtocol: null,
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
		status: 'running',
		tags: [],
		...overrides,
	};
}

function createServerEntry(id: string) {
	return {
		id,
		agentId: 'claude',
		model: 'sonnet',
		permissionMode: 'default' as const,
		thinkingMode: 'none' as const,
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
		title: 'Forked chat',
		projectPath: '/workspace/project',
		effectiveProjectKey: '/workspace/project',
		orderGroup: 'normal' as const,
		tags: [],
		activity: { createdAt: null, lastActivityAt: null, lastReadAt: null },
		preview: { lastMessage: '' },
		isPinned: false,
		isArchived: false,
		isActive: false,
		isProcessing: false,
		processingPhase: null,
		isUnread: false,
	};
}

function createDeps(chat = createChat()) {
	const cursor = { generationId: 'generation-1', lastSeq: 9 };
	let inputText = 'original command';
	let images: File[] = [];
	let contentRevision = 0;
	const composerState: ConversationSlashCommandDeps['composerState'] = {
		get inputText() {
			return inputText;
		},
		set inputText(value: string) {
			inputText = value;
			contentRevision += 1;
		},
		get images() {
			return images;
		},
		set images(value: File[]) {
			images = value;
			contentRevision += 1;
		},
		get contentRevision() {
			return contentRevision;
		},
		clearAfterSubmit: vi.fn(() => {
			inputText = '';
			images = [];
			contentRevision += 2;
		}),
		saveDraft: vi.fn(),
	};
	const appendLocalNotice = vi.fn();
	const sessions = {
		selectedChatId: chat.id,
		byId: { [chat.id]: chat },
		renameChat: vi.fn().mockResolvedValue(true),
		moveChatToBoundary: vi.fn().mockResolvedValue({
			success: true,
			chatId: chat.id,
			orderGroup: 'normal',
			changed: true,
		}),
		setChatTags: vi.fn(async (chatId: string, tags: string[]) => {
			const current = sessions.byId[chatId];
			if (!current) return false;
			sessions.byId[chatId] = { ...current, tags };
			return true;
		}),
		upsertServerChat: vi.fn(),
		setSelectedChatId: vi.fn(),
	};
	const deps = {
		sessions,
		chatState: {
			activeChatId: chat.id,
			entries: [{
				seq: 9,
				message: new AssistantMessage('2026-07-29T00:00:00.000Z', 'selected reply'),
			}],
			isUserScrolledUp: true,
			getCursor: vi.fn(() => cursor),
			appendLocalNotice,
		},
		composerState,
		agentState: { model: 'sonnet' },
		lifecycle: {
			beginTurn: vi.fn(),
			setCurrentChatId: vi.fn(),
		},
		modelCatalog: {
			selectionFor: vi.fn((_agentId, model) => ({
				model,
				apiProviderId: null,
				modelEndpointId: null,
				modelProtocol: null,
			})),
			supportsFork: vi.fn(() => false),
			supportsForkWhileRunning: vi.fn(() => false),
			supportsSteering: vi.fn(() => false),
			supportsGoals: vi.fn(() => false),
		},
		navigation: { navigateToChat: vi.fn() },
		refetchTranscript: vi.fn().mockResolvedValue(undefined),
		scrollToBottom: vi.fn(),
	} satisfies ConversationSlashCommandDeps;
	return { deps, composerState, appendLocalNotice, cursor };
}

describe('ConversationSlashCommandService', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('routes supported steering before queue policy despite a stale processing projection', () => {
		const { deps } = createDeps(createChat({
			agentId: 'codex',
			isProcessing: false,
		}));
		deps.modelCatalog.supportsSteering.mockReturnValue(true);

		const result = new ConversationSlashCommandService(deps).dispatchSubmission({
			chatId: 'chat-1',
			chat: deps.sessions.byId['chat-1'],
			text: '/steer Focus on the failing assertion',
			images: [],
			ownsComposer: true,
		});

		expect(result).toEqual({ kind: 'steer', content: 'Focus on the failing assertion' });
	});

	it('rejects steering when the capability is absent or attachments are present', () => {
		const { deps, appendLocalNotice } = createDeps(createChat({ agentId: 'codex' }));
		const service = new ConversationSlashCommandService(deps);
		const input = {
			chatId: 'chat-1',
			chat: deps.sessions.byId['chat-1'],
			text: '/steer Focus here',
			images: [] as File[],
			ownsComposer: true,
		};

		expect(service.dispatchSubmission(input)).toEqual({ kind: 'handled', outcome: 'rejected' });
		expect(appendLocalNotice).toHaveBeenLastCalledWith(
			'error',
			'/steer is not supported by this agent.',
		);

		deps.modelCatalog.supportsSteering.mockReturnValue(true);
		input.images = [new File(['image'], 'capture.png', { type: 'image/png' })];
		expect(service.dispatchSubmission(input)).toEqual({ kind: 'handled', outcome: 'rejected' });
		expect(appendLocalNotice).toHaveBeenLastCalledWith(
			'error',
			'Remove attachments before steering the active turn.',
		);
	});

	it('keeps active goal controls distinct from ordinary goal submissions', () => {
		const chat = createChat({ agentId: 'codex', isProcessing: true });
		const { deps } = createDeps(chat);
		deps.modelCatalog.supportsGoals.mockReturnValue(true);
		const service = new ConversationSlashCommandService(deps);
		const input = {
			chatId: 'chat-1',
			chat,
			text: '/goal pause',
			images: [],
			ownsComposer: true,
		};

		expect(service.dispatchSubmission(input)).toEqual({
			kind: 'goal-control',
			content: '/goal pause',
		});

		chat.isProcessing = false;
		expect(service.dispatchSubmission(input)).toEqual({
			kind: 'continue',
			content: '/goal pause',
		});
	});

	it('restores rename text and attachments when rename fails', async () => {
		const { deps, composerState } = createDeps();
		const image = new File(['image'], 'test.png', { type: 'image/png' });
		composerState.images = [image];
		deps.sessions.renameChat.mockResolvedValueOnce(false);

		await new ConversationSlashCommandService(deps).submitRenameCommand(
			'chat-1',
			deps.sessions.byId['chat-1'],
			'Renamed chat',
			[],
			true,
		);

		expect(composerState.inputText).toBe('original command');
		expect(composerState.images).toEqual([image]);
		expect(composerState.saveDraft).toHaveBeenCalledWith('chat-1');
	});

	it('does not overwrite text entered while a failed rename is pending', async () => {
		const { deps, composerState } = createDeps();
		const pending = deferred<boolean>();
		deps.sessions.renameChat.mockReturnValueOnce(pending.promise);
		const submission = new ConversationSlashCommandService(deps).submitRenameCommand(
			'chat-1',
			deps.sessions.byId['chat-1'],
			'Renamed chat',
			[],
			true,
		);
		composerState.inputText = 'replacement draft';

		pending.resolve(false);
		await expect(submission).resolves.toBe('rejected');

		expect(composerState.inputText).toBe('replacement draft');
		expect(composerState.saveDraft).not.toHaveBeenCalled();
	});

	it('does not restore a failed rename after a type-delete cycle', async () => {
		const { deps, composerState } = createDeps();
		const pending = deferred<boolean>();
		deps.sessions.renameChat.mockReturnValueOnce(pending.promise);
		const submission = new ConversationSlashCommandService(deps).submitRenameCommand(
			'chat-1',
			deps.sessions.byId['chat-1'],
			'Renamed chat',
			[],
			true,
		);
		composerState.inputText = 'temporary draft';
		composerState.inputText = '';

		pending.resolve(false);
		await expect(submission).resolves.toBe('rejected');

		expect(composerState.inputText).toBe('');
		expect(composerState.saveDraft).not.toHaveBeenCalled();
	});

	it('does not restore a failed rename after switching chats', async () => {
		const { deps, composerState } = createDeps();
		const pending = deferred<boolean>();
		deps.sessions.renameChat.mockReturnValueOnce(pending.promise);
		const submission = new ConversationSlashCommandService(deps).submitRenameCommand(
			'chat-1',
			deps.sessions.byId['chat-1'],
			'Renamed chat',
			[],
			true,
		);
		deps.sessions.selectedChatId = 'chat-2';

		pending.resolve(false);
		await expect(submission).resolves.toBe('rejected');

		expect(composerState.inputText).toBe('');
		expect(composerState.saveDraft).not.toHaveBeenCalled();
	});

	it('claims a busy move command, clears immediately, and appends its source notice', async () => {
		const chat = createChat({ isProcessing: true, processingPhase: 'running' });
		const { deps, composerState, appendLocalNotice } = createDeps(chat);
		composerState.inputText = '/move top';
		const pending = deferred<Awaited<ReturnType<typeof deps.sessions.moveChatToBoundary>>>();
		deps.sessions.moveChatToBoundary.mockReturnValueOnce(pending.promise);

		const dispatch = new ConversationSlashCommandService(deps).dispatchSubmission({
			chatId: chat.id,
			chat,
			text: '/move top',
			images: [],
			ownsComposer: true,
		});

		expect(dispatch.kind).toBe('handled');
		expect(composerState.clearAfterSubmit).toHaveBeenCalledWith(chat.id);
		expect(composerState.inputText).toBe('');
		expect(deps.sessions.moveChatToBoundary).toHaveBeenCalledWith(chat.id, 'top');
		pending.resolve({ success: true, chatId: chat.id, orderGroup: 'normal', changed: true });
		if (dispatch.kind !== 'handled') throw new Error('move command was not handled');
		await expect(dispatch.outcome).resolves.toBe('accepted');

		expect(appendLocalNotice).toHaveBeenCalledWith(
			'info',
			'Moved this chat to the top of its section in Manual order.',
		);
		expect(deps.chatState.isUserScrolledUp).toBe(false);
		expect(deps.scrollToBottom).toHaveBeenCalledOnce();
		expect(mockScheduleChatPrompt).not.toHaveBeenCalled();
	});

	it('reports an unchanged bottom boundary without sending the command onward', async () => {
		const { deps, appendLocalNotice } = createDeps();
		deps.sessions.moveChatToBoundary.mockResolvedValueOnce({
			success: true,
			chatId: 'chat-1',
			orderGroup: 'archived',
			changed: false,
		});

		const dispatch = new ConversationSlashCommandService(deps).dispatchSubmission({
			chatId: 'chat-1',
			chat: deps.sessions.byId['chat-1'],
			text: '/MOVE BOTTOM ',
			images: [],
			ownsComposer: true,
		});

		expect(dispatch.kind).toBe('handled');
		if (dispatch.kind !== 'handled') throw new Error('move command was not handled');
		await expect(dispatch.outcome).resolves.toBe('accepted');
		expect(appendLocalNotice).toHaveBeenCalledWith(
			'info',
			'This chat is already at the bottom of its section in Manual order.',
		);
	});

	it('rejects move arguments, drafts, and attachments before clearing or mutating', async () => {
		for (const input of [
			{ text: '/move top later', chat: createChat(), images: [] },
			{ text: '/move top', chat: createChat({ status: 'draft' }), images: [] },
			{
				text: '/move bottom',
				chat: createChat(),
				images: [new File(['image'], 'test.png', { type: 'image/png' })],
			},
		]) {
			const { deps, composerState } = createDeps(input.chat);
			const dispatch = new ConversationSlashCommandService(deps).dispatchSubmission({
				chatId: input.chat.id,
				chat: input.chat,
				text: input.text,
				images: input.images,
				ownsComposer: true,
			});

			expect(dispatch.kind).toBe('handled');
			if (dispatch.kind !== 'handled') throw new Error('move command was not handled');
			await expect(dispatch.outcome).resolves.toBe('rejected');
			expect(composerState.clearAfterSubmit).not.toHaveBeenCalled();
			expect(deps.sessions.moveChatToBoundary).not.toHaveBeenCalled();
		}
	});

	it('restores a failed move only while the source composer remains untouched', async () => {
		const { deps, composerState } = createDeps();
		composerState.inputText = '/move top';
		deps.sessions.moveChatToBoundary.mockResolvedValueOnce(null);

		const result = await new ConversationSlashCommandService(deps).submitMoveChatBoundaryCommand(
			'chat-1',
			deps.sessions.byId['chat-1'],
			{ kind: 'valid', boundary: 'top' },
			[],
			true,
		);

		expect(result).toBe('rejected');
		expect(composerState.inputText).toBe('/move top');
		expect(composerState.saveDraft).toHaveBeenCalledWith('chat-1');
	});

	it('does not restore a failed move over newly entered text', async () => {
		const { deps, composerState } = createDeps();
		composerState.inputText = '/move top';
		const pending = deferred<null>();
		deps.sessions.moveChatToBoundary.mockReturnValueOnce(pending.promise);
		const submission = new ConversationSlashCommandService(deps).submitMoveChatBoundaryCommand(
			'chat-1',
			deps.sessions.byId['chat-1'],
			{ kind: 'valid', boundary: 'top' },
			[],
			true,
		);
		composerState.inputText = 'new draft';

		pending.resolve(null);
		await submission;

		expect(composerState.inputText).toBe('new draft');
		expect(composerState.saveDraft).not.toHaveBeenCalled();
	});

	it('does not restore an older failed command after a newer submission clears the composer', async () => {
		const { deps, composerState } = createDeps();
		const first = deferred<Awaited<ReturnType<typeof deps.sessions.moveChatToBoundary>>>();
		const second = deferred<Awaited<ReturnType<typeof deps.sessions.moveChatToBoundary>>>();
		deps.sessions.moveChatToBoundary
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const service = new ConversationSlashCommandService(deps);

		composerState.inputText = '/move top';
		const firstSubmission = service.submitMoveChatBoundaryCommand(
			'chat-1',
			deps.sessions.byId['chat-1'],
			{ kind: 'valid', boundary: 'top' },
			[],
			true,
		);
		composerState.inputText = '/move bottom';
		const secondSubmission = service.submitMoveChatBoundaryCommand(
			'chat-1',
			deps.sessions.byId['chat-1'],
			{ kind: 'valid', boundary: 'bottom' },
			[],
			true,
		);

		first.resolve(null);
		await expect(firstSubmission).resolves.toBe('rejected');
		expect(composerState.inputText).toBe('');
		expect(composerState.saveDraft).not.toHaveBeenCalled();

		second.resolve({ success: true, chatId: 'chat-1', orderGroup: 'normal', changed: true });
		await expect(secondSubmission).resolves.toBe('accepted');
		expect(composerState.inputText).toBe('');
	});

	it('does not restore or append a notice after switching away from the source chat', async () => {
		const { deps, composerState, appendLocalNotice } = createDeps();
		composerState.inputText = '/move bottom';
		const pending = deferred<Awaited<ReturnType<typeof deps.sessions.moveChatToBoundary>>>();
		deps.sessions.moveChatToBoundary.mockReturnValueOnce(pending.promise);
		const service = new ConversationSlashCommandService(deps);
		const submission = service.submitMoveChatBoundaryCommand(
			'chat-1',
			deps.sessions.byId['chat-1'],
			{ kind: 'valid', boundary: 'bottom' },
			[],
			true,
		);
		deps.sessions.selectedChatId = 'chat-2';
		deps.chatState.activeChatId = 'chat-2';

		pending.resolve({ success: true, chatId: 'chat-1', orderGroup: 'normal', changed: true });
		await expect(submission).resolves.toBe('accepted');

		expect(appendLocalNotice).not.toHaveBeenCalled();
		expect(deps.scrollToBottom).not.toHaveBeenCalled();
		expect(composerState.inputText).toBe('');
	});

	it('does not clear or restore a composer the source submission does not own', async () => {
		const { deps, composerState } = createDeps();
		composerState.inputText = 'other chat draft';
		deps.sessions.moveChatToBoundary.mockResolvedValueOnce(null);

		await new ConversationSlashCommandService(deps).submitMoveChatBoundaryCommand(
			'chat-1',
			deps.sessions.byId['chat-1'],
			{ kind: 'valid', boundary: 'top' },
			[],
			false,
		);

		expect(composerState.inputText).toBe('other chat draft');
		expect(composerState.clearAfterSubmit).not.toHaveBeenCalled();
		expect(composerState.saveDraft).not.toHaveBeenCalled();
	});

	it('adds normalized unique tags without resending existing tags', async () => {
		const chat = createChat({ tags: ['existing', 'review'] });
		const { deps, composerState, appendLocalNotice } = createDeps(chat);
		composerState.inputText = '/tag add existing Urgent urgent';

		const dispatch = new ConversationSlashCommandService(deps).dispatchSubmission({
			chatId: chat.id,
			chat,
			text: composerState.inputText,
			images: [],
			ownsComposer: true,
		});

		expect(dispatch.kind).toBe('handled');
		if (dispatch.kind !== 'handled') throw new Error('tag command was not handled');
		await expect(dispatch.outcome).resolves.toBe('accepted');
		expect(deps.sessions.setChatTags).toHaveBeenCalledWith(chat.id, [
			'existing',
			'review',
			'urgent',
		]);
		expect(appendLocalNotice).toHaveBeenCalledWith('info', 'Added tags: urgent.');
		expect(composerState.inputText).toBe('');
	});

	it('accepts adding only existing tags without issuing a mutation', async () => {
		const chat = createChat({ tags: ['existing'] });
		const { deps, appendLocalNotice } = createDeps(chat);

		const result = await new ConversationSlashCommandService(deps).submitTagCommand(
			chat.id,
			chat,
			{ kind: 'valid', action: 'add', tags: ['existing'] },
			[],
			true,
		);

		expect(result).toBe('accepted');
		expect(deps.sessions.setChatTags).not.toHaveBeenCalled();
		expect(appendLocalNotice).toHaveBeenCalledWith('info', 'Tags are already up to date.');
	});

	it('serializes overlapping tag additions and rebases the second mutation', async () => {
		const chat = createChat();
		const { deps, composerState, appendLocalNotice } = createDeps(chat);
		const first = deferred<boolean>();
		deps.sessions.setChatTags
			.mockImplementationOnce(async (chatId, tags) => {
				const updated = await first.promise;
				if (updated) deps.sessions.byId[chatId] = { ...deps.sessions.byId[chatId], tags };
				return updated;
			})
			.mockImplementationOnce(async (chatId, tags) => {
				deps.sessions.byId[chatId] = { ...deps.sessions.byId[chatId], tags };
				return true;
			});
		const service = new ConversationSlashCommandService(deps);

		composerState.inputText = '/tag add alpha';
		const addAlpha = service.submitTagCommand(
			chat.id,
			chat,
			{ kind: 'valid', action: 'add', tags: ['alpha'] },
			[],
			true,
		);
		composerState.inputText = '/tag add beta';
		const addBeta = service.submitTagCommand(
			chat.id,
			chat,
			{ kind: 'valid', action: 'add', tags: ['beta'] },
			[],
			true,
		);

		await Promise.resolve();
		expect(deps.sessions.setChatTags).toHaveBeenCalledTimes(1);
		first.resolve(true);
		await expect(Promise.all([addAlpha, addBeta])).resolves.toEqual(['accepted', 'accepted']);
		expect(deps.sessions.setChatTags).toHaveBeenNthCalledWith(2, chat.id, ['alpha', 'beta']);
		expect(deps.sessions.byId[chat.id].tags).toEqual(['alpha', 'beta']);
		expect(appendLocalNotice).toHaveBeenCalledWith('info', 'Added tags: alpha.');
		expect(appendLocalNotice).toHaveBeenCalledWith('info', 'Added tags: beta.');
	});

	it('rebases a queued tag removal after an overlapping addition', async () => {
		const chat = createChat({ tags: ['existing'] });
		const { deps } = createDeps(chat);
		const first = deferred<boolean>();
		deps.sessions.setChatTags
			.mockImplementationOnce(async (chatId, tags) => {
				const updated = await first.promise;
				if (updated) deps.sessions.byId[chatId] = { ...deps.sessions.byId[chatId], tags };
				return updated;
			})
			.mockImplementationOnce(async (chatId, tags) => {
				deps.sessions.byId[chatId] = { ...deps.sessions.byId[chatId], tags };
				return true;
			});
		const service = new ConversationSlashCommandService(deps);

		const addition = service.submitTagCommand(
			chat.id,
			chat,
			{ kind: 'valid', action: 'add', tags: ['urgent'] },
			[],
			true,
		);
		const removal = service.submitTagCommand(
			chat.id,
			chat,
			{ kind: 'valid', action: 'rm', tags: ['existing'] },
			[],
			true,
		);

		first.resolve(true);
		await expect(Promise.all([addition, removal])).resolves.toEqual(['accepted', 'accepted']);
		expect(deps.sessions.setChatTags).toHaveBeenNthCalledWith(2, chat.id, ['urgent']);
		expect(deps.sessions.byId[chat.id].tags).toEqual(['urgent']);
	});

	it('continues a queued tag mutation after the preceding mutation fails', async () => {
		const chat = createChat();
		const { deps, composerState } = createDeps(chat);
		const first = deferred<boolean>();
		deps.sessions.setChatTags.mockImplementationOnce(() => first.promise);
		const service = new ConversationSlashCommandService(deps);

		composerState.inputText = '/tag add alpha';
		const addAlpha = service.submitTagCommand(
			chat.id,
			chat,
			{ kind: 'valid', action: 'add', tags: ['alpha'] },
			[],
			true,
		);
		composerState.inputText = '/tag add beta';
		const addBeta = service.submitTagCommand(
			chat.id,
			chat,
			{ kind: 'valid', action: 'add', tags: ['beta'] },
			[],
			true,
		);

		first.resolve(false);
		await expect(Promise.all([addAlpha, addBeta])).resolves.toEqual(['rejected', 'accepted']);
		expect(deps.sessions.setChatTags).toHaveBeenNthCalledWith(2, chat.id, ['beta']);
		expect(deps.sessions.byId[chat.id].tags).toEqual(['beta']);
		expect(composerState.inputText).toBe('');
		expect(composerState.saveDraft).not.toHaveBeenCalled();
	});

	it('removes existing tags and ignores requested tags that are absent', async () => {
		const chat = createChat({ tags: ['existing', 'urgent'] });
		const { deps, appendLocalNotice } = createDeps(chat);

		const result = await new ConversationSlashCommandService(deps).submitTagCommand(
			chat.id,
			chat,
			{ kind: 'valid', action: 'rm', tags: ['existing', 'missing'] },
			[],
			true,
		);

		expect(result).toBe('accepted');
		expect(deps.sessions.setChatTags).toHaveBeenCalledWith(chat.id, ['urgent']);
		expect(appendLocalNotice).toHaveBeenCalledWith('info', 'Removed tags: existing.');
	});

	it('accepts removing only absent tags without issuing a mutation', async () => {
		const chat = createChat({ tags: ['existing'] });
		const { deps, appendLocalNotice } = createDeps(chat);

		const result = await new ConversationSlashCommandService(deps).submitTagCommand(
			chat.id,
			chat,
			{ kind: 'valid', action: 'rm', tags: ['missing'] },
			[],
			true,
		);

		expect(result).toBe('accepted');
		expect(deps.sessions.setChatTags).not.toHaveBeenCalled();
		expect(appendLocalNotice).toHaveBeenCalledWith('info', 'Tags are already up to date.');
	});

	it('rejects invalid tag syntax and attachments before clearing or mutating', async () => {
		for (const input of [
			{ text: '/tag add', images: [] },
			{
				text: '/tag add urgent',
				images: [new File(['image'], 'test.png', { type: 'image/png' })],
			},
		]) {
			const { deps, composerState } = createDeps();
			const dispatch = new ConversationSlashCommandService(deps).dispatchSubmission({
				chatId: 'chat-1',
				chat: deps.sessions.byId['chat-1'],
				text: input.text,
				images: input.images,
				ownsComposer: true,
			});

			expect(dispatch.kind).toBe('handled');
			if (dispatch.kind !== 'handled') throw new Error('tag command was not handled');
			await expect(dispatch.outcome).resolves.toBe('rejected');
			expect(composerState.clearAfterSubmit).not.toHaveBeenCalled();
			expect(deps.sessions.setChatTags).not.toHaveBeenCalled();
		}
	});

	it('restores a failed tag command while its composer remains untouched', async () => {
		const chat = createChat({ tags: ['existing'] });
		const { deps, composerState } = createDeps(chat);
		composerState.inputText = '/tag add urgent';
		deps.sessions.setChatTags.mockResolvedValueOnce(false);

		const result = await new ConversationSlashCommandService(deps).submitTagCommand(
			chat.id,
			chat,
			{ kind: 'valid', action: 'add', tags: ['urgent'] },
			[],
			true,
		);

		expect(result).toBe('rejected');
		expect(composerState.inputText).toBe('/tag add urgent');
		expect(composerState.saveDraft).toHaveBeenCalledWith(chat.id);
	});

	it('leaves a similar slash token for ordinary submission', () => {
		const { deps } = createDeps();

		expect(
			new ConversationSlashCommandService(deps).dispatchSubmission({
				chatId: 'chat-1',
				chat: deps.sessions.byId['chat-1'],
				text: '/move-to-top',
				images: [],
				ownsComposer: true,
			}),
		).toEqual({
			kind: 'continue',
			content: '/move-to-top',
		});
	});

	it('deduplicates an in-flight schedule and restores a failed command', async () => {
		const { deps, composerState, appendLocalNotice } = createDeps();
		const pending = deferred<Awaited<ReturnType<typeof scheduleChatPrompt>>>();
		mockScheduleChatPrompt.mockReturnValueOnce(pending.promise);
		const service = new ConversationSlashCommandService(deps);
		const command = {
			kind: 'valid',
			duration: '1m',
			delayMinutes: 1,
			prompt: 'Continue',
		} as const;

		const first = service.submitScheduleInCommand(
			'chat-1',
			deps.sessions.byId['chat-1'],
			command,
			[],
			true,
		);
		const second = service.submitScheduleInCommand(
			'chat-1',
			deps.sessions.byId['chat-1'],
			command,
			[],
			true,
		);

		expect(mockScheduleChatPrompt).toHaveBeenCalledTimes(1);
		pending.reject(new Error('storage unavailable'));
		await Promise.all([first, second]);
		expect(composerState.inputText).toBe('original command');
		expect(composerState.saveDraft).toHaveBeenCalledWith('chat-1');
		expect(appendLocalNotice).toHaveBeenCalledWith(
			'error',
			expect.stringContaining('storage unavailable'),
		);
	});

	it('reports a successful schedule only in its still-active chat', async () => {
		const { deps, appendLocalNotice } = createDeps();
		mockScheduleChatPrompt.mockResolvedValueOnce({
			success: true,
			scheduledPrompt: {
				id: 'prompt-1',
				schedule: { type: 'once', nextRunAt: '2030-01-01T09:00:00.000Z' },
				target: { type: 'existing-chat', chatId: 'chat-1', busyBehavior: 'skip' },
				prompt: 'Continue',
				createdAt: '2029-01-01T00:00:00.000Z',
				updatedAt: '2029-01-01T00:00:00.000Z',
			},
			snapshot: { revision: 1, prompts: [], runLog: [] },
		});

		await new ConversationSlashCommandService(deps).submitScheduleInCommand(
			'chat-1',
			deps.sessions.byId['chat-1'],
			{ kind: 'valid', duration: '1m', delayMinutes: 1, prompt: 'Continue' },
			[],
			true,
		);

		expect(appendLocalNotice).toHaveBeenCalledWith(
			'info',
			expect.stringContaining('Prompt scheduled for'),
		);
		expect(deps.chatState.isUserScrolledUp).toBe(false);
		expect(deps.scrollToBottom).toHaveBeenCalled();
	});

	it('restores compact text when the API fails', async () => {
		const { deps, composerState, appendLocalNotice } = createDeps();
		mockCompactChat.mockRejectedValueOnce(new Error('compact unavailable'));

		await new ConversationSlashCommandService(deps).submitCompactCommand(
			'chat-1',
			deps.sessions.byId['chat-1'],
			'keep decisions',
			true,
		);

		expect(composerState.inputText).toBe('original command');
		expect(composerState.saveDraft).toHaveBeenCalledWith('chat-1');
		expect(appendLocalNotice).toHaveBeenCalledWith(
			'error',
			expect.stringContaining('compact unavailable'),
		);
	});

	it('forks and runs while selecting the projected server chat before beginning the turn', async () => {
		const { deps } = createDeps();
		const forked = createServerEntry('chat-2');
		mockForkRunChat.mockResolvedValueOnce({
			success: true,
			commandType: 'fork-run',
			clientRequestId: 'request-1',
			chatId: 'chat-2',
			turnId: 'turn-1',
			status: 'accepted',
			acceptedAt: '2026-07-14T00:00:00.000Z',
			chat: forked,
		});

		await new ConversationSlashCommandService(deps).submitForkCommand(
			'chat-1',
			deps.sessions.byId['chat-1'],
			'continue here',
			[],
			true,
		);

		expect(mockForkRunChat).toHaveBeenCalledWith(
			expect.objectContaining({ sourceChatId: 'chat-1', command: 'continue here' }),
		);
		expect(deps.sessions.upsertServerChat).toHaveBeenCalledWith(forked);
		expect(deps.sessions.setSelectedChatId).toHaveBeenCalledWith('chat-2');
		expect(deps.navigation.navigateToChat).toHaveBeenCalledWith('chat-2');
		expect(deps.lifecycle.beginTurn).toHaveBeenCalledWith('chat-2');
	});

	it('retries an ambiguous fork response with the same command identity', async () => {
		const { deps } = createDeps();
		const forked = createServerEntry('chat-2');
		mockForkRunChat
			.mockRejectedValueOnce(new TypeError('connection closed'))
			.mockResolvedValueOnce({
				success: true,
				commandType: 'fork-run',
				clientRequestId: 'request-1',
				chatId: 'chat-2',
				turnId: 'turn-1',
				status: 'duplicate',
				acceptedAt: '2026-07-14T00:00:00.000Z',
				chat: forked,
			});

		await new ConversationSlashCommandService(deps).submitForkCommand(
			'chat-1',
			deps.sessions.byId['chat-1'],
			'continue here',
			[],
			true,
		);

		expect(mockForkRunChat).toHaveBeenCalledTimes(2);
		expect(mockForkRunChat.mock.calls[1][0]).toEqual(mockForkRunChat.mock.calls[0][0]);
		expect(deps.sessions.setSelectedChatId).toHaveBeenCalledWith('chat-2');
	});

	it('does not restore a fork prompt after two ambiguous outcomes', async () => {
		const { deps, composerState, appendLocalNotice } = createDeps();
		mockForkRunChat.mockRejectedValue(new TypeError('connection closed'));

		await new ConversationSlashCommandService(deps).submitForkCommand(
			'chat-1',
			deps.sessions.byId['chat-1'],
			'continue here',
			[],
			true,
		);

		expect(mockForkRunChat).toHaveBeenCalledTimes(2);
		expect(mockForkRunChat.mock.calls[1][0]).toEqual(mockForkRunChat.mock.calls[0][0]);
		expect(composerState.inputText).toBe('');
		expect(composerState.saveDraft).not.toHaveBeenCalled();
		expect(appendLocalNotice).toHaveBeenCalledWith(
			'error',
			'Could not confirm whether the fork was created. Check the chat list before trying again.',
		);
	});

	it('forks without a message and preserves the requested sequence', async () => {
		const { deps } = createDeps();
		const forked = createServerEntry('chat-2');
		mockForkChat.mockResolvedValueOnce({ success: true, chat: forked });

		await new ConversationSlashCommandService(deps).forkChat('chat-1', 9);

		expect(mockForkChat).toHaveBeenCalledWith({
			sourceChatId: 'chat-1',
			chatId: expect.stringMatching(/^\d+$/),
			upToSeq: 9,
			generationId: 'generation-1',
		});
		expect(deps.sessions.upsertServerChat).toHaveBeenCalledWith(forked);
		expect(deps.lifecycle.setCurrentChatId).toHaveBeenCalledWith('chat-2');
		expect(deps.sessions.setSelectedChatId).toHaveBeenCalledWith('chat-2');
	});

	it('refetches, remaps, and retries a stale fork point once', async () => {
		const { deps, cursor, appendLocalNotice } = createDeps();
		const forked = createServerEntry('chat-2');
		mockForkChat
			.mockRejectedValueOnce(new ApiError(
				409,
				'The view changed',
				'STALE_VIEW_GENERATION',
				undefined,
				true,
			))
			.mockResolvedValueOnce({ success: true, chat: forked });
		deps.refetchTranscript.mockImplementationOnce(async () => {
			cursor.generationId = 'generation-2';
			cursor.lastSeq = 12;
			deps.chatState.entries = [{
				seq: 12,
				message: new AssistantMessage('2026-07-29T01:00:00.000Z', 'selected reply'),
			}];
		});

		await new ConversationSlashCommandService(deps).forkChat('chat-1', 9);

		expect(mockForkChat).toHaveBeenCalledTimes(2);
		expect(mockForkChat.mock.calls[0]?.[0]).toMatchObject({
			upToSeq: 9,
			generationId: 'generation-1',
		});
		expect(mockForkChat.mock.calls[1]?.[0]).toMatchObject({
			chatId: mockForkChat.mock.calls[0]?.[0].chatId,
			upToSeq: 12,
			generationId: 'generation-2',
		});
		expect(deps.refetchTranscript).toHaveBeenCalledWith('chat-1');
		expect(appendLocalNotice).not.toHaveBeenCalled();
		expect(deps.sessions.setSelectedChatId).toHaveBeenCalledWith('chat-2');
	});

	it('preserves the stale fork error when the view refetch fails', async () => {
		const { deps, appendLocalNotice } = createDeps();
		mockForkChat.mockRejectedValueOnce(new ApiError(
			409,
			'The original stale view',
			'STALE_VIEW_GENERATION',
			undefined,
			true,
		));
		deps.refetchTranscript.mockRejectedValueOnce(new ApiError(
			409,
			'Chat is running',
			'CHAT_RUNNING',
			undefined,
			true,
		));

		await new ConversationSlashCommandService(deps).forkChat('chat-1', 9);

		expect(mockForkChat).toHaveBeenCalledTimes(1);
		expect(deps.refetchTranscript).toHaveBeenCalledWith('chat-1');
		expect(appendLocalNotice).toHaveBeenCalledWith(
			'error',
			'Failed to fork chat: The original stale view',
		);
	});

	it('shows the native-history notice without attempting recovery', async () => {
		const { deps, appendLocalNotice } = createDeps();
		mockForkChat.mockRejectedValueOnce(new ApiError(
			409,
			'The message is not persisted',
			'MESSAGE_NOT_IN_NATIVE_HISTORY',
			undefined,
			true,
		));

		await new ConversationSlashCommandService(deps).forkChat('chat-1', 9);

		expect(mockForkChat).toHaveBeenCalledTimes(1);
		expect(deps.refetchTranscript).not.toHaveBeenCalled();
		expect(appendLocalNotice).toHaveBeenCalledWith(
			'error',
			"This message hasn't been written to the provider's transcript yet. It becomes forkable once the turn finishes.",
		);
	});
});
