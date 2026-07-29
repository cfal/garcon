import { describe, expect, it } from 'vitest';
import {
	DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
	DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
	DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
} from '$shared/agents';
import { agentLabelFor } from '../agent-labels.js';
import {
	DIRECT_AGENT_PRESENTATIONS,
	directAgentShortLabel,
	isDirectAgentId,
	nonDirectAgentIds,
} from '../direct-agents.js';

describe('direct agent presentation', () => {
	it('recognizes exactly the known direct agents in presentation order', () => {
		expect(DIRECT_AGENT_PRESENTATIONS.map((presentation) => presentation.id)).toEqual([
			DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
			DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
			DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
		]);
		expect(isDirectAgentId(DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID)).toBe(true);
		expect(isDirectAgentId('direct-future-provider')).toBe(false);
	});

	it('provides short grouped labels and qualified standalone labels', () => {
		expect(directAgentShortLabel(DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID)).toBe(
			'Chat Completions',
		);
		expect(directAgentShortLabel(DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID)).toBe('Responses');
		expect(directAgentShortLabel(DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID)).toBe('Anthropic');
		expect(agentLabelFor(DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID)).toBe('Direct (Anthropic)');
	});

	it('removes direct agents without reordering other agents', () => {
		expect(
			nonDirectAgentIds([
				'codex',
				DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
				'claude',
				DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
			]),
		).toEqual(['codex', 'claude']);
	});
});
