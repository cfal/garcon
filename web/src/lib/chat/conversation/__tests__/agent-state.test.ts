import { describe, expect, it } from 'vitest';
import { AgentState } from '../agent-state.svelte';

describe('AgentState', () => {
	it('does not embed provider-specific mode normalization', () => {
		const agent = new AgentState();
		agent.setThinkingMode('ultra');

		agent.setAgentId('sample-agent');

		expect(agent.thinkingMode).toBe('ultra');
	});

	it('sets thinking modes supplied by the catalog-driven controller', () => {
		const agent = new AgentState();
		agent.setThinkingMode('high');

		expect(agent.thinkingMode).toBe('high');
	});
});
