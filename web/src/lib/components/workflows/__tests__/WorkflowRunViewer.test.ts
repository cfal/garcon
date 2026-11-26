import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/client';
import * as api from '$lib/api/workflows';
import { validateStart } from '$lib/api/chats';
import { ExecutorsStore } from '$lib/executors/executors-store.svelte';
import { workflowRun } from '$lib/workflows/__tests__/workflow-fixtures';
import WorkflowRunViewer from '../WorkflowRunViewer.svelte';

vi.mock('../WorkflowStepSettings.svelte', () => import('./RunStepSettingsProbe.svelte'));
vi.mock('$lib/context', async (original) => ({
	...(await original<typeof import('$lib/context')>()),
	getExecutors: () => new ExecutorsStore(),
}));
vi.mock('$lib/api/chats', async (original) => ({
	...(await original<typeof import('$lib/api/chats')>()),
	validateStart: vi.fn(),
}));
vi.mock('$lib/api/workflows', () => ({
	getWorkflowRun: vi.fn(),
	addWorkflowItem: vi.fn(),
	addWorkflowStep: vi.fn(),
	archiveWorkflowRun: vi.fn(),
	decideWorkflow: vi.fn(),
	retryWorkflowStep: vi.fn(),
	stopWorkflowRun: vi.fn(),
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
		const filter = screen.getByLabelText('Filter by key');
		const instance = () => screen.getByRole<HTMLSelectElement>('combobox', { name: 'Instance' });
		await fireEvent.input(filter, { target: { value: '02' } });
		expect(Array.from(instance().options, (entry) => entry.value)).toEqual(['verify-b']);
		await fireEvent.input(filter, { target: { value: 'F-' } });
		expect(Array.from(instance().options, (entry) => entry.value)).toEqual([
			'verify-a',
			'verify-b',
		]);
		await fireEvent.change(instance(), { target: { value: 'verify-b' } });
		expect(screen.queryByRole('button', { name: 'Retry step' })).toBeNull();
		expect(screen.getByText('Connection lost')).toBeTruthy();
		expect(screen.getByText('Stderr detail: command exited with status 7')).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Open chat' }));
		expect(open).toHaveBeenCalledWith('1780000000000002');
		await fireEvent.click(screen.getByRole('button', { name: 'Back to steps' }));
		await fireEvent.click(step);
		expect(screen.getByLabelText<HTMLInputElement>('Filter by key').value).toBe('F-');
		expect(instance().value).toBe('verify-b');
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
			target: { value: 'future' },
		});
		const signals = within(form).getByLabelText<HTMLSelectElement>('Signal');
		expect([...signals.options].map((option) => option.value)).toEqual([
			'',
			'review.approve',
			'review.reject',
		]);
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

	it('previews the effective launch folder and restores applied settings when reopened', async () => {
		vi.mocked(api.getWorkflowRun).mockResolvedValue({
			...workflowRun(),
			executionContext: {
				defaultTarget: { executorId: 'local', projectPath: '/launch' },
				projectPaths: { local: '/alternate' },
			},
		});
		render(WorkflowRunViewer, { runId: 'run-a', onOpenChat: vi.fn() });
		await fireEvent.click(await screen.findByRole('button', { name: 'Add step' }));
		const form = within(screen.getByRole('heading', { name: 'Add step' }).closest('form')!);
		await fireEvent.change(form.getByLabelText('Step type'), { target: { value: 'command' } });
		expect(form.getByPlaceholderText('/launch')).toBeTruthy();
		const settings = form.getByRole('button', { name: 'Step settings' });
		await fireEvent.click(settings);
		await fireEvent.click(form.getByRole('button', { name: 'Choose bash' }));
		await fireEvent.click(settings);
		expect(form.getByRole('status').textContent).toBe('bash');
		await fireEvent.click(form.getByRole('button', { name: 'Choose bash' }));
		await fireEvent.input(form.getByLabelText('Step name'), { target: { value: 'Check folder' } });
		await fireEvent.input(form.getByLabelText('Command'), { target: { value: 'pwd' } });
		await fireEvent.input(form.getByPlaceholderText('/launch'), { target: { value: ' /folder ' } });
		vi.mocked(validateStart).mockResolvedValueOnce({ valid: false, isGitRepo: false });
		await fireEvent.click(form.getByRole('button', { name: 'Add step' }));
		expect((await form.findByRole('alert')).textContent).toContain('/folder');
		expect(api.addWorkflowStep).not.toHaveBeenCalled();
		vi.mocked(validateStart).mockResolvedValueOnce({ valid: true, isGitRepo: false });
		vi.mocked(api.addWorkflowStep).mockResolvedValue(workflowRun());
		await fireEvent.click(form.getByRole('button', { name: 'Add step' }));
		await waitFor(() => expect(api.addWorkflowStep).toHaveBeenCalledOnce());
		expect(validateStart).toHaveBeenCalledWith('/folder', { executorId: 'local' });
		expect(JSON.parse(vi.mocked(api.addWorkflowStep).mock.calls[0][0].source)).toMatchObject({
			projectPath: '/folder',
			shell: 'bash',
		});
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

	it('requests cooperative step stop and confirms whole-run stop before invoking the stop API', async () => {
		const live = workflowRun();
		const research = {
			...live.steps[0]!,
			instances: [
				{
					id: 'research-live',
					key: null,
					status: 'running' as const,
					trigger: { kind: 'root' as const },
					bindings: null,
					prompt: 'Research.',
					reason: null,
					attempts: [
						{
							id: 'attempt-live',
							number: 1,
							status: 'running' as const,
							chatId: '1780000000000009',
							chatAvailable: true,
							turnId: 'turn-live',
							startedAt: live.createdAt,
							finishedAt: null,
							reason: null,
							diagnostic: null,
						},
					],
				},
			],
		};
		const running = { ...live, status: 'running' as const, steps: [research, ...live.steps.slice(1)] };
		vi.mocked(api.getWorkflowRun).mockResolvedValue(running);
		vi.mocked(api.stopWorkflowRun).mockResolvedValue(live);
		render(WorkflowRunViewer, { runId: 'run-a', onOpenChat: vi.fn() });

		await fireEvent.click(await screen.findByRole('button', { name: /^research\b/ }));
		await fireEvent.click(screen.getByRole('button', { name: 'Stop step' }));
		await waitFor(() =>
			expect(api.stopWorkflowRun).toHaveBeenCalledWith({
				runId: 'run-a',
				instanceId: 'research-live',
				operationId: expect.any(String),
			}),
		);

		vi.mocked(api.getWorkflowRun).mockResolvedValue(running);
		await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
		await fireEvent.click(await screen.findByRole('button', { name: 'Stop run' }));
		const dialog = screen.getByRole('dialog', { name: 'Stop run' });
		expect(api.stopWorkflowRun).toHaveBeenCalledTimes(1);
		await fireEvent.click(within(dialog).getByRole('button', { name: 'Stop run' }));
		await waitFor(() =>
			expect(api.stopWorkflowRun).toHaveBeenLastCalledWith({
				runId: 'run-a',
				operationId: expect.any(String),
			}),
		);
	});

	it('binds a stored result as $GARCON_WF_RESULT when adding a command step from evidence', async () => {
		vi.mocked(api.addWorkflowStep).mockResolvedValue(workflowRun());
		render(WorkflowRunViewer, { runId: 'run-a', onOpenChat: vi.fn() });
		await fireEvent.click(await screen.findByRole('button', { name: 'Add step' }));
		const form = screen.getByRole('heading', { name: 'Add step' }).closest('form')!;
		await fireEvent.change(within(form).getByLabelText('Step type'), {
			target: { value: 'command' },
		});
		await fireEvent.input(within(form).getByLabelText('Step name'), {
			target: { value: 'Inspect stored finding' },
		});
		await fireEvent.input(within(form).getByLabelText('Command'), {
			target: { value: 'printf %s "$GARCON_WF_RESULT"' },
		});
		await fireEvent.change(within(form).getByLabelText('Start condition'), {
			target: { value: 'result' },
		});
		await fireEvent.change(within(form).getByLabelText('Evidence'), {
			target: { value: 'report-a' },
		});
		expect(within(form).getByLabelText('Expose the result as $GARCON_WF_RESULT')).toBeTruthy();
		vi.mocked(validateStart).mockResolvedValueOnce({ valid: true, isGitRepo: false });
		await fireEvent.click(within(form).getByRole('button', { name: 'Add step' }));
		await waitFor(() => expect(api.addWorkflowStep).toHaveBeenCalledOnce());
		const step = JSON.parse(vi.mocked(api.addWorkflowStep).mock.calls[0][0].source);
		expect(step).toMatchObject({
			kind: 'command',
			command: 'printf %s "$GARCON_WF_RESULT"',
			bindings: { result: 'signal' },
		});
	});

	it('forwards Open in editor and Run again shortcuts from a run header', async () => {
		const run = workflowRun();
		const onOpenEditor = vi.fn();
		const onRunAgain = vi.fn();
		render(WorkflowRunViewer, {
			runId: 'run-a',
			onOpenChat: vi.fn(),
			onOpenEditor,
			onRunAgain,
		});
		await fireEvent.click(await screen.findByRole('button', { name: 'Open in editor' }));
		expect(onOpenEditor).toHaveBeenCalledExactlyOnceWith(run.pinnedRevision, {
			executorId: 'local',
			cwd: '/fixture',
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Run again' }));
		expect(onRunAgain).toHaveBeenCalledExactlyOnceWith(run);
	});
});
