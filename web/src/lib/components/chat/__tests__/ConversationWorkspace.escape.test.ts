import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ConversationWorkspaceEscapeHost from './ConversationWorkspaceEscapeHost.svelte';
import {
	createQueuedInput,
	getChatExecutionControl,
	getChatMessages,
	runChat,
	stopChat,
} from '$lib/api/chats.js';
import { getGitRefs, type GitQuickSummaryReady } from '$lib/api/git.js';
import { ToolResultMessage } from '$shared/chat-types';
import type { TranscriptMessage } from '$shared/chat-view';
import type { ProjectResolutionResponse, ProjectTarget } from '$shared/project-resolution';
import { CommitController } from '$lib/git/commit/commit-controller.svelte.js';
import { GitQuickSummaryStore } from '$lib/git/surface/git-quick-summary.svelte.js';
import { createGitSurfaceTestDeps } from '$lib/git/__tests__/git-surface-test-deps.js';
import { createNotificationsStore } from '$lib/stores/notifications.svelte.js';
import { ConversationSessionController } from '$lib/chat/conversation/conversation-session-controller.svelte.js';
import { mountConversationRouter } from '$lib/chat/conversation/conversation-router-adapter.svelte.js';
import { playCompletionSound } from '$lib/notifications/completion-sound.js';
import type { ChatDraftAppend } from '$lib/chat/composer/chat-draft-append.js';
import type {
	AgentTurnCommandResponse,
	QueueEntryCommandResponse,
} from '$shared/chat-command-contracts';
import { emptyChatQueueState, type ChatQueueState } from '$shared/queue-state';
import { CommandOutcomeUnknownError } from '$lib/chat/conversation/idempotent-command.js';

vi.mock('$lib/notifications/completion-sound.js', () => ({ playCompletionSound: vi.fn() }));

type BackgroundMessagesHandler = (
	chatId: string,
	transcriptViewId: string,
	messages: TranscriptMessage[],
	firstOrdinal: number,
	lastOrdinal: number,
) => boolean;

const reconnectHarness = vi.hoisted(() => ({
	onBackgroundMessages: null as BackgroundMessagesHandler | null,
}));

vi.mock('$lib/api/chats.js', () => ({
	compactChat: vi.fn(),
	createQueuedInput: vi.fn(),
	deleteQueuedInput: vi.fn(),
	forkChat: vi.fn(),
	forkRunChat: vi.fn(),
	selfHandoffRunChat: vi.fn(),
	getChatMessages: vi.fn(),
	getChatExecutionControl: vi.fn(),
	interruptAndSendChat: vi.fn(),
	pauseChatQueue: vi.fn(),
	resumeChatQueue: vi.fn(),
	runChat: vi.fn(),
	steerChat: vi.fn(),
	steerQueuedEntry: vi.fn(),
	sendPermissionDecision: vi.fn(),
	startChat: vi.fn(),
	stopChat: vi.fn(),
	replaceQueuedInput: vi.fn(),
	updateChatModel: vi.fn(),
	updateExecutionSettings: vi.fn(),
}));

vi.mock('$lib/api/git.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/api/git.js')>();
	return { ...actual, getGitRefs: vi.fn() };
});

vi.mock('$lib/chat/conversation/conversation-router-adapter.svelte.js', () => ({
	mountConversationRouter: vi.fn(),
}));

vi.mock('$lib/ws/reconnect-coordinator.svelte', () => ({
	ChatReconnectCoordinator: class {
		constructor(options: { onBackgroundMessages: BackgroundMessagesHandler }) {
			reconnectHarness.onBackgroundMessages = options.onBackgroundMessages;
		}

		mount(): void {}
	},
}));

vi.mock('$lib/components/chat/transcript/ConversationFeed.svelte', async () => ({
	default: (await import('../transcript/__tests__/ConversationFeedStub.svelte')).default,
}));

vi.mock('$lib/components/chat/composer/PromptComposer.svelte', async () => ({
	default: (await import('../composer/__tests__/PromptComposerStub.svelte')).default,
}));

vi.mock('$lib/components/git/NewBranchModal.svelte', async () => ({
	default: (await import('./GenericStub.svelte')).default,
}));

vi.mock('$lib/components/chat/queue/QueueControls.svelte', async () => ({
	default: (await import('../queue/__tests__/QueueControlsCapabilityStub.svelte')).default,
}));

vi.mock('$lib/components/chat/queue/QueuedInputEditorDialog.svelte', async () => ({
	default: (await import('./GenericStub.svelte')).default,
}));

const mockGetChatMessages = vi.mocked(getChatMessages);
const mockGetChatExecutionControl = vi.mocked(getChatExecutionControl);
const mockStopChat = vi.mocked(stopChat);
const mockGetGitRefs = vi.mocked(getGitRefs);
const mockRunChat = vi.mocked(runChat);
const mockCreateQueuedInput = vi.mocked(createQueuedInput);
const ACCEPTED_CHOICE = {
	success: true,
	commandType: 'run',
	clientRequestId: 'synthetic-choice-command',
	chatId: 'chat-1',
	turnId: 'synthetic-choice-turn',
	status: 'accepted',
	acceptedAt: '2026-01-01T00:00:00.000Z',
} satisfies AgentTurnCommandResponse;

describe('ConversationWorkspace Escape abort handling', () => {
	it.each(['conversation', 'literal', null] as const)('gates sibling prose and completion sounds with %s policy', async (executionPolicy) => {
		const submit = vi.spyOn(ConversationSessionController.prototype, 'submitForChat').mockResolvedValue('accepted');
		let registeredSubmit!: (message: string) => Promise<boolean>;
		let registeredAppend!: ChatDraftAppend;
		try {
			render(ConversationWorkspaceEscapeHost, {
				executionPolicy,
				onRegisterSubmit: fn => { registeredSubmit = fn; },
				onRegisterAppendToDraft: fn => { registeredAppend = fn; },
			});
			await waitFor(() => expect(registeredSubmit).toBeTypeOf('function'));
			expect(await registeredSubmit('Address this comment: $(printf review)')).toBe(executionPolicy === 'conversation');
			expect(registeredAppend('```text\nfile selection\n```')).toBe(executionPolicy === 'conversation' ? 'appended' : 'unavailable');
			expect(submit).toHaveBeenCalledTimes(executionPolicy === 'conversation' ? 1 : 0);
			const router = vi.mocked(mountConversationRouter).mock.calls.at(-1)?.[0];
			if (!router) throw new Error('Expected conversation router registration');
			router.notifyCompletion('chat-1');
			expect(playCompletionSound).toHaveBeenCalledTimes(executionPolicy === 'conversation' ? 1 : 0);
			router.notifyCompletion('unknown-chat');
			expect(playCompletionSound).toHaveBeenCalledTimes(executionPolicy === 'conversation' ? 1 : 0);
		} finally {
			submit.mockRestore();
		}
	});
	beforeEach(() => {
		reconnectHarness.onBackgroundMessages = null;
		mockRunChat.mockReset();
		mockRunChat.mockResolvedValue(ACCEPTED_CHOICE);
		mockCreateQueuedInput.mockReset();
		mockCreateQueuedInput.mockResolvedValue({
			...ACCEPTED_CHOICE,
			commandType: 'queue-entry-create',
			entryId: 'synthetic-choice-entry',
			control: {
				serverInstanceId: 'server-instance-test',
				queue: emptyChatQueueState(),
				version: 101,
				updatedAt: null,
			},
		} satisfies QueueEntryCommandResponse);
		mockGetChatMessages.mockResolvedValue({
			historyState: { kind: 'complete' },
			chatId: 'chat-1',
			transcriptViewId: 'gen-1',
			messages: [],
			lastOrdinal: 0,
			pageOldestOrdinal: 0,
			pageNewestOrdinal: 0,
			nextBeforeOrdinal: null,
			hasMore: false,
			limit: 50,
			resendCandidates: [],
		});
		mockGetChatExecutionControl.mockResolvedValue({
			success: true,
			chatId: 'chat-1',
			control: {
				serverInstanceId: 'server-instance-test',
				queue: {
					entries: [],
					steeringEntryId: null,
					recentlyDispatched: [],
					pause: null,
					reorderRevision: 0,
				},
				version: 0,
				updatedAt: null,
			},
		});
		mockStopChat.mockResolvedValue({
			success: true,
			outcome: 'interrupt-requested',
			commandType: 'stop',
			clientRequestId: 'cmd-stop',
			status: 'accepted',
			acceptedAt: '2026-01-01T00:00:00.000Z',
			control: {
				serverInstanceId: 'server-instance-test',
				queue: {
					entries: [],
					steeringEntryId: null,
					recentlyDispatched: [],
					pause: null,
					reorderRevision: 0,
				},
				version: 0,
				updatedAt: null,
			},
		});
		mockGetGitRefs.mockReset();
		mockGetGitRefs.mockResolvedValue({ refs: [] });
	});

	it('sends a slash-prefixed choice literally without entering the composer command dispatcher or changing its draft', async () => {
		const submit = vi.spyOn(ConversationSessionController.prototype, 'submitForChat');
		try {
			const { component } = render(ConversationWorkspaceEscapeHost);
			await waitFor(() => expect(mockGetChatMessages).toHaveBeenCalled());
			const key = await component.seedChoice();
			const attachment = new File(['synthetic attachment'], 'synthetic.txt', {
				type: 'text/plain',
			});
			component.setChoiceDraft('Retained composer text', [attachment]);
			expect(await component.answerChoice('/clear')).toBe(true);
			expect(mockRunChat).toHaveBeenCalledOnce();
			expect(mockRunChat).toHaveBeenCalledWith(
				expect.objectContaining({
					chatId: 'chat-1',
					transcriptViewId: 'gen-choices',
					expectedAgentId: 'claude',
					expectedAgentOwnershipEpoch: 'epoch-1',
					command: '/clear',
				}),
			);
			expect(submit).not.toHaveBeenCalled();
			expect(component.choiceDraft()).toMatchObject({
				text: 'Retained composer text',
				attachments: [attachment],
			});
			expect(component.choiceStatus(key)).toBe('sent');
		} finally {
			submit.mockRestore();
		}
	});

	it('sends all selected answers from a multi-question response through the same admission path', async () => {
		const { component } = render(ConversationWorkspaceEscapeHost);
		await waitFor(() => expect(mockGetChatMessages).toHaveBeenCalled());
		await component.seedChoice('Which features do you want? Select all that apply.\n- Outline\n- Diagram\n- Example\n\nWhich format do you prefer?\n- Short\n- Detailed');
		expect(await component.answerChoices([
			{ questionId: '1:question-1', selectedOptionIds: ['option-1', 'option-2'] },
			{ questionId: '1:question-2', selectedOptionIds: ['option-1'] },
		])).toBe(true);
		expect(mockRunChat).toHaveBeenCalledOnce();
		expect(mockRunChat).toHaveBeenCalledWith(expect.objectContaining({
			command: 'Which features do you want? Select all that apply.\n- Outline\n- Diagram\n\nWhich format do you prefer?\nShort',
		}));
	});

	it('rejects incomplete or invalid multi-question answers before dispatch', async () => {
		const { component } = render(ConversationWorkspaceEscapeHost);
		await waitFor(() => expect(mockGetChatMessages).toHaveBeenCalled());
		await component.seedChoice('Which features do you want? Select all that apply.\n- Outline\n- Diagram\n\nWhich format do you prefer?\n- Short\n- Detailed');
		expect(await component.answerChoices([{ questionId: '1:question-1', selectedOptionIds: ['option-1'] }])).toBe(false);
		expect(await component.answerChoices([
			{ questionId: '1:question-1', selectedOptionIds: ['missing-option'] },
			{ questionId: '1:question-2', selectedOptionIds: ['option-1'] },
		])).toBe(false);
		expect(await component.answerChoices([
			{ questionId: '1:question-1', selectedOptionIds: ['option-1'] },
			{ questionId: '1:question-2', selectedOptionIds: ['option-1', 'option-2'] },
		])).toBe(false);
		expect(mockRunChat).not.toHaveBeenCalled();
	});

	it('keeps a pending answer attached to its captured view and ownership epoch', async () => {
		let resolveRun!: (response: AgentTurnCommandResponse) => void;
		mockRunChat.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveRun = resolve;
				}),
		);
		const { component } = render(ConversationWorkspaceEscapeHost);
		await waitFor(() => expect(mockGetChatMessages).toHaveBeenCalled());
		const key = await component.seedChoice();
		const pending = component.answerChoice('/clear');
		await waitFor(() => expect(mockRunChat).toHaveBeenCalledOnce());
		expect(component.choiceStatus(key)).toBe('sending');
		component.changeChoiceTarget('replacement-view', 'replacement-epoch');
		resolveRun(ACCEPTED_CHOICE);
		expect(await pending).toBe(true);
		expect(mockRunChat.mock.calls[0][0]).toMatchObject({
			transcriptViewId: 'gen-choices',
			expectedAgentOwnershipEpoch: 'epoch-1',
			command: '/clear',
		});
		expect(mockRunChat).toHaveBeenCalledOnce();
		expect(await component.answerChoice('/clear')).toBe(false);
	});

	it.each(['nonempty', 'paused'] as const)(
		'queues a choice behind a %s queue without changing the composer draft',
		async (kind) => {
			const { component } = render(ConversationWorkspaceEscapeHost);
			await waitFor(() => expect(mockGetChatMessages).toHaveBeenCalled());
			await component.seedChoice();
			const queue: ChatQueueState = emptyChatQueueState();
			if (kind === 'paused')
				queue.pause = {
					id: 'synthetic-pause',
					kind: 'manual',
					pausedAt: '2026-01-01T00:00:00.000Z',
				};
			else
				queue.entries.push({
					id: 'existing-entry',
					content: 'Existing queued input',
					kind: 'turn',
					attachments: [],
					revision: 0,
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z',
				});
			component.setChoiceQueue(queue);
			component.setChoiceDraft('Retained queued draft', []);
			expect(await component.answerChoice('/clear')).toBe(true);
			expect(mockCreateQueuedInput).toHaveBeenCalledWith(
				expect.objectContaining({
					chatId: 'chat-1',
					transcriptViewId: 'gen-choices',
					expectedAgentOwnershipEpoch: 'epoch-1',
					content: '/clear',
				}),
			);
			expect(mockRunChat).not.toHaveBeenCalled();
			expect(component.choiceDraft().text).toBe('Retained queued draft');
		},
	);

	it('does not recreate queue controls or resend state after the originating chat is deleted', async () => {
		let resolveQueue!: (response: QueueEntryCommandResponse) => void;
		mockCreateQueuedInput.mockImplementationOnce(() => new Promise(resolve => { resolveQueue = resolve; }));
		const { component } = render(ConversationWorkspaceEscapeHost);
		await waitFor(() => expect(mockGetChatMessages).toHaveBeenCalled());
		await component.seedChoice();
		component.setChoiceQueue({ ...emptyChatQueueState(), pause: {
			id: 'synthetic-pause', kind: 'manual', pausedAt: '2026-01-01T00:00:00.000Z',
		} });
		const targets = component.choiceCleanupTargets();
		const publishControl = vi.spyOn(targets.conversationUi, 'setExecutionControlFromLiveUpdate');
		const clearResend = vi.spyOn(targets.transcript, 'clearResendExclusions');
		const pending = component.answerChoice('/clear');
		await waitFor(() => expect(mockCreateQueuedInput).toHaveBeenCalledOnce());
		component.deleteChoiceChat();
		resolveQueue({
			...ACCEPTED_CHOICE,
			entryId: 'synthetic-choice-entry',
			control: { serverInstanceId: 'server-instance-test', queue: emptyChatQueueState(), version: 101, updatedAt: null },
		});
		expect(await pending).toBe(true);
		expect(publishControl).not.toHaveBeenCalled();
		expect(clearResend).not.toHaveBeenCalled();
	});

	it('guards repeat clicks while sending and after uncertain delivery', async () => {
		let rejectRun!: (reason: Error) => void;
		mockRunChat.mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					rejectRun = reject;
				}),
		);
		mockRunChat.mockRejectedValueOnce(new Error('Synthetic second lost reply'));
		const { component } = render(ConversationWorkspaceEscapeHost);
		await waitFor(() => expect(mockGetChatMessages).toHaveBeenCalled());
		const key = await component.seedChoice();
		const pending = component.answerChoice('/clear');
		await waitFor(() => expect(mockRunChat).toHaveBeenCalledOnce());
		expect(await component.answerChoice('/clear')).toBe(false);
		expect(mockRunChat).toHaveBeenCalledOnce();
		const uncertain = expect(pending).rejects.toBeInstanceOf(CommandOutcomeUnknownError);
		rejectRun(new Error('Synthetic first lost reply'));
		await uncertain;
		expect(mockRunChat).toHaveBeenCalledTimes(2);
		expect(mockRunChat.mock.calls[1][0]).toEqual(mockRunChat.mock.calls[0][0]);
		expect(component.choiceStatus(key)).toBe('unknown');
		expect(await component.answerChoice('/clear')).toBe(false);
		expect(mockRunChat).toHaveBeenCalledTimes(2);
	});

	it('patches activity for a tool-only background reconnect batch', () => {
		const patchActivity = vi.fn();
		render(ConversationWorkspaceEscapeHost, { onPatchActivity: patchActivity });
		const onBackgroundMessages = reconnectHarness.onBackgroundMessages;
		if (!onBackgroundMessages) throw new Error('Expected reconnect background message handler');
		const timestamp = '2026-01-01T00:00:01.000Z';

		expect(
			onBackgroundMessages(
				'chat-background',
				'view-background',
				[
					{
						ordinal: 1,
						message: new ToolResultMessage(timestamp, 'tool-1', { content: 'result' }, false),
					},
				],
				1,
				1,
			),
		).toBe(true);
		expect(patchActivity).toHaveBeenCalledWith('chat-background', timestamp);
	});

	it.each(['/other', '/workspace/project'])('opens busy quick Commit without a summary, notifying only for a different target (%s)', async (projectPath) => {
		const commit = new CommitController(createGitSurfaceTestDeps());
		const quickSummary = new GitQuickSummaryStore();
		const notifications = createNotificationsStore();

		const onOpenCommit = vi.fn(async () => {});
		render(ConversationWorkspaceEscapeHost, { commit, quickSummary, onOpenCommit, notifications });
		expect(commit.target.selectProject({ executorId: 'local', projectPath })).toBe(true);
		commit.message = 'Retained draft';
		commit.isGeneratingMessage = true;

		await fireEvent.click(screen.getByRole('button', { name: 'Open quick commit' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Open quick commit' }));

		expect(onOpenCommit).toHaveBeenCalledWith('commit', 'window-main');
		expect(commit.target.requestTarget).toEqual({ executorId: 'local', projectPath });
		expect(commit.message).toBe('Retained draft');
		expect(commit.isGeneratingMessage).toBe(true);
		expect(notifications.items).toHaveLength(projectPath === '/other' ? 1 : 0);
		quickSummary.destroy();
	});

	it('does not publish branch state after the initiating surface loses command ownership', async () => {
		let resolveProject!: (value: ProjectResolutionResponse) => void;
		let target!: ProjectTarget;
		const fetchProjectResolution = vi.fn((requestedTarget: ProjectTarget) => {
			target = requestedTarget;
			return new Promise<ProjectResolutionResponse>((resolve) => {
				resolveProject = resolve;
			});
		});
		const { component } = render(ConversationWorkspaceEscapeHost, { fetchProjectResolution });

		await fireEvent.click(screen.getByRole('button', { name: 'Open branch dropdown' }));
		await waitFor(() => expect(fetchProjectResolution).toHaveBeenCalledOnce());
		await fireEvent.click(screen.getByRole('button', { name: 'Move command ownership' }));
		resolveProject({
			target,
			resolution: { kind: 'available', effectiveProjectKey: target.projectPath },
		});
		await component.waitForBranchAction();

		expect(screen.getByTestId('branch-dropdown-open').textContent).toBe('false');
		expect(mockGetGitRefs).not.toHaveBeenCalled();
	});

	it('does not resurrect a branch action after command ownership leaves and returns', async () => {
		let resolveProject!: (value: ProjectResolutionResponse) => void;
		let target!: ProjectTarget;
		const fetchProjectResolution = vi.fn((requestedTarget: ProjectTarget) => {
			target = requestedTarget;
			return new Promise<ProjectResolutionResponse>((resolve) => {
				resolveProject = resolve;
			});
		});
		const { component } = render(ConversationWorkspaceEscapeHost, { fetchProjectResolution });

		await fireEvent.click(screen.getByRole('button', { name: 'Open branch dropdown' }));
		await waitFor(() => expect(fetchProjectResolution).toHaveBeenCalledOnce());
		await fireEvent.click(screen.getByRole('button', { name: 'Move command ownership' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Restore command ownership' }));
		resolveProject({
			target,
			resolution: { kind: 'available', effectiveProjectKey: target.projectPath },
		});
		await component.waitForBranchAction();

		expect(screen.getByTestId('branch-dropdown-open').textContent).toBe('false');
		expect(mockGetGitRefs).not.toHaveBeenCalled();
	});

	it('keeps a branch action owned when focus repeats within the same surface', async () => {
		let resolveProject!: (value: ProjectResolutionResponse) => void;
		let target!: ProjectTarget;
		const fetchProjectResolution = vi.fn((requestedTarget: ProjectTarget) => {
			target = requestedTarget;
			return new Promise<ProjectResolutionResponse>((resolve) => {
				resolveProject = resolve;
			});
		});
		render(ConversationWorkspaceEscapeHost, { fetchProjectResolution });

		await fireEvent.click(screen.getByRole('button', { name: 'Open branch dropdown' }));
		await waitFor(() => expect(fetchProjectResolution).toHaveBeenCalledOnce());
		await fireEvent.click(screen.getByRole('button', { name: 'Refocus command surface' }));
		resolveProject({
			target,
			resolution: { kind: 'available', effectiveProjectKey: target.projectPath },
		});

		await waitFor(() =>
			expect(screen.getByTestId('branch-dropdown-open').textContent).toBe('true'),
		);
		expect(mockGetGitRefs).toHaveBeenCalledOnce();
	});

	it('opens create branch after the selector closes its branch dropdown', async () => {
		const fetchProjectResolution = vi.fn(async (target: ProjectTarget) => ({
			target,
			resolution: { kind: 'available' as const, effectiveProjectKey: target.projectPath },
		}));
		render(ConversationWorkspaceEscapeHost, { fetchProjectResolution });

		await fireEvent.click(screen.getByRole('button', { name: 'Open branch dropdown' }));
		await waitFor(() =>
			expect(screen.getByTestId('branch-dropdown-open').textContent).toBe('true'),
		);
		await fireEvent.click(screen.getByRole('button', { name: 'Create new branch' }));

		await waitFor(() =>
			expect(screen.getByTestId('new-branch-dialog-open').textContent).toBe('true'),
		);
		expect(fetchProjectResolution).toHaveBeenCalledTimes(2);
	});

	afterEach(() => {
		cleanup();
		document.body.innerHTML = '';
		vi.clearAllMocks();
	});

	it('does not abort while another layer owns Escape', async () => {
		render(ConversationWorkspaceEscapeHost);

		await fireEvent.click(screen.getByRole('button', { name: 'Open test layer' }));

		await fireEvent.keyDown(window, { key: 'Escape' });

		expect(mockStopChat).not.toHaveBeenCalled();
		expect(screen.queryByRole('dialog', { name: 'Test dialog' })).toBeNull();

		await fireEvent.keyDown(window, { key: 'Escape' });

		await waitFor(() => expect(mockStopChat).toHaveBeenCalledTimes(1));
		expect(mockStopChat.mock.calls[0]?.[0]).toMatchObject({
			chatId: 'chat-1',
			agentId: 'claude',
		});
	});

	it.each(['keyboard', 'pointer'] as const)('lets only a %s-focused Git tooltip own Escape before stopping the chat', async (interaction) => {
		const quickSummary = new GitQuickSummaryStore({
			getSummary: vi.fn().mockResolvedValue({
				status: 'ready', project: '/workspace/project', branch: 'main',
				hasChanges: true, hasUntracked: true, diffStats: { additions: 0, deletions: 0 },
			} satisfies GitQuickSummaryReady),
		});
		try {
			quickSummary.setVisibleProjects([{ executorId: 'local', projectPath: '/workspace/project', isProcessing: true }]);
			render(ConversationWorkspaceEscapeHost, { composerStatusBarGitProjects: true, quickSummary });
			const button = await screen.findByRole('button', { name: /^Commit/ });
			const focusTarget = interaction === 'keyboard' ? button : screen.getByRole('button', { name: 'Abort' });
			focusTarget.focus();
			if (interaction === 'pointer') await fireEvent.pointerEnter(button, { pointerType: 'mouse' });
			await screen.findByRole('tooltip');
			expect(document.activeElement).toBe(focusTarget);
			await fireEvent.keyDown(focusTarget, { key: 'Escape' });
			await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
			if (interaction === 'keyboard') {
				expect(mockStopChat).not.toHaveBeenCalled();
				await fireEvent.keyDown(button, { key: 'Escape' });
			}
			await waitFor(() => expect(mockStopChat).toHaveBeenCalledOnce());
		} finally {
			quickSummary.destroy();
		}
	});

	it('derives queued steering from the selected agent capability and processing state', async () => {
		render(ConversationWorkspaceEscapeHost);

		expect(screen.getByTestId('queue-can-steer').textContent).toBe('true');
		await fireEvent.click(screen.getByRole('button', { name: 'Toggle processing' }));
		await waitFor(() => expect(screen.getByTestId('queue-can-steer').textContent).toBe('false'));

		await fireEvent.click(screen.getByRole('button', { name: 'Use Codex' }));
		expect(screen.getByTestId('queue-can-steer').textContent).toBe('false');
		await fireEvent.click(screen.getByRole('button', { name: 'Toggle processing' }));
		await waitFor(() => expect(screen.getByTestId('queue-can-steer').textContent).toBe('true'));

		await fireEvent.click(screen.getByRole('button', { name: 'Use unsupported agent' }));
		await waitFor(() => expect(screen.getByTestId('queue-can-steer').textContent).toBe('false'));
	});

	it('uses the submit classifier processing predicate for composer queue mode', async () => {
		render(ConversationWorkspaceEscapeHost);

		expect(screen.getByTestId('composer-requires-queued-submission').textContent).toBe('true');
		await fireEvent.click(screen.getByRole('button', { name: 'Set draft status' }));

		await waitFor(() =>
			expect(screen.getByTestId('composer-requires-queued-submission').textContent).toBe('false'),
		);
	});

	it('does not abort when an Escape handler already prevented default', async () => {
		render(ConversationWorkspaceEscapeHost);

		const event = new KeyboardEvent('keydown', {
			key: 'Escape',
			bubbles: true,
			cancelable: true,
		});
		event.preventDefault();
		window.dispatchEvent(event);

		expect(mockStopChat).not.toHaveBeenCalled();
	});

	it('routes the configurable expanded composer command as a monotonic request', async () => {
		render(ConversationWorkspaceEscapeHost);
		const request = screen.getByTestId('composer-editor-open-request');
		const open = new KeyboardEvent('keydown', {
			key: 'e',
			ctrlKey: true,
			shiftKey: true,
			bubbles: true,
			cancelable: true,
		});

		window.dispatchEvent(open);

		expect(open.defaultPrevented).toBe(true);
		await waitFor(() => expect(request.textContent).toBe('1'));

		window.dispatchEvent(
			new KeyboardEvent('keydown', {
				key: 'e',
				ctrlKey: true,
				shiftKey: true,
				repeat: true,
			}),
		);
		expect(request.textContent).toBe('1');
	});

	it('does not open the composer editor underneath a top modal', async () => {
		render(ConversationWorkspaceEscapeHost);
		await fireEvent.click(screen.getByRole('button', { name: 'Open test layer' }));

		window.dispatchEvent(
			new KeyboardEvent('keydown', {
				key: 'e',
				ctrlKey: true,
				shiftKey: true,
				bubbles: true,
				cancelable: true,
			}),
		);

		expect(screen.getByTestId('composer-editor-open-request').textContent).toBe('0');
	});

	it('routes repeat-open from the presented composer editor chrome while Chat is inert', async () => {
		render(ConversationWorkspaceEscapeHost);
		await fireEvent.click(screen.getByRole('button', { name: 'Open composer editor layer' }));
		const chrome = screen.getByRole('button', { name: 'Composer editor chrome' });

		for (const expectedRequest of ['1', '2']) {
			const open = new KeyboardEvent('keydown', {
				key: 'e',
				ctrlKey: true,
				shiftKey: true,
				bubbles: true,
				cancelable: true,
			});
			chrome.dispatchEvent(open);

			expect(open.defaultPrevented).toBe(true);
			await waitFor(() =>
				expect(screen.getByTestId('composer-editor-open-request').textContent).toBe(
					expectedRequest,
				),
			);
		}
	});
});
