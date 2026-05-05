import * as m from '$lib/paraglide/messages.js';
import {
	DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID,
	DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_HARNESS_ID,
	DIRECT_OPENAI_RESPONSES_COMPATIBLE_HARNESS_ID,
} from '$shared/providers';

export function harnessLabelFor(harnessId: string, fallback?: string): string {
	if (harnessId === 'claude') return m.provider_claude();
	if (harnessId === 'codex') return m.provider_codex();
	if (harnessId === 'opencode') return m.provider_opencode();
	if (harnessId === 'amp') return m.provider_amp();
	if (harnessId === 'factory') return m.provider_factory();
	if (harnessId === DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_HARNESS_ID) {
		return m.provider_direct_openai_chat_completions();
	}
	if (harnessId === DIRECT_OPENAI_RESPONSES_COMPATIBLE_HARNESS_ID) {
		return m.provider_direct_openai_responses();
	}
	if (harnessId === DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID) {
		return m.provider_direct_anthropic();
	}
	return fallback ?? harnessId;
}

export function nativeSourceLabelFor(harnessId: string, fallback?: string): string {
	if (harnessId === 'claude') return m.provider_claude_oauth();
	if (harnessId === 'codex') return m.provider_openai_oauth();
	return harnessLabelFor(harnessId, fallback);
}
