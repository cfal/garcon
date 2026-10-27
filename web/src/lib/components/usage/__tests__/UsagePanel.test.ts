import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UsageSummary } from '$shared/usage';
import type { getUsageSummary } from '$lib/api/usage';
import { ExecutorsStore } from '$lib/executors/executors-store.svelte';
import { localExecutor, remoteExecutor } from '$lib/executors/__tests__/fixtures';
import { UsageController } from '$lib/usage/usage-controller.svelte';
import { usageAgent, usageSummary } from '$lib/usage/__tests__/usage-fixtures';
import UsagePanel from '../UsagePanel.svelte';

const executors = new ExecutorsStore(async () => [localExecutor]);
vi.mock('$lib/context', async (original) => ({
	...(await original<typeof import('$lib/context')>()),
	getExecutors: () => executors,
}));

afterEach(cleanup);

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
});
