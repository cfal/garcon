import type { SessionAgentId } from '$lib/types/app';
import {
	DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
	DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
	DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
} from '$shared/agents';

export const DIRECT_AGENT_IDS = [
	DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
	DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
	DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
] as const;

export type DirectAgentId = (typeof DIRECT_AGENT_IDS)[number];

const DIRECT_AGENT_ID_SET = new Set<string>(DIRECT_AGENT_IDS);

export function isDirectAgentId(agentId: string): agentId is DirectAgentId {
	return DIRECT_AGENT_ID_SET.has(agentId);
}

export function nonDirectAgentIds(
	agentIds: readonly SessionAgentId[],
): readonly SessionAgentId[] {
	return agentIds.filter((agentId) => !isDirectAgentId(agentId));
}
