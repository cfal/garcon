import { describe, expect, it, vi } from 'vitest';
import type { UsageReadRequest, UsageSummary } from '$shared/usage';
import type { getUsageSummary } from '$lib/api/usage';
import { UsageController } from '../usage-controller.svelte';
import { usageSummary } from './usage-fixtures';

const NOW = new Date('2026-10-27T12:00:00Z');

interface PendingRead {
	readonly executorId: string;
	readonly window: UsageReadRequest;
	readonly signal: AbortSignal | undefined;
	resolve(summary: UsageSummary): void;
	reject(error: Error): void;
}

function harness(stored: string | null = null) {
	const reads: PendingRead[] = [];
	const read: typeof getUsageSummary = (executorId, window, signal) =>
		new Promise((resolve, reject) => reads.push({ executorId, window, signal, resolve, reject }));
	let persisted = stored;
	const preferences = {
		read: () => persisted,
		write: (value: string) => {
			persisted = value;
		},
	};
	const now = vi.fn(() => NOW);
	const controller = new UsageController({ read, preferences, now });
	return { controller, reads, now, persisted: () => persisted };
}

function summaryFor(read: PendingRead): UsageSummary {
	return usageSummary({ executorId: read.executorId, ...read.window });
}

describe('UsageController', () => {
	it('reads when first revealed and keeps the summary until it is stale', async () => {
		const { controller, reads, now } = harness();
		controller.setPresentationVisible(true);
		expect(controller.loading).toBe(true);
		expect(reads[0]).toMatchObject({
			executorId: 'local',
			window: { sinceDay: '2026-09-28', untilDay: '2026-10-27' },
		});
		reads[0]!.resolve(summaryFor(reads[0]!));
		await vi.waitFor(() => expect(controller.loading).toBe(false));
		expect(controller.report?.totals.costUsd).toBe(13);

		controller.setPresentationVisible(false);
		controller.setPresentationVisible(true);
		expect(reads).toHaveLength(1);

		now.mockReturnValue(new Date(NOW.getTime() + 6 * 60 * 1000));
		controller.setPresentationVisible(false);
		controller.setPresentationVisible(true);
		expect(reads).toHaveLength(2);
	});

	it('ignores a slow reply for a previous selection and aborts it', async () => {
		const { controller, reads } = harness();
		controller.setPresentationVisible(true);
		controller.setWindowDays(7);
		expect(reads).toHaveLength(2);
		expect(reads[0]!.signal?.aborted).toBe(true);
		reads[1]!.resolve(summaryFor(reads[1]!));
		reads[0]!.resolve(summaryFor(reads[0]!));
		await vi.waitFor(() => expect(controller.loading).toBe(false));
		expect(controller.summary?.sinceDay).toBe('2026-10-21');
		expect(controller.stale).toBe(false);
	});

	it('marks the shown summary stale while a new executor loads', async () => {
		const { controller, reads } = harness();
		controller.setPresentationVisible(true);
		reads[0]!.resolve(summaryFor(reads[0]!));
		await vi.waitFor(() => expect(controller.loading).toBe(false));
		controller.openModel('claude:claude-opus-5-5');
		expect(controller.selectedModel?.model).toBe('claude-opus-5-5');

		controller.selectExecutor('22222222-2222-4222-8222-222222222222');
		expect(controller.stale).toBe(true);
		expect(controller.selectedModel).toBeNull();
		expect(reads[1]!.executorId).toBe('22222222-2222-4222-8222-222222222222');
		reads[1]!.reject(new Error('Executor is unavailable'));
		await vi.waitFor(() => expect(controller.error).toBe('Executor is unavailable'));
		expect(controller.summary?.executorId).toBe('local');
		expect(controller.executorId).toBe('22222222-2222-4222-8222-222222222222');
	});

	it('defers reads while hidden and persists window and metric only', () => {
		const { controller, reads, persisted } = harness(
			JSON.stringify({ windowDays: 90, metric: 'tokens' }),
		);
		expect(controller.windowDays).toBe(90);
		expect(controller.metric).toBe('tokens');
		controller.setWindowDays(7);
		controller.setMetric('cost');
		controller.selectExecutor('22222222-2222-4222-8222-222222222222');
		expect(reads).toHaveLength(0);
		expect(JSON.parse(persisted()!)).toEqual({ windowDays: 7, metric: 'cost' });

		controller.setPresentationVisible(true);
		expect(reads).toHaveLength(1);
		controller.dispose();
		expect(reads[0]!.signal?.aborted).toBe(true);
		expect(controller.summary).toBeNull();
	});
});
