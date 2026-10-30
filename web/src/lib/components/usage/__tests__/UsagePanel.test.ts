import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UsageSummary } from '$shared/usage';
import type { getUsageSummary } from '$lib/api/usage';
import { ExecutorsStore } from '$lib/executors/executors-store.svelte';
import { localExecutor, remoteExecutor } from '$lib/executors/__tests__/fixtures';
import { UsageController } from '$lib/usage/usage-controller.svelte';
import { usageAgent, usageBucket, usageSummary } from '$lib/usage/__tests__/usage-fixtures';
import UsagePanel from '../UsagePanel.svelte';

const executors = new ExecutorsStore(async () => [localExecutor]);
vi.mock('$lib/context', async (original) => ({
	...(await original<typeof import('$lib/context')>()),
	getExecutors: () => executors,
}));

afterEach(() => {
	cleanup();
	executors.applySnapshot([localExecutor]);
});

const unpricedBucket = (day: string) =>
	usageBucket(day, 'custom-model', {
		costUsd: 0,
		categoryCostUsd: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
		cacheSavingsUsd: 0,
		unpricedRecords: 3,
		unpricedTokens: 1_050,
	});

function renderPanel(read: typeof getUsageSummary) {
	const controller = new UsageController({
		read,
		preferences: { read: () => null, write: () => {} },
		now: () => new Date('2026-10-27T12:00:00Z'),
	});
	render(UsagePanel, { controller, presentation: 'window-main' });
	controller.setPresentationVisible(true);
	return controller;
}

const resolved =
	(summary: UsageSummary): typeof getUsageSummary =>
	async (executorId, window) => ({ ...summary, executorId, ...window });

describe('UsagePanel', () => {
	it('shows totals, agents, and models, and opens a model detail dialog', async () => {
		renderPanel(resolved(usageSummary()));
		await screen.findByText('$13.00');
		const overview = document.querySelector<HTMLElement>('[data-usage-overview]')!;
		expect(within(overview).getByText('Claude')).toBeTruthy();
		expect(within(overview).getByText('$11.00')).toBeTruthy();
		expect(within(overview).getByText('Excludes 1.05K tokens without a known price')).toBeTruthy();
		const table = document.querySelector<HTMLElement>('[data-usage-model-table]')!;
		expect(within(table).getByText('Unpriced')).toBeTruthy();

		await fireEvent.click(
			screen.getByRole('button', { name: 'Show claude-opus-5-5 usage (Claude)' }),
		);
		const dialog = await waitFor(() =>
			document.querySelector<HTMLElement>('[data-usage-model-dialog]')!,
		);
		expect(within(dialog).getByText('claude-opus-5-5')).toBeTruthy();
		expect(within(dialog).getByText('Per 1M tokens')).toBeTruthy();
		expect(within(dialog).getByText('90.0%')).toBeTruthy();
	});

	it('switches between cost and token views', async () => {
		renderPanel(resolved(usageSummary()));
		await screen.findByText('$13.00');
		await fireEvent.click(screen.getByRole('button', { name: 'Tokens' }));
		expect(document.querySelector('[data-usage-headline]')?.textContent?.trim()).toBe('5.25K');
		expect(screen.getByText('Daily processed tokens')).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Day' }));
		expect(document.querySelector('[data-usage-day-table]')).toBeTruthy();
	});

	it('explains an empty window, including agents without transcripts', async () => {
		renderPanel(
			resolved(usageSummary({ agents: [usageAgent('claude', [], { status: 'missing' })] })),
		);
		expect(await screen.findByText('No usage in this period')).toBeTruthy();
		expect(screen.getByText('No transcripts were found for Claude on this executor.')).toBeTruthy();
	});

	it('reports a failed agent read instead of claiming an empty period', async () => {
		renderPanel(
			resolved(
				usageSummary({
					agents: [
						usageAgent('claude', [], { status: 'failed', message: 'Reading usage took too long' }),
						usageAgent('codex', [], { status: 'missing' }),
					],
				}),
			),
		);
		expect(await screen.findByText('Usage could not be read for this period')).toBeTruthy();
		expect(
			screen.getByText('Claude usage could not be read: Reading usage took too long'),
		).toBeTruthy();
		expect(screen.queryByText('No usage in this period')).toBeNull();
	});

	it('shows an agent with no priced usage as unpriced, not free', async () => {
		renderPanel(
			resolved(
				usageSummary({
					agents: [
						usageAgent('claude', [usageBucket('2026-10-26', 'claude-opus-5-5', { costUsd: 4 })]),
						usageAgent('codex', [
							usageBucket('2026-10-26', 'custom-model', {
								costUsd: 0,
								categoryCostUsd: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
								cacheSavingsUsd: 0,
								unpricedRecords: 3,
								unpricedTokens: 1_050,
							}),
						]),
					],
				}),
			),
		);
		await screen.findByText('No known price · 1.05K tokens');
		const codex = document.querySelector<HTMLElement>('[data-usage-agent="codex"]')!;
		expect(within(codex).getByText('Unpriced')).toBeTruthy();
		expect(within(codex).getByText('No known price · 1.05K tokens')).toBeTruthy();
		expect(within(codex).queryByText('$0.00')).toBeNull();
	});

	it('shows a window with no priced usage as unpriced, not free', async () => {
		renderPanel(
			resolved(
				usageSummary({ agents: [usageAgent('codex', [unpricedBucket('2026-10-26')])] }),
			),
		);
		await screen.findByText('No known price · 1.05K tokens');
		const headline = document.querySelector('[data-usage-headline]')!;
		expect(headline.textContent?.trim()).toBe('Unpriced');
		await fireEvent.click(screen.getByRole('button', { name: 'Day' }));
		const total = document.querySelector('[data-usage-day-table] [data-usage-day-total]')!;
		expect(total.textContent).toContain('Unpriced');
		expect(total.textContent).not.toContain('$0.00');
	});

	it('marks only the unpriced days of mixed usage as unknown', async () => {
		renderPanel(
			resolved(
				usageSummary({
					agents: [
						usageAgent('codex', [
							usageBucket('2026-10-27', 'gpt-6-sol', { costUsd: 2 }),
							unpricedBucket('2026-10-26'),
						]),
					],
				}),
			),
		);
		await screen.findByText('$2.00', { selector: '[data-usage-headline]' });
		await fireEvent.click(screen.getByRole('button', { name: 'Day' }));
		const totals = [
			...document.querySelectorAll('[data-usage-day-table] [data-usage-day-total]'),
		].map((cell) => cell.textContent?.trim());
		expect(totals).toEqual(['$2.00', expect.stringContaining('Unpriced')]);
	});

	it("drops the previous executor's numbers when switching to it fails", async () => {
		const read = vi
			.fn<typeof getUsageSummary>()
			.mockImplementationOnce(resolved(usageSummary()))
			.mockRejectedValueOnce(new Error('Executor is unavailable'));
		const controller = renderPanel(read);
		await screen.findByText('$13.00');
		controller.selectExecutor(remoteExecutor.id);
		expect(await screen.findByRole('alert')).toBeTruthy();
		expect(screen.queryByText('$13.00')).toBeNull();
		expect(document.querySelector('[data-usage-overview]')).toBeNull();
	});

	it('reports a failed read and retries it', async () => {
		const read = vi
			.fn<typeof getUsageSummary>()
			.mockRejectedValueOnce(new Error('Executor is unavailable'))
			.mockImplementation(resolved(usageSummary()));
		renderPanel(read);
		expect(await screen.findByRole('alert')).toBeTruthy();
		expect(screen.getByText('Executor is unavailable')).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
		await screen.findByText('$13.00');
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('offers an executor selector only when remote executors exist', async () => {
		renderPanel(resolved(usageSummary()));
		await screen.findByText('$13.00');
		expect(screen.queryByLabelText('Executor')).toBeNull();
		executors.applySnapshot([localExecutor, remoteExecutor]);
		const selector = await screen.findByLabelText('Executor');
		expect(selector.textContent).toContain('Local');
	});

	it('keeps a selected executor visible after it is removed', async () => {
		executors.applySnapshot([localExecutor, remoteExecutor]);
		const controller = renderPanel(resolved(usageSummary()));
		await screen.findByText('$13.00');
		controller.selectExecutor(remoteExecutor.id);
		executors.applySnapshot([localExecutor]);
		const selector = await screen.findByLabelText('Executor');
		await waitFor(() => expect(selector.textContent).toContain('Unavailable executor'));
		expect(controller.executorId).toBe(remoteExecutor.id);
	});
});
