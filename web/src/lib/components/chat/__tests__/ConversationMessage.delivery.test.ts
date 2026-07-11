import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { UserMessage, type UserMessageDeliveryStatus } from '$shared/chat-types';
import ConversationMessageHost from './ConversationMessageHost.svelte';

function renderUserDeliveryStatus(deliveryStatus: UserMessageDeliveryStatus) {
	render(ConversationMessageHost, {
		message: new UserMessage('2026-05-14T00:00:00.000Z', 'hello', undefined, {
			clientRequestId: 'req-1',
			deliveryStatus,
		}),
	});
}

describe('ConversationMessage delivery status', () => {
	it('renders a sending indicator for submitting user messages', () => {
		renderUserDeliveryStatus('submitting');

		const indicator = screen.getByLabelText('Sending');
		expect(indicator.parentElement?.classList.contains('items-center')).toBe(true);
		expect(indicator.previousElementSibling?.getAttribute('data-slot')).toBe('context-menu-trigger');
	});

	it('removes the delivery indicator for accepted user messages', () => {
		renderUserDeliveryStatus('accepted');

		expect(screen.queryByLabelText('Sent')).toBeNull();
	});

	it('renders a failed indicator for failed user messages', () => {
		renderUserDeliveryStatus('failed');

		expect(screen.getByLabelText('Failed to send')).toBeTruthy();
	});
});
