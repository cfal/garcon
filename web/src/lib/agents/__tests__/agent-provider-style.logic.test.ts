import { describe, expect, it } from 'vitest';
import { agentProviderStyle } from '../agent-provider-style';

describe('agent provider style', () => {
	it('gives provider agents a pill class and accent from the same token family', () => {
		for (const agentId of ['claude', 'codex', 'cursor', 'opencode', 'amp', 'factory', 'pi']) {
			const style = agentProviderStyle(agentId);
			expect(style?.pillClass).toContain(`bg-provider-${agentId}-bg`);
			expect(style?.accentColor).toBe(`var(--color-provider-${agentId}-foreground)`);
		}
	});

	it('has no provider style for other agents or inherited object keys', () => {
		expect(agentProviderStyle('shell')).toBeNull();
		expect(agentProviderStyle('toString')).toBeNull();
	});
});
