import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { ApiError } from '$lib/api/client';
import type { IssuesController } from '$lib/issues/catalog/issues-controller.svelte';
import IssuesTestHost from './IssuesTestHost.svelte';
import { issueTestHarness, syntheticIssue } from './issue-test-harness';

const controllers: IssuesController[] = [];
afterEach(() => {
	cleanup();
	controllers.splice(0).forEach((controller) => controller.dispose());
});
async function mount(empty = false, pinnedProjectPaths: string[] = []) {
	const fixture = issueTestHarness(empty ? [] : [syntheticIssue()]);
	controllers.push(fixture.controller);
	fixture.controller.setPresentationVisible(true);
	await fixture.controller.refresh();
	const view = render(IssuesTestHost, { controller: fixture.controller, pinnedProjectPaths });
	await tick();
	return { ...fixture, view };
}
function hold() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

describe('Issues stable, immediate interactions', () => {
	it('leaves an empty board plain and removes the redundant heading', async () => {
		const { controller, view } = await mount(true);
		controller.setLayout('board');
		await controller.refresh();
		await tick();
		expect(screen.queryByText('No issues yet')).toBeNull();
		expect(screen.queryByRole('heading', { name: 'Issues' })).toBeNull();
		expect(view.container.querySelectorAll('.issue-lane')).toHaveLength(3);
		expect(screen.getByLabelText('Project')).toBeTruthy();
	});

	it.each(['list', 'board'] as const)(
		'retains %s content while a new query loads',
		async (layout) => {
			const { controller, api, view } = await mount();
			controller.setLayout(layout);
			await controller.refresh();
			const barrier = hold();
			const counts = api.counts.getMockImplementation()!;
			api.counts.mockImplementationOnce(async (...args) => {
				await barrier.promise;
				return counts(...args);
			});
			await fireEvent.input(screen.getByPlaceholderText('Search issues…'), {
				target: { value: 'different' },
			});
			await fireEvent.submit(screen.getByPlaceholderText('Search issues…').closest('form')!);
			expect(view.container.querySelector('[data-issue-id="ISS-1"]')).not.toBeNull();
			expect(screen.queryByText('Loading issues…')).toBeNull();
			expect(
				view.container.querySelector('[data-issue-search-button]')?.getAttribute('aria-busy'),
			).toBe('true');
			barrier.release();
			await controller.refresh();
			expect(api.list.mock.lastCall?.[0].query).toBe('different');
		},
	);

	it('does not flash outside-filter feedback while changing layouts', async () => {
		const { controller, api } = await mount();
		controller.createdIssueId = 'ISS-1';
		const barrier = hold();
		const counts = api.counts.getMockImplementation()!;
		api.counts.mockImplementationOnce(async (...args) => {
			await barrier.promise;
			return counts(...args);
		});
		controller.setLayout('board');
		await tick();
		expect(screen.queryByText('Created outside current filters')).toBeNull();
		barrier.release();
		await controller.refresh();
		expect(screen.queryByText('Created outside current filters')).toBeNull();
	});

	it('keeps pending quick actions out of recovery while still guarding unsaved requests', async () => {
		const { controller, api } = await mount();
		await fireEvent.click(screen.getByRole('button', { name: 'Open ISS-1' }));
		await controller.refresh();
		const barrier = hold();
		const mutate = api.mutate.getMockImplementation()!;
		api.mutate.mockImplementationOnce(async (...args) => {
			await barrier.promise;
			return mutate(...args);
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Assign to me' }));
		expect(controller.drafts.needsExitGuard).toBe(true);
		expect(screen.queryByText(/Recovered drafts/)).toBeNull();
		expect(screen.getByText('Saving…')).toBeTruthy();
		barrier.release();
		await waitFor(() => expect(controller.drafts.pending).toBe(false));
	});

	it.each([false, true])(
		'rolls back a rejected move without overriding a newer lane choice (%s)',
		async (changedLane) => {
			const { controller, api, view } = await mount();
			controller.setLayout('board');
			await controller.refresh();
			const barrier = hold();
			api.mutate.mockImplementationOnce(async () => {
				await barrier.promise;
				throw new ApiError(409, 'Synthetic rejected move', 'ISSUE_REVISION_CONFLICT');
			});
			await fireEvent.click(screen.getByRole('button', { name: 'Change status of ISS-1' }));
			await fireEvent.click(await screen.findByRole('menuitem', { name: 'In review' }));
			expect(
				view.container.querySelector('[data-status="in-review"] [data-issue-id="ISS-1"]'),
			).not.toBeNull();
			expect(
				view.container.querySelector('[data-status="open"] [data-issue-id="ISS-1"]'),
			).toBeNull();
			expect(controller.activeLane).toBe('in-review');
			if (changedLane) controller.activeLane = 'in-progress';
			barrier.release();
			await waitFor(() => expect(controller.drafts.pending).toBe(false));
			expect(
				view.container.querySelector('[data-status="open"] [data-issue-id="ISS-1"]'),
			).not.toBeNull();
			expect(await screen.findByText('Synthetic rejected move')).toBeTruthy();
			expect(controller.activeLane).toBe(changedLane ? 'in-progress' : 'open');
		},
	);

	it('preserves filter values when the filter options are collapsed', async () => {
		const { controller } = await mount();
		await fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
		await fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'in-review' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
		await fireEvent.submit(screen.getByPlaceholderText('Search issues…').closest('form')!);
		expect(controller.query.status).toBe('in-review');
		await controller.refresh();
	});

	it('removes create-another and explains free-form project labels', async () => {
		await mount(false, ['/synthetic/project']);
		await fireEvent.click(screen.getByRole('button', { name: 'New issue' }));
		const dialog = within(await screen.findByRole('dialog'));
		expect(dialog.queryByText('Create another')).toBeNull();
		expect(dialog.getByText(/Project can be any label/)).toBeTruthy();
		await fireEvent.click(dialog.getByRole('button', { name: '/synthetic/project' }));
		expect((dialog.getByLabelText('Project') as HTMLInputElement).value).toBe('/synthetic/project');
		await fireEvent.input(dialog.getByLabelText('Project'), { target: { value: 'Any label' } });
		expect((dialog.getByLabelText('Project') as HTMLInputElement).value).toBe('Any label');
		expect(dialog.queryByRole('button', { name: /pin|unpin/i })).toBeNull();
	});
});
