import { describe, expect, it } from 'vitest';
import {
	canShowForkAtMessageAction,
	canUseForkAction,
	canUseForkAtMessageAction,
	remapForkAtMessage,
	selectForkAtMessage,
} from '$lib/chat/actions/fork-at-message-action.js';
import { AssistantMessage, UserMessage } from '$shared/chat-types';

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

describe('fork-at-message generation recovery', () => {
	it('remaps the selected message by identity and occurrence after renumbering', () => {
		const duplicate = new AssistantMessage('2026-07-29T00:00:00.000Z', 'same reply');
		const selection = selectForkAtMessage([
			{ seq: 4, message: duplicate },
			{ seq: 5, message: new AssistantMessage('2026-07-29T00:00:01.000Z', 'same reply') },
		], 'generation-1', 5);

		expect(selection).not.toBeNull();
		expect(remapForkAtMessage([
			{ seq: 8, message: new AssistantMessage('2026-07-29T01:00:00.000Z', 'same reply') },
			{ seq: 9, message: new AssistantMessage('2026-07-29T01:00:01.000Z', 'same reply') },
		], 'generation-2', selection!)).toMatchObject({
			seq: 9,
			generationId: 'generation-2',
			occurrence: 2,
		});
	});

	it('uses user delivery identity when presentation fields change', () => {
		const selection = selectForkAtMessage([{
			seq: 3,
			message: new UserMessage('2026-07-29T00:00:00.000Z', 'before', undefined, {
				clientRequestId: 'request-1',
				deliveryStatus: 'accepted',
			}),
		}], 'generation-1', 3);

		expect(remapForkAtMessage([{
			seq: 7,
			message: new UserMessage('2026-07-29T01:00:00.000Z', 'after', undefined, {
				clientRequestId: 'request-1',
				deliveryStatus: 'unconfirmed',
			}),
		}], 'generation-2', selection!)).toMatchObject({
			seq: 7,
			generationId: 'generation-2',
		});
	});
});
