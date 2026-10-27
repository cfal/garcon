import { describe, expect, it } from 'vitest';
import {
	buildUsageReport,
	cacheHitRate,
	costPerMillionTokens,
	isCostUnknown,
	metricValue,
	sortModels,
} from '../usage-report';
import { usageAgent, usageBucket, usageSummary } from './usage-fixtures';

describe('usage report', () => {
	it('totals agents and models by cost and fills every day of the window', () => {
		const report = buildUsageReport(usageSummary());
		expect(report.days).toEqual([
			'2026-10-21',
			'2026-10-22',
			'2026-10-23',
			'2026-10-24',
			'2026-10-25',
			'2026-10-26',
			'2026-10-27',
		]);
		expect(report.totals.costUsd).toBe(13);
		expect(report.totals.totalTokens).toBe(5 * 1_050);
		expect(report.totals.sessions).toBe(5);
		expect(report.agents.map((agent) => [agent.agentId, agent.costUsd, agent.sessions])).toEqual([
			['claude', 11, 3],
			['codex', 2, 2],
		]);
		expect(report.agents[0]!.costShare).toBeCloseTo(11 / 13, 10);
		expect(report.models.map((model) => model.key)).toEqual([
			'claude:claude-opus-5-5',
			'codex:gpt-6-sol',
			'claude:claude-haiku-5-5',
			'codex:gpt-5.3-codex-spark',
		]);
		expect(report.models[0]!.daily.map((point) => point.costUsd)).toEqual([0, 0, 0, 0, 6, 4, 0]);
		expect(report.daily.at(-1)!.byAgent.get('codex')).toEqual({ costUsd: 2, totalTokens: 2_100 });
		expect(report.daily[0]).toMatchObject({ day: '2026-10-21', costUsd: 0, totalTokens: 0 });
		expect(report.pricingAsOf).toBe('2026-10-27');
	});

	it('omits agents without usage and lists partial or failed reads as issues', () => {
		const report = buildUsageReport(
			usageSummary({
				agents: [
					usageAgent('claude', [usageBucket('2026-10-26', 'claude-opus-5-5')], {
						status: 'partial',
						unreadableFiles: 2,
					}),
					usageAgent('codex', [], { status: 'failed', message: 'Synthetic failure' }),
					usageAgent('shell', [], { status: 'missing' }),
				],
			}),
		);
		expect(report.agents.map((agent) => agent.agentId)).toEqual(['claude']);
		expect(report.issues).toEqual([
			{
				agentId: 'claude',
				status: 'partial',
				message: null,
				unreadableFiles: 2,
				malformedRecords: 0,
			},
			{
				agentId: 'codex',
				status: 'failed',
				message: 'Synthetic failure',
				unreadableFiles: 0,
				malformedRecords: 0,
			},
		]);
	});

	it('sorts by tokens for the token metric', () => {
		const report = buildUsageReport(
			usageSummary({
				agents: [
					usageAgent('claude', [
						usageBucket('2026-10-26', 'cheap-heavy', {
							costUsd: 1,
							totals: {
								uncachedInputTokens: 9_000,
								cachedInputTokens: 0,
								cacheWriteTokens: 0,
								outputTokens: 0,
								reasoningTokens: 0,
							},
						}),
						usageBucket('2026-10-26', 'costly-light', { costUsd: 5 }),
					]),
				],
			}),
		);
		expect(report.models.map((model) => model.model)).toEqual(['costly-light', 'cheap-heavy']);
		expect(sortModels(report.models, 'tokens').map((model) => model.model)).toEqual([
			'cheap-heavy',
			'costly-light',
		]);
		expect(metricValue(report.models[0]!, 'tokens')).toBe(1_050);
	});

	it('derives cache hit rate, per-million cost, and unknown cost', () => {
		const report = buildUsageReport(usageSummary());
		const opus = report.models[0]!;
		expect(cacheHitRate(opus.tokens)).toBeCloseTo(900 / 1_000, 10);
		expect(
			cacheHitRate({
				uncachedInputTokens: 0,
				cachedInputTokens: 0,
				cacheWriteTokens: 0,
				outputTokens: 10,
				reasoningTokens: 0,
			}),
		).toBeNull();
		expect(costPerMillionTokens(opus)).toBeCloseTo((10 / 2_100) * 1_000_000, 6);
		const spark = report.models.find((model) => model.model === 'gpt-5.3-codex-spark')!;
		expect(isCostUnknown(spark)).toBe(true);
		expect(costPerMillionTokens(spark)).toBeNull();
		expect(costPerMillionTokens(report.totals)).toBeCloseTo((13 / (5_250 - 1_050)) * 1_000_000, 6);
	});
});
