import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { TranscriptNoticeMessage } from '$shared/chat-types';
import TranscriptNoticeRow from '../rows/TranscriptNoticeRow.svelte';

const AT = '2026-08-28T00:00:00.000Z';

describe('TranscriptNoticeRow', () => {
	it('renders an ordered title-only preamble update notice', () => {
		const { container } = render(TranscriptNoticeRow, {
			message: new TranscriptNoticeMessage(
				AT,
				'Preambles updated',
				{
					type: 'preamble-selection-changed',
					preambles: [
						{
							id: '3502b645-222b-49d2-ac39-1c91f9fb1174',
							title: 'Security constraints',
						},
						{
							id: '80becfa6-c9c7-4b31-9190-fd23c0bedf9c',
							title: 'Repository conventions',
						},
					],
				},
			),
		});

		expect(screen.getByText('Preambles updated')).toBeTruthy();
		expect(
			[...container.querySelectorAll('[data-slot="preamble-selection-changed-title"]')].map(
				(element) => element.textContent,
			),
		).toEqual(['Security constraints', 'Repository conventions']);
		expect(container.textContent).not.toContain('private body');
	});

	it('renders None enabled for an empty preamble update notice', () => {
		render(TranscriptNoticeRow, {
			message: new TranscriptNoticeMessage(
				AT,
				'Preambles updated',
				{ type: 'preamble-selection-changed', preambles: [] },
			),
		});

		expect(screen.getByText('None enabled')).toBeTruthy();
	});

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
