import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { localExecutor, remoteExecutor } from '$lib/executors/__tests__/fixtures';
import type { ChatListEntry } from '$shared/chat-list';
import { renderScheduledPrompt } from '$lib/api/scheduled-prompts';
import { createExecutorStartupFixture } from '$lib/chat/new-chat/__tests__/executor-startup-fixture';
import type {
	ScheduledPrompt,
	ScheduledPromptRunLogEntry,
	ScheduledPromptTarget,
} from '$shared/scheduled-prompts';

vi.mock('../ScheduledPromptDialog.svelte', async () => import('./ScheduledPromptDialogTestStub.svelte'));
vi.mock('$lib/api/scheduled-prompts', () => ({ renderScheduledPrompt: vi.fn() }));

const ScheduledPromptsSectionTestHost = (await import('./ScheduledPromptsSectionTestHost.svelte'))
	.default;

function prompt(id: string, title: string, target: ScheduledPromptTarget): ScheduledPrompt {
	return {
		id,
		enabled: true,
		schedule: { type: 'once', nextRunAt: '2099-01-01T00:00:00.000Z' },
		target,
		prompt: title,
		createdAt: '2030-01-01T00:00:00.000Z',
		updatedAt: '2030-01-01T00:00:00.000Z',
	};
}

function newChat(executorId?: string): ScheduledPromptTarget {
	return {
		type: 'new-chat',
		...(executorId ? { executorId } : {}),
		agentId: 'claude',
		projectPath: '/workspace/project',
		model: 'opus',
		apiProviderId: null,
		modelEndpointId: null,
		modelProtocol: null,
		permissionMode: 'default',
		thinkingMode: 'none',
		agentSettingsById: {},
		tags: [],
		preambleChoice: { mode: 'defaults' },
	};
}

function existingChat(chatId: string): ScheduledPromptTarget {
	return { type: 'existing-chat', chatId, busyBehavior: 'queue' };
}

function chat(id: string, executorId: string): ChatListEntry {
	return {
		id,
		executorId,
		parentChat: null,
		agentId: 'claude',
		agentOwnershipEpoch: 'epoch-1',
		model: 'opus',
		permissionMode: 'default',
		thinkingMode: 'none',
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
		title: `Chat ${id}`,
		projectPath: '/worker/project',
		orderGroup: 'normal',
		tags: [],
		activity: { createdAt: null, lastActivityAt: null, lastReadAt: null },
		preview: { lastMessage: '' },
		isPinned: false,
		isArchived: false,
		isActive: false,
		isProcessing: false,
		processingPhase: null,
		activityStatus: null,
		canReloadFromNativeHistory: false,
		isUnread: false,
	};
}

function executorPill(title: string): string | null {
	const row = screen.getByRole('heading', { name: title }).closest('article');
	return (
		row?.querySelector('[data-slot="scheduled-prompt-executor"]')?.getAttribute('title') ?? null
	);
}

describe('ScheduledPromptsSection', () => {
	it('loads a cold remote catalog before enabling an unguarded existing-chat copy', async () => {
		const { modelCatalog, remoteCatalog } = createExecutorStartupFixture();
		const metadata = remoteCatalog.agentMetadata;
		remoteCatalog.agentMetadata = {};
		const discovery = Promise.withResolvers<void>();
		vi.mocked(remoteCatalog.refreshIfStale).mockImplementation(async () => {
			await discovery.promise;
			remoteCatalog.agentMetadata = metadata;
		});
		render(ScheduledPromptsSectionTestHost, {
			executors: [localExecutor, remoteExecutor], modelCatalog,
			chats: [chat('chat-remote', remoteExecutor.id)],
			prompts: [prompt('remote-existing', 'Remote existing chat', existingChat('chat-remote'))],
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Prompt actions' }));
		expect(screen.getByRole('menuitem', { name: 'Open in new chat' }).getAttribute('aria-disabled')).toBe('true');
		expect(remoteCatalog.refreshIfStale).toHaveBeenCalledOnce();
		expect(modelCatalog.refreshIfStale).not.toHaveBeenCalled();
		discovery.resolve();
		await vi.waitFor(() => expect(screen.getByRole('menuitem', { name: 'Open in new chat' }).getAttribute('aria-disabled')).not.toBe('true'));
	});

	it('prepares an editable new-chat seed from the row without changing the schedule', async () => {
		const onOpenInNewChat = vi.fn();
		vi.mocked(renderScheduledPrompt).mockImplementation(async request => ({ success: true, chatId: request.chatId, expandedText: `Review ${request.chatId}` }));
		render(ScheduledPromptsSectionTestHost, {
			executors: [localExecutor], chats: [],
			prompts: [prompt('a', 'Review {{chat_id}}', newChat())], onOpenInNewChat,
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Prompt actions' }));
		await fireEvent.click(screen.getByRole('menuitem', { name: 'Open in new chat' }));
		await vi.waitFor(() => expect(onOpenInNewChat).toHaveBeenCalledOnce());
		const seed = onOpenInNewChat.mock.calls[0][0];
		expect(seed.prefill).toBe(`Review ${seed.prospectiveChatId}`);
		expect(seed.startup).toMatchObject({ executorId: 'local', projectPath: '/workspace/project', agentId: 'claude', model: 'opus' });
	});

	it.each(['success', 'failure'] as const)('blocks a new scheduled draft until chat preparation settles with %s', async outcome => {
		const pending = Promise.withResolvers<void>();
		const onOpenInNewChat = vi.fn();
		vi.mocked(renderScheduledPrompt).mockImplementation(async request => {
			await pending.promise;
			return { success: true, chatId: request.chatId, expandedText: 'Review task' };
		});
		render(ScheduledPromptsSectionTestHost, {
			executors: [localExecutor], chats: [],
			prompts: [prompt('a', 'Review task', newChat())], onOpenInNewChat,
		});
		const addPrompt = screen.getByRole('button', { name: 'Add Prompt' }) as HTMLButtonElement;
		expect(addPrompt.disabled).toBe(false);
		await fireEvent.click(screen.getByRole('button', { name: 'Prompt actions' }));
		await fireEvent.click(screen.getByRole('menuitem', { name: 'Open in new chat' }));
		try {
			addPrompt.click();
			await tick();
			expect(screen.queryByText('Scheduled prompt editor')).toBeNull();
			expect(addPrompt.disabled).toBe(true);
			expect(onOpenInNewChat).not.toHaveBeenCalled();
		} finally {
			if (outcome === 'success') pending.resolve();
			else pending.reject(new Error('Synthetic render failure'));
		}
		await vi.waitFor(() => expect(addPrompt.disabled).toBe(false));
		if (outcome === 'success') expect(onOpenInNewChat).toHaveBeenCalledOnce();
		else expect(screen.getByRole('alert').textContent).toBe('Synthetic render failure');
	});

	it.each(['closed', 'superseded', 'unmounted'] as const)('aborts rendering when the section is %s and ignores a late reply', async reason => {
		const pending = Promise.withResolvers<void>();
		const onOpenInNewChat = vi.fn();
		vi.mocked(renderScheduledPrompt).mockImplementation(async request => {
			await pending.promise;
			return { success: true, chatId: request.chatId, expandedText: 'Late rendered task' };
		});
		const view = render(ScheduledPromptsSectionTestHost, {
			executors: [localExecutor], chats: [],
			prompts: [prompt('a', 'Review task', newChat())], onOpenInNewChat,
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Prompt actions' }));
		await fireEvent.click(screen.getByRole('menuitem', { name: 'Open in new chat' }));
		expect(renderScheduledPrompt).toHaveBeenCalledOnce();
		const signal = vi.mocked(renderScheduledPrompt).mock.calls[0][1]?.signal;
		expect(signal?.aborted).toBe(false);
		try {
			if (reason === 'closed') await view.rerender({ active: false });
			if (reason === 'superseded') await view.rerender({ newChatRequestId: 1 });
			if (reason === 'unmounted') view.unmount();
			await tick();
			expect(signal?.aborted).toBe(true);
		} finally {
			pending.resolve();
		}
		await vi.mocked(renderScheduledPrompt).mock.results[0].value;
		await tick();
		expect(onOpenInNewChat).not.toHaveBeenCalled();
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('shows where each prompt runs once a remote executor is configured', () => {
		render(ScheduledPromptsSectionTestHost, {
			executors: [localExecutor, remoteExecutor],
			chats: [chat('chat-remote', remoteExecutor.id)],
			prompts: [
				prompt('remote-new', 'Remote new chat', newChat(remoteExecutor.id)),
				prompt('local-new', 'Local new chat', newChat()),
				prompt('remote-existing', 'Remote existing chat', existingChat('chat-remote')),
				prompt('missing-existing', 'Missing existing chat', existingChat('chat-missing')),
			],
		});

		expect(executorPill('Remote new chat')).toBe('Executor: Worker');
		expect(executorPill('Local new chat')).toBe('Executor: Local');
		expect(executorPill('Remote existing chat')).toBe('Executor: Worker');
		expect(executorPill('Missing existing chat')).toBeNull();
	});

	it('keeps Local executor pills for new and existing chats when it is the only executor', () => {
		render(ScheduledPromptsSectionTestHost, {
			executors: [localExecutor],
			chats: [chat('chat-local', 'local')],
			prompts: [
				prompt('local-new', 'Local new chat', newChat()),
				prompt('local-existing', 'Local existing chat', existingChat('chat-local')),
				prompt('missing-existing', 'Missing existing chat', existingChat('chat-missing')),
			],
		});

		expect(screen.getByRole('heading', { name: 'Local new chat' })).toBeTruthy();
		expect(executorPill('Local new chat')).toBe('Executor: Local');
		expect(executorPill('Local existing chat')).toBe('Executor: Local');
		expect(executorPill('Missing existing chat')).toBeNull();
	});

	it('shows each prompt its latest run and opens the chat that run created', async () => {
		const onOpenChat = vi.fn();
		const run = (overrides: Partial<ScheduledPromptRunLogEntry>): ScheduledPromptRunLogEntry => ({
			at: '2030-01-01T09:00:00.000Z',
			scheduledPromptId: 'local-new',
			promptLabel: 'Local new chat',
			outcome: 'failed',
			chatId: null,
			message: 'Prompt failed: Chat is unavailable.',
			...overrides,
		});
		render(ScheduledPromptsSectionTestHost, {
			executors: [localExecutor],
			chats: [chat('chat-created', localExecutor.id)],
			prompts: [
				prompt('local-new', 'Local new chat', newChat()),
				prompt('never-run', 'Never run', newChat()),
				prompt('stale-chat', 'Stale chat', newChat()),
			],
			runLog: [
				run({}),
				run({ at: '2030-01-01T10:00:00.000Z', outcome: 'created-chat', chatId: 'chat-created' }),
				run({ scheduledPromptId: 'stale-chat', outcome: 'created-chat', chatId: 'chat-deleted' }),
			],
			onOpenChat,
		});

		const row = (title: string) =>
			screen.getByRole('heading', { name: title }).closest('article') as HTMLElement;
		const lastRun = (title: string) => row(title).querySelector('[data-slot="scheduled-prompt-last-run"]');

		expect(lastRun('Local new chat')?.textContent).toContain('Started a new chat');
		expect(lastRun('Never run')).toBeNull();
		expect(lastRun('Stale chat')?.textContent).toContain('Started a new chat');
		expect(within(row('Stale chat')).queryByRole('button', { name: 'Open chat' })).toBeNull();

		await fireEvent.click(within(row('Local new chat')).getByRole('button', { name: 'Open chat' }));
		expect(onOpenChat).toHaveBeenCalledWith('chat-created');
	});
});
