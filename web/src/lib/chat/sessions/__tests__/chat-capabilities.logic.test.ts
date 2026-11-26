import { expect, test } from 'vitest';
import { canExecuteChat } from '../chat-capabilities.js';

test('only an explicitly executable chat admits input', () => {
	expect(canExecuteChat({ observation: null })).toBe(true);
	expect(canExecuteChat(null)).toBe(false);
	expect(canExecuteChat(undefined)).toBe(false);
	for (const captureStatus of ['attached', 'detached'] as const) {
		expect(canExecuteChat({ observation: { kind: 'native-child', captureStatus, isWorking: false } })).toBe(false);
	}
	expect(canExecuteChat({ observation: { kind: 'native-child', captureStatus: 'attached', isWorking: true } })).toBe(false);
});
