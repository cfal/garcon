import {
	enumerateUsageDays,
	usageTotalTokens,
	type UsageBucket,
	type UsageCategoryCost,
	type UsageSourceStatus,
	type UsageSummary,
	type UsageTokenTotals,
} from '$shared/usage';

export type UsageMetric = 'cost' | 'tokens';

export interface UsageTotals {
	readonly costUsd: number;
	readonly tokens: UsageTokenTotals;
	readonly totalTokens: number;
	readonly categoryCostUsd: UsageCategoryCost;
	readonly cacheSavingsUsd: number;
	readonly records: number;
	readonly unpricedRecords: number;
	readonly unpricedTokens: number;
}

export interface UsageAgentTotals extends UsageTotals {
	readonly agentId: string;
	readonly sessions: number;
	readonly costShare: number;
	readonly tokenShare: number;
}

export interface UsageDayPoint {
	readonly costUsd: number;
	readonly totalTokens: number;
	readonly records: number;
	readonly unpricedRecords: number;
}

export interface UsageModelTotals extends UsageTotals {
	readonly key: string;
	readonly agentId: string;
	readonly model: string;
	readonly costShare: number;
	readonly tokenShare: number;
	// Aligned with UsageReport.days.
	readonly daily: readonly UsageDayPoint[];
}

export interface UsageDayTotals extends UsageDayPoint {
	readonly day: string;
	readonly byAgent: ReadonlyMap<string, UsageDayPoint>;
}

export interface UsageIssue {
	readonly agentId: string;
	readonly status: Extract<UsageSourceStatus, 'partial' | 'failed'>;
	readonly message: string | null;
	readonly unreadableFiles: number;
	readonly malformedRecords: number;
}

export interface UsageReport {
	readonly days: readonly string[];
	readonly totals: UsageTotals & { readonly sessions: number };
	// Agents with usage in the window, by cost and then tokens.
	readonly agents: readonly UsageAgentTotals[];
	// By cost and then tokens.
	readonly models: readonly UsageModelTotals[];
	readonly daily: readonly UsageDayTotals[];
	readonly issues: readonly UsageIssue[];
	readonly pricingAsOf: string | null;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface MutableTotals {
	costUsd: number;
	tokens: Mutable<UsageTokenTotals>;
	categoryCostUsd: Mutable<UsageCategoryCost>;
	cacheSavingsUsd: number;
	records: number;
	unpricedRecords: number;
	unpricedTokens: number;
}

function emptyTotals(): MutableTotals {
	return {
		costUsd: 0,
		tokens: {
			uncachedInputTokens: 0,
			cachedInputTokens: 0,
			cacheWriteTokens: 0,
			outputTokens: 0,
			reasoningTokens: 0,
		},
		categoryCostUsd: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
		cacheSavingsUsd: 0,
		records: 0,
		unpricedRecords: 0,
		unpricedTokens: 0,
	};
}

function addBucket(totals: MutableTotals, bucket: UsageBucket): void {
	totals.costUsd += bucket.costUsd;
	totals.tokens.uncachedInputTokens += bucket.totals.uncachedInputTokens;
	totals.tokens.cachedInputTokens += bucket.totals.cachedInputTokens;
	totals.tokens.cacheWriteTokens += bucket.totals.cacheWriteTokens;
	totals.tokens.outputTokens += bucket.totals.outputTokens;
	totals.tokens.reasoningTokens += bucket.totals.reasoningTokens;
	totals.categoryCostUsd.input += bucket.categoryCostUsd.input;
	totals.categoryCostUsd.cacheRead += bucket.categoryCostUsd.cacheRead;
	totals.categoryCostUsd.cacheWrite += bucket.categoryCostUsd.cacheWrite;
	totals.categoryCostUsd.output += bucket.categoryCostUsd.output;
	totals.cacheSavingsUsd += bucket.cacheSavingsUsd;
	totals.records += bucket.records;
	totals.unpricedRecords += bucket.unpricedRecords;
	totals.unpricedTokens += bucket.unpricedTokens;
}

function emptyDayPoint(): Mutable<UsageDayPoint> {
	return { costUsd: 0, totalTokens: 0, records: 0, unpricedRecords: 0 };
}

function addBucketToDay(point: Mutable<UsageDayPoint>, bucket: UsageBucket): void {
	point.costUsd += bucket.costUsd;
	point.totalTokens += usageTotalTokens(bucket.totals);
	point.records += bucket.records;
	point.unpricedRecords += bucket.unpricedRecords;
}

function freeze(totals: MutableTotals): UsageTotals {
	return { ...totals, totalTokens: usageTotalTokens(totals.tokens) };
}

function share(part: number, whole: number): number {
	return whole > 0 ? part / whole : 0;
}

function byCostThenTokens<T extends UsageTotals>(left: T, right: T): number {
	return right.costUsd - left.costUsd || right.totalTokens - left.totalTokens;
}

/** Merges per-agent day-by-model buckets into the totals the Usage surface renders. */
export function buildUsageReport(summary: UsageSummary): UsageReport {
	const days = enumerateUsageDays(summary.sinceDay, summary.untilDay);
	const dayIndex = new Map(days.map((day, index) => [day, index]));
	const overall = emptyTotals();
	const agentTotals = new Map<string, { totals: MutableTotals; sessions: number }>();
	const modelTotals = new Map<
		string,
		{ agentId: string; model: string; totals: MutableTotals; daily: Mutable<UsageDayPoint>[] }
	>();
	const daily = days.map(() => ({
		...emptyDayPoint(),
		byAgent: new Map<string, Mutable<UsageDayPoint>>(),
	}));
	const issues: UsageIssue[] = [];
	let sessions = 0;

	for (const agent of summary.agents) {
		if (agent.status === 'partial' || agent.status === 'failed') {
			issues.push({
				agentId: agent.agentId,
				status: agent.status,
				message: agent.message,
				unreadableFiles: agent.unreadableFiles,
				malformedRecords: agent.malformedRecords,
			});
		}
		if (agent.buckets.length === 0) continue;
		const ownTotals = emptyTotals();
		agentTotals.set(agent.agentId, { totals: ownTotals, sessions: agent.distinctSessions });
		sessions += agent.distinctSessions;
		for (const bucket of agent.buckets) {
			addBucket(overall, bucket);
			addBucket(ownTotals, bucket);
			const key = `${agent.agentId}:${bucket.model}`;
			let model = modelTotals.get(key);
			if (!model) {
				model = {
					agentId: agent.agentId,
					model: bucket.model,
					totals: emptyTotals(),
					daily: days.map(emptyDayPoint),
				};
				modelTotals.set(key, model);
			}
			addBucket(model.totals, bucket);
			const index = dayIndex.get(bucket.day);
			if (index === undefined) continue;
			const day = daily[index]!;
			let agentDay = day.byAgent.get(agent.agentId);
			if (!agentDay) {
				agentDay = emptyDayPoint();
				day.byAgent.set(agent.agentId, agentDay);
			}
			for (const point of [model.daily[index]!, day, agentDay]) addBucketToDay(point, bucket);
		}
	}

	const totals = freeze(overall);
	const agents = [...agentTotals]
		.map(([agentId, entry]): UsageAgentTotals => {
			const frozen = freeze(entry.totals);
			return {
				...frozen,
				agentId,
				sessions: entry.sessions,
				costShare: share(frozen.costUsd, totals.costUsd),
				tokenShare: share(frozen.totalTokens, totals.totalTokens),
			};
		})
		.sort(byCostThenTokens);
	const models = [...modelTotals]
		.map(([key, entry]): UsageModelTotals => {
			const frozen = freeze(entry.totals);
			return {
				...frozen,
				key,
				agentId: entry.agentId,
				model: entry.model,
				costShare: share(frozen.costUsd, totals.costUsd),
				tokenShare: share(frozen.totalTokens, totals.totalTokens),
				daily: entry.daily,
			};
		})
		.sort(byCostThenTokens);

	return {
		days,
		totals: { ...totals, sessions },
		agents,
		models,
		daily: days.map((day, index) => ({ day, ...daily[index]! })),
		issues,
		pricingAsOf: summary.pricingAsOf,
	};
}

export function sortModels(
	models: readonly UsageModelTotals[],
	metric: UsageMetric,
): readonly UsageModelTotals[] {
	if (metric === 'cost') return models;
	return models.toSorted(
		(left, right) => right.totalTokens - left.totalTokens || right.costUsd - left.costUsd,
	);
}

/** Cost is unknown, not zero, when no record had a known price. */
export function isCostUnknown(totals: Pick<UsageTotals, 'records' | 'unpricedRecords'>): boolean {
	return totals.records > 0 && totals.unpricedRecords >= totals.records;
}

/** Cache writes count as misses: the prompt was fully processed before it was cached. */
export function cacheHitRate(tokens: UsageTokenTotals): number | null {
	const input = tokens.uncachedInputTokens + tokens.cachedInputTokens + tokens.cacheWriteTokens;
	return input === 0 ? null : tokens.cachedInputTokens / input;
}

/** Effective USD per million priced tokens, or null when none were priced. */
export function costPerMillionTokens(totals: UsageTotals): number | null {
	const pricedTokens = totals.totalTokens - totals.unpricedTokens;
	return pricedTokens <= 0 || isCostUnknown(totals)
		? null
		: (totals.costUsd / pricedTokens) * 1_000_000;
}

export function metricValue(point: UsageDayPoint | UsageTotals, metric: UsageMetric): number {
	return metric === 'cost' ? point.costUsd : point.totalTokens;
}
