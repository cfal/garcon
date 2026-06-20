import * as m from '$lib/paraglide/messages.js';
import {
	DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
	DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
	DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
} from '$shared/agents';

export function agentLabelFor(agentId: string, fallback?: string): string {
	if (agentId === 'claude') return m.agent_claude();
	if (agentId === 'codex') return m.agent_codex();
	if (agentId === 'cursor') return m.agent_cursor();
	if (agentId === 'opencode') return m.agent_opencode();
	if (agentId === 'amp') return m.agent_amp();
	if (agentId === 'factory') return m.agent_factory();
	if (agentId === 'pi') return m.agent_pi();
	if (agentId === DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID) {
		return m.agent_direct_openai_chat_completions();
	}
	if (agentId === DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID) {
		return m.agent_direct_openai_responses();
	}
	if (agentId === DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID) {
		return m.agent_direct_anthropic();
	}
	return fallback ?? agentId;
}

export function nativeSourceLabelFor(agentId: string, fallback?: string): string {
	if (agentId === 'claude') return m.agent_claude_oauth();
	if (agentId === 'codex') return m.agent_openai_oauth();
	return agentLabelFor(agentId, fallback);
}
