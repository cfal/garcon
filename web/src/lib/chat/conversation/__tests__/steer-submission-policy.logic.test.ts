import { describe, expect, it } from 'vitest';
import {
	steerShortcutRejectionNotice,
	steerSubmissionRejection,
	steerSubmissionRejectionNotice,
} from '../steer-submission-policy.js';

describe('steerSubmissionRejection', () => {
	const validate = (overrides: Partial<Parameters<typeof steerSubmissionRejection>[0]> = {}) =>
		steerSubmissionRejection({
			prompt: 'Focus on the failing test',
			supportsSteering: true,
			attachmentCount: 0,
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
			}),
		).toBe('prompt-required');
		expect(validate({ supportsSteering: false, attachmentCount: 1 })).toBe('unsupported');
		expect(validate({ attachmentCount: 1 })).toBe('attachments-unavailable');
	});

	it('maps every rejection to the existing localized notice', () => {
		expect(steerSubmissionRejectionNotice('prompt-required')).toBe('Add guidance after /steer.');
		expect(steerSubmissionRejectionNotice('unsupported')).toBe(
			'/steer is not supported by this agent.',
		);
		expect(steerSubmissionRejectionNotice('attachments-unavailable')).toBe(
			'Remove attachments before steering the active turn.',
		);
	});

	it('uses command-neutral copy for shortcut eligibility failures', () => {
		expect(steerShortcutRejectionNotice('unsupported')).toBe(
			'This agent does not support steering.',
		);
	});
});
