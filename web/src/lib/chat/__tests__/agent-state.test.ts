import { describe, expect, it } from 'vitest';
import { AgentState } from '../agent-state.svelte';

describe('AgentState', () => {
	it('clears Codex ultra thinking when switching to Claude or Pi', () => {
		for (const agentId of ['claude', 'pi'] as const) {
			const agent = new AgentState();
			agent.setAgentId('codex');
			agent.setThinkingMode('ultra');

			agent.setAgentId(agentId);

			expect(agent.thinkingMode).toBe('none');
		}
	});

	it('retains ultra thinking for Codex', () => {
		const agent = new AgentState();
		agent.setAgentId('codex');
		agent.setThinkingMode('ultra');

		expect(agent.thinkingMode).toBe('ultra');
	});
});
