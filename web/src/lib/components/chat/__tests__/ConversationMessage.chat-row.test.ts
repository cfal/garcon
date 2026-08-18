import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { ErrorMessage, TranscriptNoticeMessage } from '$shared/chat-types';
import ConversationMessageHost from './ConversationMessageHost.svelte';

const AT = '2026-08-18T12:00:00.000Z';

describe('ConversationMessage chat rows', () => {
	afterEach(() => cleanup());

	it('renders notice content as an information card without an action', () => {
		const { container } = render(ConversationMessageHost, {
			message: new TranscriptNoticeMessage(AT, 'Synthetic notice.\nSecond line.'),
		});

		const card = container.querySelector('article');
		expect(card?.querySelector('.whitespace-pre-wrap')?.textContent).toBe(
			'Synthetic notice.\nSecond line.',
		);
		expect(card?.className).toContain('border-status-info-border');
		expect(card?.querySelector('button')).toBeNull();
	});

	it('renders errors with the error-card presentation', () => {
		render(ConversationMessageHost, {
			message: new ErrorMessage(AT, 'Synthetic error.'),
		});

		const card = screen.getByText('Synthetic error.').closest('article');
		expect(card?.className).toContain('border-status-error-border');
		expect(screen.getByText('Error')).toBeTruthy();
	});
});
