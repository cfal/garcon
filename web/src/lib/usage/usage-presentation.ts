import type { UsageCategoryCost, UsageTokenTotals } from '$shared/usage';
import * as m from '$lib/paraglide/messages.js';
import { agentProviderStyle } from '$lib/agents/agent-provider-style';

export interface ShareSegment {
	readonly id: string;
	readonly label: string;
	readonly value: number;
	readonly color: string;
}

// Series reuse each provider's theme accent so a chart matches the agent pills elsewhere.
export function usageAgentColor(agentId: string): string {
	return agentProviderStyle(agentId)?.accentColor ?? 'var(--color-muted-foreground)';
}

// Cost and tokens share one type breakdown, so both bars use the same order and colors.
const USAGE_TYPES = [
	{
		id: 'input',
		label: () => m.usage_type_input(),
		cost: (cost: UsageCategoryCost) => cost.input,
		tokens: (tokens: UsageTokenTotals) => tokens.uncachedInputTokens,
	},
	{
		id: 'cache-read',
		label: () => m.usage_type_cache_read(),
		cost: (cost: UsageCategoryCost) => cost.cacheRead,
		tokens: (tokens: UsageTokenTotals) => tokens.cachedInputTokens,
	},
	{
		id: 'cache-write',
		label: () => m.usage_type_cache_write(),
		cost: (cost: UsageCategoryCost) => cost.cacheWrite,
		tokens: (tokens: UsageTokenTotals) => tokens.cacheWriteTokens,
	},
	{
		id: 'output',
		label: () => m.usage_type_output(),
		cost: (cost: UsageCategoryCost) => cost.output,
		tokens: (tokens: UsageTokenTotals) => tokens.outputTokens,
	},
] as const;

export function costTypeSegments(cost: UsageCategoryCost): readonly ShareSegment[] {
	return USAGE_TYPES.map((type) => ({
		id: type.id,
		label: type.label(),
		value: type.cost(cost),
		color: `var(--color-usage-${type.id})`,
	}));
}

export function tokenTypeSegments(tokens: UsageTokenTotals): readonly ShareSegment[] {
	return USAGE_TYPES.map((type) => ({
		id: type.id,
		label: type.label(),
		value: type.tokens(tokens),
		color: `var(--color-usage-${type.id})`,
	}));
}
