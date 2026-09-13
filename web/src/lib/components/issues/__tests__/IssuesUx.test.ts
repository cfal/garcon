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
	it.each([false, true])(
		'keeps refresh errors and retry inside selected details (loaded: %s)',
		async (loaded) => {
			const { controller, api, view } = await mount();
			if (loaded) {
				await fireEvent.click(screen.getByRole('button', { name: 'Open G-1' }));
				await controller.refresh();
			}
			api.counts.mockRejectedValueOnce(new ApiError(503, 'Synthetic refresh unavailable'));
			if (!loaded) controller.select('G-1');
			await controller.refresh();
			const detail = within(view.container.querySelector<HTMLElement>('.issue-detail')!);
			expect(detail.getByText('Synthetic refresh unavailable')).toBeTruthy();
			expect(detail.queryByText('Loading issue…')).toBeNull();
			expect(view.container.querySelector('.issue-browser')?.textContent).not.toContain(
				'Synthetic refresh unavailable',
			);
			await fireEvent.click(detail.getByRole('button', { name: 'Refresh' }));
			await controller.refresh();
			expect(screen.getByRole('heading', { name: 'Synthetic issue 1' })).toBeTruthy();
			expect(screen.queryByText('Synthetic refresh unavailable')).toBeNull();
		},
	);

	it.each([1, 2])(
		'keeps a failed mutation visible while another view loads (issue %s)',
		async (number) => {
			const { controller, api, view } = await mount();
			const message = 'Save not confirmed. Retry the same request or copy the draft.';
			const readBarrier = hold();
			const mutationBarrier = hold();
			const read = api.read.getMockImplementation()!;
			api.read.mockImplementationOnce(async (...args) => {
				await readBarrier.promise;
				return read(...args);
			});
			api.mutate.mockImplementationOnce(async () => {
				await mutationBarrier.promise;
				throw new Error('Synthetic connection loss');
			});
			const issue = syntheticIssue(number);
			const mutation = controller.mutate(issue, {
				action: 'update',
				issueId: issue.id,
				expectedRevision: issue.revision,
				patch: { priority: 1 },
			});
			await fireEvent.click(screen.getByRole('button', { name: 'Open G-1' }));
			await waitFor(() => expect(api.read).toHaveBeenCalled());
			mutationBarrier.release();
			await mutation;
			await tick();
			expect(
				within(view.container.querySelector<HTMLElement>('.issue-detail-placeholder')!).getByText(
					message,
				),
			).toBeTruthy();
			expect(view.container.querySelector('.issue-browser > .issue-notice')).toBeNull();
			readBarrier.release();
			await controller.refresh();
			await tick();
			expect(
				within(screen.getByRole('region', { name: 'Issue details' })).getByText(message),
			).toBeTruthy();
			await fireEvent.click(screen.getByRole('button', { name: 'Back to issues' }));
			expect(view.container.querySelector('.issue-browser > .issue-notice')?.textContent).toContain(
				message,
			);
			expect(view.container.querySelector('.issue-detail')).toBeNull();
		},
	);

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
			await fireEvent.click(screen.getByRole('button', { name: 'Search' }));
			const counts = api.counts.getMockImplementation()!;
			api.counts.mockImplementationOnce(async (...args) => {
				await barrier.promise;
				return counts(...args);
			});
			await fireEvent.input(screen.getByPlaceholderText('Search issues…'), {
				target: { value: 'different' },
			});
			await fireEvent.submit(screen.getByPlaceholderText('Search issues…').closest('form')!);
			expect(view.container.querySelector('[data-issue-id="G-1"]')).not.toBeNull();
			expect(view.container.querySelector('.issue-collection')?.textContent).not.toContain(
				'Loading issues…',
			);
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
		controller.createdIssueId = 'G-1';
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
		await fireEvent.click(screen.getByRole('button', { name: 'Open G-1' }));
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
			await fireEvent.click(screen.getByRole('button', { name: 'Change status of G-1' }));
			await fireEvent.click(await screen.findByRole('menuitem', { name: 'In review' }));
			expect(
				view.container.querySelector('[data-status="in-review"] [data-issue-id="G-1"]'),
			).not.toBeNull();
			expect(view.container.querySelector('[data-status="open"] [data-issue-id="G-1"]')).toBeNull();
			expect(controller.activeLane).toBe('in-review');
			if (changedLane) controller.activeLane = 'in-progress';
			barrier.release();
			await waitFor(() => expect(controller.drafts.pending).toBe(false));
			expect(
				view.container.querySelector('[data-status="open"] [data-issue-id="G-1"]'),
			).not.toBeNull();
			expect(await screen.findByText('Synthetic rejected move')).toBeTruthy();
			expect(controller.activeLane).toBe(changedLane ? 'in-progress' : 'open');
		},
	);

	it('preserves filter values when the filter options are collapsed', async () => {
		const { controller } = await mount();
		await fireEvent.click(screen.getByRole('button', { name: 'Search' }));
		await fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'in-review' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Hide search options' }));
		await fireEvent.submit(screen.getByPlaceholderText('Search issues…').closest('form')!);
		expect(controller.query.status).toBe('in-review');
		await controller.refresh();
	});

	it('normalizes search fields without dropping urgent priority or explicit filter flags', async () => {
		const { controller } = await mount();
		controller.setQuery({ ready: false, includeClosed: true });
		await controller.refresh();
		await fireEvent.click(screen.getByRole('button', { name: 'Search' }));
		await fireEvent.input(screen.getByLabelText('Project'), {
			target: { value: '  Release  ' },
		});
		await fireEvent.input(screen.getByPlaceholderText('Search issues…'), {
			target: { value: '  Synthetic issue  ' },
		});
		await fireEvent.input(screen.getByLabelText('Label'), { target: { value: '  frontend  ' } });
		await fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'in-review' } });
		await fireEvent.change(screen.getByLabelText('Priority'), { target: { value: '0' } });
		await fireEvent.change(screen.getByLabelText('Assignee'), { target: { value: 'user:local' } });
		await fireEvent.submit(screen.getByPlaceholderText('Search issues…').closest('form')!);
		expect(controller.query).toEqual({
			project: 'Release',
			query: 'Synthetic issue',
			label: 'frontend',
			status: 'in-review',
			priority: 0,
			assignee: { kind: 'user', username: 'local' },
			ready: false,
			includeClosed: true,
		});
		await fireEvent.change(screen.getByLabelText('Priority'), { target: { value: '' } });
		expect(controller.query).not.toHaveProperty('priority');
		expect(controller.query).toMatchObject({ ready: false, includeClosed: true });
		await fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
		expect(controller.query).toEqual({});
	});

	it('updates assignee filter chips without substituting display names', async () => {
		const { controller, view } = await mount();
		const assignees = [
			['unassigned', 'Unassigned'],
			[{ kind: 'chat', chatId: '1000000000000001' }, '1000000000000001'],
			[{ kind: 'user', username: 'synthetic-user' }, 'synthetic-user'],
		] as const;
		for (const [assignee, label] of assignees) {
			controller.setQuery({ assignee });
			await tick();
			expect(view.container.querySelector('.issue-filter-chips span')?.textContent).toBe(label);
		}
		controller.setQuery({});
		await tick();
		expect(view.container.querySelector('.issue-filter-chips')).toBeNull();
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
