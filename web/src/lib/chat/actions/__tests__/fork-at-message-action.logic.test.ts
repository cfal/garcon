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

describe('fork-at-message view recovery', () => {
	it('refuses to remap duplicate content when a bounded window shifts', () => {
		const duplicate = new AssistantMessage('2026-07-29T00:00:00.000Z', 'same reply');
		const selection = selectForkAtMessage([
			{ ordinal: 4, message: duplicate },
			{ ordinal: 5, message: new AssistantMessage('2026-07-29T00:00:01.000Z', 'same reply') },
		], 'view-1', 5);

		expect(selection).not.toBeNull();
		expect(remapForkAtMessage([
			{ ordinal: 8, message: new AssistantMessage('2026-07-29T01:00:00.000Z', 'same reply') },
			{ ordinal: 9, message: new AssistantMessage('2026-07-29T01:00:01.000Z', 'same reply') },
		], 'view-2', selection!)).toBeNull();
	});

	it('uses user message identity when presentation fields change', () => {
		const selection = selectForkAtMessage([{
			ordinal: 3,
			message: new UserMessage('2026-07-29T00:00:00.000Z', 'before', undefined, {
				clientMessageId: 'message-1',
			}),
		}], 'view-1', 3);

		expect(remapForkAtMessage([{
			ordinal: 7,
			message: new UserMessage('2026-07-29T01:00:00.000Z', 'after', undefined, {
				clientMessageId: 'message-1',
			}),
		}], 'view-2', selection!)).toMatchObject({
			ordinal: 7,
			transcriptViewId: 'view-2',
		});
	});

	it('refuses missing or duplicate client identities in either window', () => {
		const message = new UserMessage('2026-07-29T00:00:00.000Z', 'prompt', undefined, {
			clientMessageId: 'message-1',
		});
		const entries = [{ ordinal: 1, message }, { ordinal: 2, message }];
		const selection = selectForkAtMessage(entries.slice(0, 1), 'view-1', 1)!;
		expect(remapForkAtMessage([], 'view-2', selection)).toBeNull();
		expect(remapForkAtMessage(entries, 'view-2', selection)).toBeNull();
		const ambiguous = selectForkAtMessage(entries, 'view-1', 1)!;
		expect(remapForkAtMessage(entries.slice(0, 1), 'view-2', ambiguous)).toBeNull();
	});
});
