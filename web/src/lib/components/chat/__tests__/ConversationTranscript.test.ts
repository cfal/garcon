import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatDisplayRow } from '$lib/chat/transcript/active-transcript-state.svelte.js';
import type { PendingPermissionRequest } from '$lib/types/chat';
import { BashToolUseMessage, PermissionRequestMessage, UserMessage } from '$shared/chat-types';
import ConversationTranscriptTestHost from './ConversationTranscriptTestHost.svelte';

const PERMISSION_TIMESTAMP = '2026-07-22T00:00:02.000Z';

function permissionRow(incarnation: string): ChatDisplayRow {
	return {
		kind: 'message',
		id: 'generation-1:2',
		ordinal: 2,
		message: new PermissionRequestMessage(
			PERMISSION_TIMESTAMP,
			'reused-request',
			incarnation,
			new BashToolUseMessage(PERMISSION_TIMESTAMP, 'tool-1', 'pwd'),
		),
	};
}

function pendingPermission(
	incarnation: string,
	withCapability: boolean,
): PendingPermissionRequest {
	return {
		chatId: 'chat-1',
		permissionRequestId: 'reused-request',
		incarnation,
		requestedTool: new BashToolUseMessage(PERMISSION_TIMESTAMP, 'tool-1', 'pwd'),
		...(withCapability
			? {
					control: {
						serverInstanceId: 'server-1',
						chatId: 'chat-1',
						runId: 'run-1',
						id: 'reused-request',
						incarnation,
					},
					transcript: { transcriptViewId: 'generation-1', afterOrdinal: 2 },
				}
			: {}),
	};
}

describe('ConversationTranscript', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	afterEach(() => {
		cleanup();
	});

	it('binds durable and pending row identities to rendered message roots', () => {
		const rows: ChatDisplayRow[] = [
			{
				kind: 'message',
				id: 'generation-1:1',
				ordinal: 1,
				message: new UserMessage('2026-07-22T00:00:00.000Z', 'Durable message'),
			},
			{
				kind: 'message',
				id: 'pending:request-1',
				message: new UserMessage('2026-07-22T00:00:01.000Z', 'Pending message'),
			},
		];

		const { container } = render(ConversationTranscriptTestHost, { rows });

		expect(
			Array.from(
				container.querySelectorAll<HTMLElement>('[data-chat-row-id]'),
				(row) => row.dataset.chatRowId,
			),
		).toEqual(['generation-1:1', 'pending:request-1']);
		expect(
			Array.from(
				container.querySelectorAll<HTMLElement>('[data-chat-anchor-id]'),
				(row) => row.dataset.chatAnchorId,
			),
		).toEqual(['generation-1:1']);
	});

	it('keeps historical permission occurrences non-actionable without an exact transient match', () => {
		render(ConversationTranscriptTestHost, {
			rows: [permissionRow('historical-incarnation')],
			pendingPermissionRequests: [
				pendingPermission('historical-incarnation', false),
				pendingPermission('different-incarnation', true),
			],
			onPermissionDecision: vi.fn(),
		});

		expect(screen.queryByRole('button', { name: /allow once/i })).toBeNull();
		expect(screen.queryByRole('button', { name: /^deny$/i })).toBeNull();
	});

	it('makes a durable permission occurrence actionable only through its transient capability', async () => {
		const onPermissionDecision = vi.fn();
		render(ConversationTranscriptTestHost, {
			rows: [permissionRow('active-incarnation')],
			pendingPermissionRequests: [pendingPermission('active-incarnation', true)],
			onPermissionDecision,
		});

		await fireEvent.click(screen.getByRole('button', { name: /allow once/i }));
		expect(onPermissionDecision).toHaveBeenCalledWith(
			'reused-request',
			'active-incarnation',
			{ allow: true },
		);
	});
});
