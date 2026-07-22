import { cleanup, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatDisplayRow } from '$lib/chat/transcript/active-transcript-state.svelte.js';
import { UserMessage } from '$shared/chat-types';
import ConversationTranscriptTestHost from './ConversationTranscriptTestHost.svelte';

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
				seq: 1,
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
	});
});
