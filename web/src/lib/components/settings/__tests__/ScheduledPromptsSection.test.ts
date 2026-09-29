import { render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { localExecutor, remoteExecutor } from '$lib/executors/__tests__/fixtures';
import type { ChatListEntry } from '$shared/chat-list';
import type { ScheduledPrompt, ScheduledPromptTarget } from '$shared/scheduled-prompts';

vi.mock('../ScheduledPromptDialog.svelte', async () => import('./ScheduledPromptDialogTestStub.svelte'));

const ScheduledPromptsSectionTestHost = (await import('./ScheduledPromptsSectionTestHost.svelte'))
	.default;

function prompt(id: string, title: string, target: ScheduledPromptTarget): ScheduledPrompt {
	return {
		id,
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

	it('omits the executor while Local is the only executor', () => {
		render(ScheduledPromptsSectionTestHost, {
			executors: [localExecutor],
			chats: [],
			prompts: [prompt('local-new', 'Local new chat', newChat())],
		});

		expect(screen.getByRole('heading', { name: 'Local new chat' })).toBeTruthy();
		expect(executorPill('Local new chat')).toBeNull();
	});
});
