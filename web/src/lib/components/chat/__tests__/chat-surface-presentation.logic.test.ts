import { describe, expect, it } from 'vitest';
import { resolveChatSurfacePresentation } from '../chat-surface-presentation';
import type { ChatSessionRecord } from '$lib/types/chat-session';

function chat(status: ChatSessionRecord['status']): ChatSessionRecord {
	return {
		id: 'chat-1',
		parentChat: null,
		projectPath: '/workspace/project',
		orderGroup: 'normal',
		title: 'Chat',
		agentId: 'claude',
		agentOwnershipEpoch: null,
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
		isUnread: false,
		canReloadFromNativeHistory: false,
		status,
		tags: [],
	};
}

describe('resolveChatSurfacePresentation', () => {
	it('keeps a pending draft renderable so startup errors and retry input stay visible', () => {
		expect(
			resolveChatSurfacePresentation(
				chat('draft'),
				false,
			),
		).toBe('conversation');
	});

	it('renders running chats without requiring project resolution', () => {
		expect(
			resolveChatSurfacePresentation(
				chat('running'),
				false,
			),
		).toBe('conversation');
	});

	it('distinguishes an empty chat list from one that is still loading', () => {
		expect(resolveChatSurfacePresentation(null, false)).toBe('empty');
		expect(resolveChatSurfacePresentation(null, true)).toBe('loading');
	});
});
