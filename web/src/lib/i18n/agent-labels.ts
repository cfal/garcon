import * as m from '$lib/paraglide/messages.js';
import {
	DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID,
	DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_HARNESS_ID,
	DIRECT_OPENAI_RESPONSES_COMPATIBLE_HARNESS_ID,
} from '$shared/providers';

export function agentLabelFor(agentId: string, fallback?: string): string {
	if (agentId === 'claude') return m.provider_claude();
	if (agentId === 'codex') return m.provider_codex();
	if (agentId === 'cursor') return m.provider_cursor();
	if (agentId === 'opencode') return m.provider_opencode();
	if (agentId === 'amp') return m.provider_amp();
	if (agentId === 'factory') return m.provider_factory();
	if (agentId === 'pi') return m.provider_pi();
	if (agentId === DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_HARNESS_ID) {
		return m.provider_direct_openai_chat_completions();
	}
	if (agentId === DIRECT_OPENAI_RESPONSES_COMPATIBLE_HARNESS_ID) {
		return m.provider_direct_openai_responses();
	}
	if (agentId === DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID) {
		return m.provider_direct_anthropic();
	}
	return fallback ?? agentId;
}

export function nativeSourceLabelFor(agentId: string, fallback?: string): string {
	if (agentId === 'claude') return m.provider_claude_oauth();
	if (agentId === 'codex') return m.provider_openai_oauth();
	return agentLabelFor(agentId, fallback);
}
