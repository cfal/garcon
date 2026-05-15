import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { UserMessage, type UserMessageDeliveryStatus } from '$shared/chat-types';
import ConversationMessageHarness from './ConversationMessageHarness.svelte';

function renderUserDeliveryStatus(deliveryStatus: UserMessageDeliveryStatus) {
	render(ConversationMessageHarness, {
		message: new UserMessage('2026-05-14T00:00:00.000Z', 'hello', undefined, {
			messageId: 'msg-1',
			clientRequestId: 'req-1',
			deliveryStatus,
		}),
	});
}

describe('ConversationMessage delivery status', () => {
	it('renders a sending indicator for submitting user messages', () => {
		renderUserDeliveryStatus('submitting');

		expect(screen.getByLabelText('Sending')).toBeTruthy();
	});

	it('renders a sent indicator for accepted user messages', () => {
		renderUserDeliveryStatus('accepted');

		expect(screen.getByLabelText('Sent')).toBeTruthy();
	});

	it('renders a failed indicator for failed user messages', () => {
		renderUserDeliveryStatus('failed');

		expect(screen.getByLabelText('Failed to send')).toBeTruthy();
	});
});
