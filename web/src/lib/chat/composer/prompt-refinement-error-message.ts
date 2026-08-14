import { ApiError } from '$lib/api/client.js';
import * as m from '$lib/paraglide/messages.js';

export function promptRefinementErrorMessage(error: unknown): string {
	if (error instanceof ApiError) {
		switch (error.errorCode) {
			case 'PROMPT_REFINEMENT_INVALID_REQUEST':
				return m.prompt_refinement_error_invalid_request();
			case 'PROMPT_REFINEMENT_UNAVAILABLE':
				return m.prompt_refinement_error_unavailable();
			case 'PROMPT_REFINEMENT_UNSAFE_AGENT':
				return m.prompt_refinement_error_unsafe_agent();
			case 'PROMPT_REFINEMENT_INVALID_TEMPLATE':
				return m.prompt_refinement_error_invalid_template();
			case 'PROMPT_REFINEMENT_UNSUPPORTED_EFFORT':
				return m.prompt_refinement_error_unsupported_effort();
			case 'PROMPT_REFINEMENT_EMPTY_RESPONSE':
				return m.prompt_refinement_error_empty_response();
			case 'PROMPT_REFINEMENT_OUTPUT_TOO_LARGE':
				return m.prompt_refinement_error_output_too_large();
			case 'PROMPT_REFINEMENT_TIMEOUT':
				return m.prompt_refinement_error_timeout();
			case 'RATE_LIMITED':
				return m.prompt_refinement_error_rate_limited();
		}
	}
	if (
		error instanceof DOMException
		&& (error.name === 'AbortError' || error.name === 'TimeoutError')
	) {
		return m.prompt_refinement_error_timeout();
	}
	return m.prompt_refinement_error_failed();
}
