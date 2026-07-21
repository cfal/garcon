import { describe, expect, it } from 'vitest';
import {
	canShowForkAtMessageAction,
	canUseForkAction,
	canUseForkAtMessageAction,
} from '$lib/chat/actions/fork-at-message-action.js';

describe('canUseForkAction', () => {
	it('disables whole-chat fork when the agent does not support forking', () => {
		expect(
			canUseForkAction({
				supportsFork: false,
				isProcessing: false,
			}),
		).toBe(false);
	});

	it('allows idle whole-chat forks when the agent supports forking', () => {
		expect(
			canUseForkAction({
				supportsFork: true,
				isProcessing: false,
			}),
		).toBe(true);
	});

	it('disables whole-chat forks while processing', () => {
		expect(
			canUseForkAction({
				supportsFork: true,
				isProcessing: true,
			}),
		).toBe(false);
	});
});

describe('canShowForkAtMessageAction', () => {
	it('hides the action when the agent does not support message-point fork', () => {
		expect(
			canShowForkAtMessageAction({
				supportsForkAtMessage: false,
			}),
		).toBe(false);
	});

	it('shows the action when message-point fork is supported', () => {
		expect(
			canShowForkAtMessageAction({
				supportsForkAtMessage: true,
			}),
		).toBe(true);
	});
});

describe('canUseForkAtMessageAction', () => {
	it('disables the action when the agent does not support message-point fork', () => {
		expect(
			canUseForkAtMessageAction({
				supportsForkAtMessage: false,
				supportsForkAtMessageWhileRunning: true,
				isProcessing: false,
			}),
		).toBe(false);
	});

	it('allows idle message-point forks when message-point fork is supported', () => {
		expect(
			canUseForkAtMessageAction({
				supportsForkAtMessage: true,
				supportsForkAtMessageWhileRunning: false,
				isProcessing: false,
			}),
		).toBe(true);
	});

	it('disables running message-point forks unless running fork is supported', () => {
		expect(
			canUseForkAtMessageAction({
				supportsForkAtMessage: true,
				supportsForkAtMessageWhileRunning: false,
				isProcessing: true,
			}),
		).toBe(false);
		expect(
			canUseForkAtMessageAction({
				supportsForkAtMessage: true,
				supportsForkAtMessageWhileRunning: true,
				isProcessing: true,
			}),
		).toBe(true);
	});
});
