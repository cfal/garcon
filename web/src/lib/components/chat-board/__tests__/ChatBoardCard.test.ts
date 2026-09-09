import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatBoardOccurrence } from '$lib/chat-board/projection/chat-board-projection.js';
import type { ChatSessionRecord } from '$lib/types/chat-session.js';
import ChatBoardCardTestHost from './ChatBoardCardTestHost.svelte';

function occurrence(overrides: Partial<ChatSessionRecord> = {}): ChatBoardOccurrence {
	return {
		key: 'column:chat-1',
		columnId: 'column',
		chat: {
			id: 'chat-1',
			parentChat: null,
			projectPath: '/workspace/project',
			orderGroup: 'normal',
			title: 'Polish onboarding',
			agentId: 'claude',
			model: 'sonnet',
			permissionMode: 'default',
			thinkingMode: 'none',
			agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
			createdAt: null,
			lastActivityAt: '2026-09-07T10:00:00.000Z',
			lastReadAt: null,
			isPinned: false,
			isArchived: false,
			isProcessing: true,
			processingPhase: 'running',
			canReloadFromNativeHistory: false,
			isUnread: true,
			status: 'running',
			agentOwnershipEpoch: null,
			tags: ['ready'],
			lastMessage: 'Review the final interaction and spacing.',
			...overrides,
		},
	};
}

afterEach(cleanup);

describe('ChatBoardCard', () => {
	it('associates unread and processing state with the open action', () => {
		render(ChatBoardCardTestHost, {
			occurrence: occurrence(),
			currentTime: new Date('2026-09-07T10:00:30.000Z'),
		});
		const open = screen.getByRole('button', { name: 'Open Polish onboarding' });
		const descriptionId = open.getAttribute('aria-describedby');

		expect(descriptionId).toBeTruthy();
		expect(document.getElementById(descriptionId ?? '')?.textContent).toBe(
			'Unread. Chat is processing',
		);
	});

	it('advances relative activity labels with the shared minute clock', async () => {
		const currentOccurrence = occurrence({
			isProcessing: false,
			processingPhase: null,
			isUnread: false,
		});
		const rendered = render(ChatBoardCardTestHost, {
			occurrence: currentOccurrence,
			currentTime: new Date('2026-09-07T10:00:30.000Z'),
		});
		expect(screen.getByText('now')).toBeTruthy();

		await rendered.rerender({
			occurrence: currentOccurrence,
			currentTime: new Date('2026-09-07T10:02:00.000Z'),
		});

		expect(await screen.findByText('2m ago')).toBeTruthy();
	});

	it('labels a known-committed reconciliation separately from durability confirmation', () => {
		render(ChatBoardCardTestHost, {
			occurrence: occurrence(),
			currentTime: new Date('2026-09-07T10:00:30.000Z'),
			reconciliationKind: 'committed-refresh',
		});

		expect(screen.getByRole('button', { name: /Refreshing saved tags.*Try again/ })).toBeTruthy();
	});
});
