import { describe, expect, it } from 'vitest';

import {
	sortChatSearchResults,
	visibleChatSearchTimePrefix,
} from '$lib/sidebar/search/search-result-order.js';
import type { ChatSessionRecord } from '$lib/types/chat-session';

function chat(
	id: string,
	createdAt: string | null,
	lastActivityAt: string | null,
): ChatSessionRecord {
	return {
		id,
		parentChat: null,
		projectPath: '/workspace',
		effectiveProjectKey: '/workspace',
		projectIdentityState: 'available',
		orderGroup: 'normal',
		title: id,
		agentId: 'claude',
		model: null,
		permissionMode: 'default',
		thinkingMode: 'low',
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
		createdAt,
		lastActivityAt,
		lastReadAt: null,
		isPinned: false,
		isArchived: false,
		isProcessing: false,
		processingPhase: null,
		isUnread: false,
		canReloadFromNativeHistory: false,
		status: 'draft',
		agentOwnershipEpoch: null,
		lastMessage: '',
		tags: [],
	};
}

describe('chat search result ordering', () => {
	const older = chat('older', '2025-01-01T00:00:00.000Z', '2025-04-01T00:00:00.000Z');
	const newer = chat('newer', '2025-03-01T00:00:00.000Z', '2025-02-01T00:00:00.000Z');

	it('preserves relevance input order without mutating it', () => {
		const input = [older, newer];
		const result = sortChatSearchResults(input, 'relevance');
		expect(result).toEqual(input);
		expect(result).not.toBe(input);
	});

	it('sorts activity and creation newest first', () => {
		expect(sortChatSearchResults([newer, older], 'activity').map((entry) => entry.id))
			.toEqual(['older', 'newer']);
		expect(sortChatSearchResults([older, newer], 'created').map((entry) => entry.id))
			.toEqual(['newer', 'older']);
	});

	it('holds rows beyond an incomplete transcript frontier', () => {
		const sorted = [newer, older, chat('oldest', '2024-01-01T00:00:00.000Z', null)];
		expect(visibleChatSearchTimePrefix(sorted, new Set(['newer', 'older']), true))
			.toEqual([newer, older]);
		expect(visibleChatSearchTimePrefix(sorted, new Set(['newer']), false)).toEqual(sorted);
	});

	it('keeps metadata matches visible when no loaded transcript row survives validation', () => {
		const sorted = [newer, older];
		expect(visibleChatSearchTimePrefix(sorted, new Set(), true)).toEqual(sorted);
		expect(visibleChatSearchTimePrefix(sorted, new Set(['missing-chat']), true)).toEqual(sorted);
	});
});
