import { describe, expect, it, vi } from 'vitest';
import { goto } from '$app/navigation';
import { gotoChat } from '$lib/chat/actions/chat-navigation.js';

vi.mock('$app/navigation', () => ({
	goto: vi.fn(() => Promise.resolve()),
}));

describe('gotoChat', () => {
	it('preserves focus during chat route navigation', () => {
		void gotoChat('chat-123');

		expect(goto).toHaveBeenCalledWith('/chat/chat-123', { keepFocus: true });
	});
});
