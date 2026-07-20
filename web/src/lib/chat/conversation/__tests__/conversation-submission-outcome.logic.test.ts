import { describe, expect, it } from 'vitest';
import { isAcceptedConversationSubmission } from '../conversation-submission-outcome.js';

describe('conversation submission outcome', () => {
	it('reports success only after server acceptance', () => {
		expect(isAcceptedConversationSubmission('accepted')).toBe(true);
		expect(isAcceptedConversationSubmission('rejected')).toBe(false);
		expect(isAcceptedConversationSubmission('unknown')).toBe(false);
		expect(isAcceptedConversationSubmission('no-op')).toBe(false);
	});
});
