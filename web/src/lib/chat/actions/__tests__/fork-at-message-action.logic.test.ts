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
		const selection = selectForkAtMessage({ ordinal: 5, message: duplicate, submissionClientMessageId: null }, 'view-1');

		expect(selection).not.toBeNull();
		expect(remapForkAtMessage({ transcriptViewId: 'view-2', submissions: [] }, selection!)).toBeNull();
	});

	it('uses user message identity when presentation fields change', () => {
		const selection = selectForkAtMessage({
			ordinal: 3,
			submissionClientMessageId: 'message-1',
			message: new UserMessage('2026-07-29T00:00:00.000Z', 'before', undefined, {
				clientMessageId: 'message-1',
			}),
		}, 'view-1');

		expect(remapForkAtMessage({ transcriptViewId: 'view-2', submissions: [{ ordinal: 7, clientMessageId: 'message-1' }] }, selection!)).toMatchObject({
			ordinal: 7,
			transcriptViewId: 'view-2',
		});
	});

	it('trusts only the source-owned submission identity, not provider message metadata', () => {
		const message = new UserMessage('2026-07-29T00:00:00.000Z', 'prompt', undefined, {
			clientMessageId: 'message-1',
		});
		const selection = selectForkAtMessage({ ordinal: 1, message, submissionClientMessageId: null }, 'view-1')!;
		expect(selection.clientMessageId).toBeNull();
		expect(remapForkAtMessage({ transcriptViewId: 'view-2', submissions: [{ clientMessageId: 'message-1', ordinal: 2 }] }, selection)).toBeNull();
		const committed = { ...selection, clientMessageId: 'message-1' };
		expect(remapForkAtMessage({ transcriptViewId: 'view-2', submissions: [{ clientMessageId: 'message-1', ordinal: null }] }, committed)).toBeNull();
		expect(selectForkAtMessage(undefined, 'view-1')).toBeNull();
		expect(selectForkAtMessage({ ordinal: 1, message, submissionClientMessageId: null }, '')).toBeNull();
	});
});
