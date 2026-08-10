import { describe, expect, it } from 'vitest';
import {
	steerSubmissionRejection,
	steerSubmissionRejectionNotice,
} from '../steer-submission-policy.js';

describe('steerSubmissionRejection', () => {
	const validate = (overrides: Partial<Parameters<typeof steerSubmissionRejection>[0]> = {}) =>
		steerSubmissionRejection({
			prompt: 'Focus on the failing test',
			supportsSteering: true,
			attachmentCount: 0,
			handoffPending: false,
			...overrides,
		});

	it('accepts supported text-only steering with no handoff', () => {
		expect(validate()).toBeNull();
	});

	it('rejects invalid submissions in user-action order', () => {
		expect(
			validate({
				prompt: ' ',
				supportsSteering: false,
				attachmentCount: 1,
				handoffPending: true,
			}),
		).toBe('prompt-required');
		expect(validate({ supportsSteering: false, attachmentCount: 1, handoffPending: true })).toBe(
			'unsupported',
		);
		expect(validate({ attachmentCount: 1, handoffPending: true })).toBe('attachments-unavailable');
		expect(validate({ handoffPending: true })).toBe('handoff-pending');
	});

	it('maps every rejection to the existing localized notice', () => {
		expect(steerSubmissionRejectionNotice('prompt-required')).toBe('Add guidance after /steer.');
		expect(steerSubmissionRejectionNotice('unsupported')).toBe(
			'/steer is not supported by this agent.',
		);
		expect(steerSubmissionRejectionNotice('attachments-unavailable')).toBe(
			'Remove attachments before steering the active turn.',
		);
		expect(steerSubmissionRejectionNotice('handoff-pending')).toContain('another agent');
	});
});
