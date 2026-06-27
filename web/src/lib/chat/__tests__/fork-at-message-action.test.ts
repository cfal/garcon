import { describe, expect, it } from 'vitest';
import { canShowForkAtMessageAction } from '../fork-at-message-action';

describe('canShowForkAtMessageAction', () => {
	it('hides the action when the agent does not support message-point fork', () => {
		expect(
			canShowForkAtMessageAction({
				supportsForkAtMessage: false,
				supportsForkWhileRunning: true,
				isProcessing: false,
			}),
		).toBe(false);
	});

	it('shows the action for idle chats when message-point fork is supported', () => {
		expect(
			canShowForkAtMessageAction({
				supportsForkAtMessage: true,
				supportsForkWhileRunning: false,
				isProcessing: false,
			}),
		).toBe(true);
	});

	it('hides the action for running chats unless running fork is supported', () => {
		expect(
			canShowForkAtMessageAction({
				supportsForkAtMessage: true,
				supportsForkWhileRunning: false,
				isProcessing: true,
			}),
		).toBe(false);
		expect(
			canShowForkAtMessageAction({
				supportsForkAtMessage: true,
				supportsForkWhileRunning: true,
				isProcessing: true,
			}),
		).toBe(true);
	});
});
