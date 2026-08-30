import { describe, expect, it } from 'vitest';
import type { InterAgentMessageFailureReason } from '$shared/transcript-notice-details';
import { interAgentMessageFailureLabel } from '../inter-agent-message-presentation';

describe('inter-agent message presentation', () => {
	it.each([
		['disabled', 'agent messaging is disabled'],
		['self-send', 'cannot send to the same chat'],
		['target-not-found', 'chat not found'],
		['target-unavailable', 'chat unavailable'],
		['queue-full', 'message queue is full'],
		['provider-rejected', 'target agent rejected the message'],
		['delivery-unknown', 'delivery could not be confirmed'],
		['server-shutting-down', 'server is shutting down'],
		['delivery-failed', 'delivery failed'],
	] satisfies readonly (readonly [InterAgentMessageFailureReason, string])[])(
		'renders %s as actionable copy',
		(reason, expected) => {
			expect(interAgentMessageFailureLabel(reason)).toBe(expected);
		},
	);
});
