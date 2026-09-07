import * as m from '$lib/paraglide/messages.js';
import type { SessionAgentId } from '$lib/types/app';
import {
	DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
	DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
	DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
} from '$shared/agents';

export const DIRECT_AGENT_PRESENTATIONS = [
	{
		id: DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
		label: m.agent_direct_openai_chat_completions,
	},
	{
		id: DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
		label: m.agent_direct_openai_responses,
	},
	{
		id: DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
		label: m.agent_direct_anthropic,
	},
] as const;

export type DirectAgentId = (typeof DIRECT_AGENT_PRESENTATIONS)[number]['id'];

const DIRECT_AGENT_IDS = new Set<string>(
	DIRECT_AGENT_PRESENTATIONS.map((presentation) => presentation.id),
);

export function isDirectAgentId(agentId: string): agentId is DirectAgentId {
	return DIRECT_AGENT_IDS.has(agentId);
}

export function directAgentShortLabel(agentId: string): string | null {
	return (
		DIRECT_AGENT_PRESENTATIONS.find((presentation) => presentation.id === agentId)?.label() ??
		null
	);
}

export function nonDirectAgentIds(
	agentIds: readonly SessionAgentId[],
): readonly SessionAgentId[] {
	return agentIds.filter((agentId) => !isDirectAgentId(agentId));
}
