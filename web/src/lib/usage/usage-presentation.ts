import type { UsageCategoryCost, UsageTokenTotals } from '$shared/usage';
import * as m from '$lib/paraglide/messages.js';

export interface ShareSegment {
	readonly id: string;
	readonly label: string;
	readonly value: number;
	readonly color: string;
}

// Series reuse each provider's theme accent so a chart matches the agent pills elsewhere.
const AGENT_SERIES_COLORS: Readonly<Record<string, string>> = {
	claude: 'var(--color-provider-claude-foreground)',
	codex: 'var(--color-provider-codex-foreground)',
	cursor: 'var(--color-provider-cursor-foreground)',
	opencode: 'var(--color-provider-opencode-foreground)',
	amp: 'var(--color-provider-amp-foreground)',
	factory: 'var(--color-provider-factory-foreground)',
	pi: 'var(--color-provider-pi-foreground)',
};

export function usageAgentColor(agentId: string): string {
	return AGENT_SERIES_COLORS[agentId] ?? 'var(--color-muted-foreground)';
}

export function costTypeSegments(cost: UsageCategoryCost): readonly ShareSegment[] {
	return [
		{ id: 'input', label: m.usage_type_input(), value: cost.input, color: 'var(--color-usage-input)' },
		{ id: 'cache-read', label: m.usage_type_cache_read(), value: cost.cacheRead, color: 'var(--color-usage-cache-read)' },
		{ id: 'cache-write', label: m.usage_type_cache_write(), value: cost.cacheWrite, color: 'var(--color-usage-cache-write)' },
		{ id: 'output', label: m.usage_type_output(), value: cost.output, color: 'var(--color-usage-output)' },
	];
}

export function tokenTypeSegments(tokens: UsageTokenTotals): readonly ShareSegment[] {
	return [
		{ id: 'input', label: m.usage_type_input(), value: tokens.uncachedInputTokens, color: 'var(--color-usage-input)' },
		{ id: 'cache-read', label: m.usage_type_cache_read(), value: tokens.cachedInputTokens, color: 'var(--color-usage-cache-read)' },
		{ id: 'cache-write', label: m.usage_type_cache_write(), value: tokens.cacheWriteTokens, color: 'var(--color-usage-cache-write)' },
		{ id: 'output', label: m.usage_type_output(), value: tokens.outputTokens, color: 'var(--color-usage-output)' },
	];
}
