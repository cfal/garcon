import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/client';
import * as api from '$lib/api/workflows';
import { workflowRun } from '$lib/workflows/__tests__/workflow-fixtures';
import WorkflowRunViewer from '../WorkflowRunViewer.svelte';

vi.mock('$lib/api/workflows', () => ({
	getWorkflowRun: vi.fn(),
	addWorkflowItem: vi.fn(),
	addWorkflowStep: vi.fn(),
	archiveWorkflowRun: vi.fn(),
	decideWorkflow: vi.fn(),
	retryWorkflowStep: vi.fn(),
}));

beforeEach(() => {
	vi.mocked(api.getWorkflowRun).mockResolvedValue(workflowRun());
});

afterEach(() => {
	cleanup();
	vi.resetAllMocks();
});

describe('Workflow run viewer', () => {
	it('filters keyed instances, retains Back selection, opens the exact attempt chat, and never offers unknown retries', async () => {
		const open = vi.fn();
		render(WorkflowRunViewer, { runId: 'run-a', onOpenChat: open });
		const step = await screen.findByRole('button', { name: /Verify findings/ });
		await fireEvent.click(step);
		await fireEvent.input(screen.getByLabelText('Filter by key'), { target: { value: 'F-02' } });
		const instance = screen.getByRole('combobox', { name: 'Instance' }) as HTMLSelectElement;
		expect(Array.from(instance.options).map((entry) => entry.value)).toEqual(['verify-b']);
		expect(screen.queryByRole('button', { name: 'Retry step' })).toBeNull();
		expect(screen.getByText('Connection lost')).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Open chat' }));
		expect(open).toHaveBeenCalledWith('1780000000000002');
		await fireEvent.click(screen.getByRole('button', { name: 'Back to steps' }));
		await fireEvent.click(step);
		expect((screen.getByLabelText('Filter by key') as HTMLInputElement).value).toBe('F-02');
		expect(instance.value).toBe('verify-b');
	});

	it('sends one decision with a stable operation ID and reuses it only on explicit retry', async () => {
		vi.mocked(api.decideWorkflow)
			.mockRejectedValueOnce(new Error('Lost reply'))
			.mockResolvedValueOnce(workflowRun());
		render(WorkflowRunViewer, { runId: 'run-a', onOpenChat: vi.fn() });
		await fireEvent.click(await screen.findByRole('button', { name: /Review report/ }));
		await fireEvent.click(screen.getByRole('button', { name: 'Approve report' }));
		const retry = await screen.findByRole('button', { name: 'Retry same action' });
		expect(api.decideWorkflow).toHaveBeenCalledOnce();
		const first = vi.mocked(api.decideWorkflow).mock.calls[0][0];
		expect(first).toMatchObject({
			runId: 'run-a',
			instanceId: 'decide',
			choice: 'approve',
			operationId: expect.any(String),
		});
		await fireEvent.click(retry);
		await waitFor(() => expect(api.decideWorkflow).toHaveBeenCalledTimes(2));
		expect(vi.mocked(api.decideWorkflow).mock.calls[1][0]).toEqual(first);
	});

	it('uses the typed keyed intake request and leaves a conflict visible without retrying it', async () => {
		vi.mocked(api.addWorkflowItem).mockRejectedValueOnce(
			new ApiError(409, 'Intake closed before confirmation.', 'WORKFLOW_CONFLICT'),
		);
		render(WorkflowRunViewer, { runId: 'run-a', onOpenChat: vi.fn() });
		await fireEvent.click(await screen.findByRole('button', { name: /Verify findings/ }));
		await fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
		await fireEvent.input(screen.getByLabelText('Item key (id)'), { target: { value: ' F-03 ' } });
		await fireEvent.input(screen.getByLabelText('JSON payload'), {
			target: { value: '{"claim": "New claim"}' },
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
		expect((await screen.findByRole('alert')).textContent).toContain(
			'Intake closed before confirmation.',
		);
		expect(api.addWorkflowItem).toHaveBeenCalledExactlyOnceWith({
			runId: 'run-a',
			stepId: 'verify',
			operationId: expect.any(String),
			key: 'F-03',
			payload: { id: 'F-03', claim: 'New claim' },
		});
		expect(screen.queryByRole('button', { name: 'Retry same action' })).toBeNull();
	});

	it('creates a new run-only decision on one stored result without subscribing to future signals', async () => {
		vi.mocked(api.addWorkflowStep).mockResolvedValue(workflowRun());
		render(WorkflowRunViewer, { runId: 'run-a', onOpenChat: vi.fn() });
		await fireEvent.click(await screen.findByRole('button', { name: 'Add step' }));
		const form = screen.getByRole('heading', { name: 'Add step' }).closest('form')!;
		await fireEvent.change(within(form).getByLabelText('Step type'), {
			target: { value: 'decision' },
		});
		await fireEvent.input(within(form).getByLabelText('Step name'), {
			target: { value: 'Second decision' },
		});
		await fireEvent.input(within(form).getByLabelText('Prompt'), {
			target: { value: 'Review this result' },
		});
		await fireEvent.change(within(form).getByLabelText('Start condition'), {
			target: { value: 'result' },
		});
		await fireEvent.change(within(form).getByLabelText('Evidence'), {
			target: { value: 'report-a' },
		});
		const submit = within(form).getByRole<HTMLButtonElement>('button', { name: 'Add step' });
		expect(submit.disabled).toBe(false);
		expect(form.checkValidity()).toBe(true);
		await fireEvent.click(submit);
		expect(screen.queryByRole('alert')?.textContent).toBeUndefined();
		expect(api.addWorkflowStep).toHaveBeenCalledOnce();
		const request = vi.mocked(api.addWorkflowStep).mock.calls[0][0];
		expect(request).toMatchObject({
			runId: 'run-a',
			evidenceSignalId: 'report-a',
			operationId: expect.any(String),
		});
		const step = JSON.parse(request.source);
		expect(step).toMatchObject({
			kind: 'decision',
			prompt: 'Review this result\n\n{{result}}',
			bindings: { result: 'signal' },
		});
		expect(step).not.toHaveProperty('on');
	});

	it('archives only after confirmation and leaves the run readable without mutation controls', async () => {
		const run = workflowRun();
		vi.mocked(api.archiveWorkflowRun).mockResolvedValue({
			...run,
			status: 'archived',
			archive: {
				operationId: 'archive-op',
				actor: { id: 'test-user', name: 'Test user' },
				createdAt: run.createdAt,
			},
		});
		render(WorkflowRunViewer, { runId: 'run-a', onOpenChat: vi.fn() });
		await fireEvent.click(await screen.findByRole('button', { name: /Review report/ }));
		await fireEvent.click(screen.getByRole('button', { name: 'Archive run' }));
		const confirm = screen.getByRole('dialog', { name: 'Archive run' });
		expect(confirm.textContent).toContain('keeps run history');
		expect(confirm.textContent).toContain('unknown outcomes');
		expect(api.archiveWorkflowRun).not.toHaveBeenCalled();
		await fireEvent.click(within(confirm).getByRole('button', { name: 'Archive run' }));
		expect(await screen.findByText(/Archived by Test user/)).toBeTruthy();
		expect(api.archiveWorkflowRun).toHaveBeenCalledExactlyOnceWith({
			runId: 'run-a',
			operationId: expect.any(String),
		});
		expect(screen.queryByRole('button', { name: 'Approve report' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Add step' })).toBeNull();
		expect(screen.getByRole('button', { name: /Review report/ })).toBeTruthy();
	});
});
