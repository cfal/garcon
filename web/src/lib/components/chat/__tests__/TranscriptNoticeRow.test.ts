import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { TranscriptNoticeMessage } from '$shared/chat-types';
import TranscriptNoticeRow from '../rows/TranscriptNoticeRow.svelte';

const AT = '2026-08-28T00:00:00.000Z';

describe('TranscriptNoticeRow', () => {
	it('renders disabled chat ID discovery as an error event card', () => {
		const { container } = render(TranscriptNoticeRow, {
			message: new TranscriptNoticeMessage(
				AT,
				'Chat ID auto-discovery is disabled.',
				{ type: 'chat-id-discovery-disabled' },
				'Request: Garcon Chat ID',
			),
		});

		expect(screen.getByText('Request: Garcon Chat ID')).toBeTruthy();
		expect(screen.getByText('Chat ID auto-discovery is disabled.')).toBeTruthy();
		expect(container.querySelector('article')?.className).toContain('border-status-error-border');
	});
});
