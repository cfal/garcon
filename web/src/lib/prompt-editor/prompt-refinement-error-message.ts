import { ApiError } from '$lib/api/client.js';
import * as m from '$lib/paraglide/messages.js';

export function promptRefinementErrorMessage(error: unknown): string {
	if (error instanceof ApiError) {
		switch (error.errorCode) {
			case 'PROMPT_REFINEMENT_INVALID_REQUEST':
				return m.prompt_refinement_error_invalid_request();
			case 'PROMPT_REFINEMENT_INPUT_TOO_LONG':
				return m.prompt_refinement_error_input_too_long();
			case 'PROMPT_REFINEMENT_UNAVAILABLE':
				return m.prompt_refinement_error_unavailable();
			case 'PROMPT_REFINEMENT_UNSAFE_AGENT':
				return m.prompt_refinement_error_unsafe_agent();
			case 'PROMPT_REFINEMENT_TEMPLATE_INVALID':
				return m.prompt_refinement_error_invalid_template();
			case 'PROMPT_REFINEMENT_AUTH_REQUIRED':
				return m.prompt_refinement_error_auth_required();
			case 'PROMPT_REFINEMENT_RATE_LIMITED':
				return m.prompt_refinement_error_rate_limited();
			case 'PROMPT_REFINEMENT_AGENT_UNAVAILABLE':
				return m.prompt_refinement_error_agent_unavailable();
			case 'PROMPT_REFINEMENT_UNSUPPORTED_EFFORT':
				return m.prompt_refinement_error_unsupported_effort();
			case 'PROMPT_REFINEMENT_EMPTY_RESPONSE':
				return m.prompt_refinement_error_empty_response();
			case 'PROMPT_REFINEMENT_OUTPUT_TOO_LONG':
				return m.prompt_refinement_error_output_too_large();
			case 'PROMPT_REFINEMENT_TOKEN_SIGNATURE_CHANGED':
				return m.prompt_refinement_error_token_signature_changed();
			case 'PROMPT_REFINEMENT_TIMEOUT':
				return m.prompt_refinement_error_timeout();
			case 'RATE_LIMITED':
				return m.prompt_refinement_error_rate_limited();
		}
	}
	if (
		error instanceof DOMException &&
		(error.name === 'AbortError' || error.name === 'TimeoutError')
	) {
		return m.prompt_refinement_error_timeout();
	}
	return m.prompt_refinement_error_failed();
}
