import { describe, expect, it } from 'vitest';
import { ApiError } from '$lib/api/client';
import { promptRefinementErrorMessage } from '../prompt-refinement-error-message';

describe('promptRefinementErrorMessage', () => {
	it('maps every actionable server failure without exposing raw details', () => {
		const cases = [
			['PROMPT_REFINEMENT_INVALID_REQUEST', 'This draft cannot be refined.'],
			['PROMPT_REFINEMENT_INPUT_TOO_LONG', 'too long to refine'],
			['PROMPT_REFINEMENT_UNAVAILABLE', 'No prompt refinement model is ready.'],
			['PROMPT_REFINEMENT_UNSAFE_AGENT', 'can run tools without permission'],
			['PROMPT_REFINEMENT_TEMPLATE_INVALID', 'saved refinement instructions are invalid'],
			['PROMPT_REFINEMENT_AUTH_REQUIRED', 'requires authentication'],
			['PROMPT_REFINEMENT_RATE_LIMITED', 'being used too quickly'],
			['PROMPT_REFINEMENT_AGENT_UNAVAILABLE', 'refinement agent is unavailable'],
			['PROMPT_REFINEMENT_UNSUPPORTED_EFFORT', 'cannot use this effort'],
			['PROMPT_REFINEMENT_EMPTY_RESPONSE', 'returned no text'],
			['PROMPT_REFINEMENT_OUTPUT_TOO_LONG', 'too long for this editor'],
			['PROMPT_REFINEMENT_TOKEN_SIGNATURE_CHANGED', 'changed a snippet variable'],
			['PROMPT_REFINEMENT_TIMEOUT', 'timed out'],
			['RATE_LIMITED', 'being used too quickly'],
		] as const;

		for (const [code, expected] of cases) {
			const message = promptRefinementErrorMessage(
				new ApiError(500, 'private raw provider detail', code),
			);
			expect(message).toContain(expected);
			expect(message).not.toContain('private raw provider detail');
		}
	});

	it('maps client timeouts and unknown failures', () => {
		expect(promptRefinementErrorMessage(new DOMException('private', 'TimeoutError'))).toContain(
			'timed out',
		);
		expect(promptRefinementErrorMessage(new Error('private'))).toContain(
			'The prompt could not be refined.',
		);
	});
});
