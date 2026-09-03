import { describe, expect, it } from 'vitest';
import type { UserMessagePresentation } from '$shared/chat-types';
import { userMessageBodyDisclosure } from '../user-message-body-disclosure.js';

describe('userMessageBodyDisclosure', () => {
	it('collapses ordinary user messages by default', () => {
		expect(userMessageBodyDisclosure(undefined)).toBe('collapsed');
		expect(userMessageBodyDisclosure(null)).toBe('collapsed');
	});

	it('preserves CLI-authored disclosure intent', () => {
		const expanded = {
			origin: 'cli',
			style: 'info',
		} satisfies UserMessagePresentation;
		const collapsed = {
			origin: 'cli',
			style: 'notice',
			disclosure: 'collapsed',
		} satisfies UserMessagePresentation;

		expect(userMessageBodyDisclosure(expanded)).toBeUndefined();
		expect(userMessageBodyDisclosure(collapsed)).toBe('collapsed');
	});
});
