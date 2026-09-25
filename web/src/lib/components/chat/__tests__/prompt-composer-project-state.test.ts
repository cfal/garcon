import { describe, expect, it, vi } from 'vitest';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import type { ProjectTarget } from '$shared/project-resolution';
import { ProjectResolutionStore } from '$lib/workspace/project-resolution-store.svelte.js';
import { PromptComposerProjectState } from '../prompt-composer-project-state.svelte.js';

function chat(overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
	return {
		id: 'chat-1',
		parentChat: null,
		projectPath: '/project-a',
		orderGroup: 'normal',
		title: 'Chat',
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
		agentOwnershipEpoch: 'epoch-1',
		tags: [],
		...overrides,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

describe('PromptComposerProjectState', () => {
	it.each([undefined, '11111111-1111-4111-8111-111111111111'])(
		'uses the pending same-executor folder for completions and snippets on %s',
		async (executorId) => {
			const selectedChat = chat({ executorId });
			let executionTarget = { executorId: executorId ?? 'local', projectPath: '/confirmed-folder' };
			const fetchResolution = vi.fn(async (target: ProjectTarget) => ({
				target,
				resolution: { kind: 'available' as const, effectiveProjectKey: target.projectPath },
			}));
			const projectResolution = new ProjectResolutionStore(fetchResolution);
			const projectState = new PromptComposerProjectState({
				selectedChat,
				get executionTarget() { return executionTarget; },
				completionDemand: false,
				projectResolution,
			});
			const target = { kind: 'path' as const, ...executionTarget };
			const lease = projectResolution.retain(target);
			try {
				expect(projectState.target).toEqual(target);
				await lease.resolve();
				expect(projectState.completionProjectPath).toBe('/confirmed-folder');
				expect(await projectState.resolveSnippetContext()).toEqual({
					executorId: executionTarget.executorId,
					chatId: selectedChat.id,
					projectPath: '/confirmed-folder',
					context: { type: 'new-chat', chatId: selectedChat.id, ...executionTarget },
				});
				executionTarget = { ...executionTarget, projectPath: selectedChat.projectPath };
				expect(projectState.target).toEqual({
					kind: 'chat', chatId: selectedChat.id, executorId, projectPath: selectedChat.projectPath,
				});
			} finally {
				lease.release();
				projectState.destroy();
				projectResolution.destroy();
			}
		},
	);

	it('fences expansion results by executor even when the project path stays unchanged', () => {
		const projectResolution = new ProjectResolutionStore();
		let selectedChat = chat();
		const projectState = new PromptComposerProjectState({
			get selectedChat() { return selectedChat; }, completionDemand: false, projectResolution,
		});
		const operation = { executorId: 'local', chatId: 'chat-1', projectPath: '/project-a', context: { type: 'chat' as const, chatId: 'chat-1' } };
		const response = { contextExecutorId: 'local', contextProjectPath: '/project-a' };
		expect(projectState.matchesSnippetContext(operation, response)).toBe(true);
		selectedChat = chat({ executorId: '11111111-1111-4111-8111-111111111111' });
		expect(projectState.matchesSnippetContext(operation, response)).toBe(false);
		selectedChat = chat();
		expect(projectState.matchesSnippetContext(operation, { ...response, contextExecutorId: '11111111-1111-4111-8111-111111111111' })).toBe(false);
		projectState.destroy();
		projectResolution.destroy();
	});

	it('reports a binding change before classifying its obsolete resolution', async () => {
		const request = deferred<{
			target: { kind: 'chat'; chatId: string; projectPath: string };
			resolution: { kind: 'unavailable'; reason: 'not-found' };
		}>();
		const fetchResolution = vi.fn(() => request.promise);
		const projectResolution = new ProjectResolutionStore(fetchResolution);
		let selectedChat = chat();
		const projectState = new PromptComposerProjectState({
			get selectedChat() {
				return selectedChat;
			},
			completionDemand: false,
			projectResolution,
		});

		const resolving = projectState.resolveSnippetContext();
		selectedChat = chat({ projectPath: '/project-b' });
		projectResolution.markObsoleteChatTargets('chat-1', '/project-b');
		request.resolve({
			target: { kind: 'chat', chatId: 'chat-1', projectPath: '/project-a' },
			resolution: { kind: 'unavailable', reason: 'not-found' },
		});

		await expect(resolving).rejects.toThrow('The chat project changed.');
		projectState.destroy();
		projectResolution.destroy();
	});
});
