import type { UsageAgentSummary, UsageBucket, UsageSummary } from '$shared/usage';

export function usageBucket(
	day: string,
	model: string,
	overrides: Partial<UsageBucket> = {},
): UsageBucket {
	return {
		day,
		model,
		totals: {
			uncachedInputTokens: 100,
			cachedInputTokens: 900,
			cacheWriteTokens: 0,
			outputTokens: 50,
			reasoningTokens: 0,
		},
		costUsd: 1,
		categoryCostUsd: { input: 0.2, cacheRead: 0.3, cacheWrite: 0, output: 0.5 },
		cacheSavingsUsd: 0.25,
		records: 3,
		unpricedRecords: 0,
		unpricedTokens: 0,
		sessions: 1,
		...overrides,
	};
}

export function usageAgent(
	agentId: string,
	buckets: readonly UsageBucket[],
	overrides: Partial<UsageAgentSummary> = {},
): UsageAgentSummary {
	return {
		agentId,
		status: 'ok',
		message: null,
		buckets,
		scannedFiles: buckets.length,
		unreadableFiles: 0,
		malformedRecords: 0,
		distinctSessions: buckets.length,
		...overrides,
	};
}

export function usageSummary(overrides: Partial<UsageSummary> = {}): UsageSummary {
	return {
		executorId: 'local',
		sinceDay: '2026-10-21',
		untilDay: '2026-10-27',
		timeZone: 'UTC',
		readAt: '2026-10-27T05:00:00.000Z',
		pricingAsOf: '2026-10-27',
		agents: [
			usageAgent('claude', [
				usageBucket('2026-10-25', 'claude-opus-5-5', { costUsd: 6 }),
				usageBucket('2026-10-26', 'claude-opus-5-5', { costUsd: 4 }),
				usageBucket('2026-10-26', 'claude-haiku-5-5', { costUsd: 1 }),
			]),
			usageAgent('codex', [
				usageBucket('2026-10-27', 'gpt-6-sol', { costUsd: 2 }),
				usageBucket('2026-10-27', 'gpt-5.3-codex-spark', {
					costUsd: 0,
					categoryCostUsd: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
					cacheSavingsUsd: 0,
					unpricedRecords: 3,
					unpricedTokens: 1_050,
				}),
			]),
			usageAgent('shell', [], { status: 'missing' }),
		],
		...overrides,
	};
}
