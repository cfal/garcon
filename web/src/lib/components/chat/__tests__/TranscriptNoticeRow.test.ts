import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { TranscriptNoticeMessage } from '$shared/chat-types';
import TranscriptNoticeRow from '../rows/TranscriptNoticeRow.svelte';

const AT = '2026-08-28T00:00:00.000Z';

describe('TranscriptNoticeRow', () => {
	it('[TLV5-CHAT-ID-DISCOVERY.07-WEB-UNIT-01] renders chat ID discovery failures as error event cards', () => {
		const { container } = render(TranscriptNoticeRow, {
			message: new TranscriptNoticeMessage(
				AT,
				'Garcon could not send the chat ID to the agent.',
				{ type: 'chat-id-discovery-failure', reason: 'delivery-failed' },
				'Chat ID auto-discovery',
			),
		});

		expect(screen.getByText('Chat ID auto-discovery')).toBeTruthy();
		expect(screen.getByText(/could not send the chat ID/)).toBeTruthy();
		expect(container.querySelector('article')?.className).toContain('border-status-error-border');
	});
});
