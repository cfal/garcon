import { describe, expect, it } from 'vitest';
import type {
	InterAgentMessageFailureReason,
	InterAgentMessageResult,
} from '$shared/transcript-notice-details';
import { stripLegacyInterAgentOutcomePrefix } from '../inter-agent-message-presentation';

const TARGET_CHAT_ID = '1788090107980901';

describe('inter-agent message presentation', () => {
	it('strips the exact durable legacy delivery block', () => {
		const results = [
			{ chatId: TARGET_CHAT_ID, status: 'delivered' },
			{ chatId: '1788090107980902', status: 'queued' },
			{
				chatId: '1788090107980903',
				status: 'failed',
				reason: 'target-not-found',
			},
		] satisfies readonly InterAgentMessageResult[];
		const content = [
			`Delivered: ${TARGET_CHAT_ID}`,
			'Queued: 1788090107980902 (pending delivery is not retained across server restart)',
			'Failed: 1788090107980903 (chat not found)',
			'',
			'Original **message**.',
		].join('\n');

		expect(stripLegacyInterAgentOutcomePrefix(content, results)).toBe('Original **message**.');
	});

	it.each([
		['disabled', 'agent messaging is disabled'],
		['self-send', 'cannot send to the source chat'],
		['target-not-found', 'chat not found'],
		['target-unavailable', 'chat unavailable'],
		['queue-full', 'control input queue full'],
		['provider-rejected', 'target agent rejected the message'],
		['delivery-unknown', 'delivery may have occurred; no retry was queued'],
		['server-shutting-down', 'server shutting down'],
		['delivery-failed', 'delivery failed'],
	] satisfies readonly (readonly [InterAgentMessageFailureReason, string])[])(
		'strips the legacy %s failure line',
		(reason, legacyText) => {
			const results = [
				{ chatId: TARGET_CHAT_ID, status: 'failed', reason },
			] satisfies readonly InterAgentMessageResult[];
			expect(
				stripLegacyInterAgentOutcomePrefix(
					`Failed: ${TARGET_CHAT_ID} (${legacyText})\n\nMessage body.`,
					results,
				),
			).toBe('Message body.');
		},
	);

	it('preserves content whose opening block does not exactly match its typed results', () => {
		const results = [
			{ chatId: TARGET_CHAT_ID, status: 'delivered' },
		] satisfies readonly InterAgentMessageResult[];
		const content = `Delivered: 1788090107980999\n\nMessage body.`;

		expect(stripLegacyInterAgentOutcomePrefix(content, results)).toBe(content);
		expect(stripLegacyInterAgentOutcomePrefix(content, [])).toBe(content);
	});
});
