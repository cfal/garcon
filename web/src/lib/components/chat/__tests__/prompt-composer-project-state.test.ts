import { describe, expect, it, vi } from 'vitest';
import type { ChatSessionRecord } from '$lib/types/chat-session';
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
