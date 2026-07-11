import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { UserMessage, type UserMessageDeliveryStatus } from '$shared/chat-types';
import ConversationMessageHost from './ConversationMessageHost.svelte';

function renderUserDeliveryStatus(deliveryStatus: UserMessageDeliveryStatus) {
	return render(ConversationMessageHost, {
		message: new UserMessage('2026-05-14T00:00:00.000Z', 'hello', undefined, {
			clientRequestId: 'req-1',
			deliveryStatus,
		}),
	});
}

describe('ConversationMessage delivery status', () => {
	it('renders a sending indicator for submitting user messages', () => {
		const { container } = renderUserDeliveryStatus('submitting');

		const indicator = screen.getByLabelText('Sending');
		const rail = container.querySelector('.user-message-accessory-rail') as HTMLElement;
		expect(indicator.parentElement).toBe(rail);
		expect(indicator.className).toContain('absolute');
		expect(indicator.querySelector('svg')?.getAttribute('class')).toContain('size-3.5');
		expect(rail.className).not.toMatch(/(?:^|\s)(?:h|min-h)-/);
	});

	it('keeps the accessory rail when an accepted message removes its delivery indicator', () => {
		const { container } = renderUserDeliveryStatus('accepted');

		expect(screen.queryByLabelText('Sent')).toBeNull();
		expect(container.querySelector('.user-message-accessory-rail')).toBeTruthy();
	});

	it('renders a failed indicator for failed user messages', () => {
		renderUserDeliveryStatus('failed');

		expect(screen.getByLabelText('Failed to send')).toBeTruthy();
	});
});
