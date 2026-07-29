import * as m from '$lib/paraglide/messages.js';
import { directAgentShortLabel } from './direct-agents.js';

export function agentLabelFor(agentId: string, fallback?: string): string {
	if (agentId === 'claude') return m.agent_claude();
	if (agentId === 'codex') return m.agent_codex();
	if (agentId === 'cursor') return m.agent_cursor();
	if (agentId === 'opencode') return m.agent_opencode();
	if (agentId === 'amp') return m.agent_amp();
	if (agentId === 'factory') return m.agent_factory();
	if (agentId === 'pi') return m.agent_pi();
	const directLabel = directAgentShortLabel(agentId);
	if (directLabel !== null) return m.agent_direct_qualified({ agent: directLabel });
	return fallback ?? agentId;
}

export function nativeSourceLabelFor(agentId: string, fallback?: string): string {
	if (agentId === 'claude') return m.agent_claude_oauth();
	if (agentId === 'codex') return m.agent_openai_oauth();
	return agentLabelFor(agentId, fallback);
}
