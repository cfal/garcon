import { describe, expect, it } from 'vitest';
import { selectedChatIdFromRoute } from '../app-shell-route';

describe('selectedChatIdFromRoute', () => {
	it('clears the selected chat for bare chat routes', () => {
		expect(selectedChatIdFromRoute('/chat', undefined)).toBeNull();
		expect(selectedChatIdFromRoute('/chat/', undefined)).toBeNull();
	});
});
