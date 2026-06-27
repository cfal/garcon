import { describe, expect, it } from 'vitest';
import {
	canShowForkAtMessageAction,
	canUseForkAction,
	canUseForkAtMessageAction,
} from '../fork-at-message-action';

describe('canUseForkAction', () => {
	it('disables whole-chat fork when the agent does not support forking', () => {
		expect(
			canUseForkAction({
				supportsFork: false,
				supportsForkWhileRunning: true,
				isProcessing: false,
			}),
		).toBe(false);
	});

	it('allows idle whole-chat forks when the agent supports forking', () => {
		expect(
			canUseForkAction({
				supportsFork: true,
				supportsForkWhileRunning: false,
				isProcessing: false,
			}),
		).toBe(true);
	});

	it('disables running whole-chat forks unless running fork is supported', () => {
		expect(
			canUseForkAction({
				supportsFork: true,
				supportsForkWhileRunning: false,
				isProcessing: true,
			}),
		).toBe(false);
		expect(
			canUseForkAction({
				supportsFork: true,
				supportsForkWhileRunning: true,
				isProcessing: true,
			}),
		).toBe(true);
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
				supportsForkWhileRunning: true,
				isProcessing: false,
			}),
		).toBe(false);
	});

	it('allows idle message-point forks when message-point fork is supported', () => {
		expect(
			canUseForkAtMessageAction({
				supportsForkAtMessage: true,
				supportsForkWhileRunning: false,
				isProcessing: false,
			}),
		).toBe(true);
	});

	it('disables running message-point forks unless running fork is supported', () => {
		expect(
			canUseForkAtMessageAction({
				supportsForkAtMessage: true,
				supportsForkWhileRunning: false,
				isProcessing: true,
			}),
		).toBe(false);
		expect(
			canUseForkAtMessageAction({
				supportsForkAtMessage: true,
				supportsForkWhileRunning: true,
				isProcessing: true,
			}),
		).toBe(true);
	});
});
