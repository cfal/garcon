import { describe, expect, it } from 'vitest';
import { normalizePendingUserInput } from '$shared/pending-user-input';

describe('pending user input', () => {
	it('rejects obsolete delivered delivery status', () => {
		const input = normalizePendingUserInput({
			chatId: 'chat-1',
			clientRequestId: 'request-1',
			content: 'hello',
			createdAt: '2026-06-01T00:00:00.000Z',
			deliveryStatus: 'delivered',
		});

		expect(input).toBeNull();
	});
});
