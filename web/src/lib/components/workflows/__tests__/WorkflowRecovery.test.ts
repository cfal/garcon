import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import type { WorkflowAttempt, WorkflowDetail, WorkflowPlanTask, WorkflowTaskView } from '$shared/workflows';
import { WorkflowsController } from '$lib/workflows/catalog/workflows-controller.svelte.js';
import WorkflowTaskInspector from '../WorkflowTaskInspector.svelte';

afterEach(() => { cleanup(); sessionStorage.clear(); vi.restoreAllMocks(); });

function fixture() {
  const target = { executorId: 'local', projectPath: '/synthetic/managed', repositoryId: 'synthetic-repo', baseCommit: 'a'.repeat(40),
    worktreeRoot: '/synthetic', remote: null, inputTaskId: null };
  const task: WorkflowPlanTask = { id: 'implement', title: 'Synthetic output', dependsOn: [], acceptance: [],
    retry: { maxAttempts: 1, backoffMs: 1000, repeatableFailure: false }, spec: { kind: 'agent', target,
      prompt: 'Synthetic implementation', outputs: ['commit'], selection: { agentId: 'claude', model: 'synthetic',
        apiProviderId: null, modelEndpointId: null, modelProtocol: null, providerRevision: null, permissionMode: 'default',
        thinkingMode: 'none', agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} }, preambles: [] } } };
  const attempt: WorkflowAttempt = { workflowId: 'workflow', taskId: task.id, generation: 1, attemptId: 'attempt', inputDigest: 'b'.repeat(64),
    planRevision: 1, dispatchPhase: 'settled', resolution: 'unknown', controlState: 'released', revocationReason: null,
    revocationKind: null, admissionFailure: false, requestId: 'request', serverInstanceId: 'server', chatId: null, turnId: null,
    target, effectiveInput: null, result: null, createdAt: '2026-01-01', managedTarget: { operationId: 'create', resourceKey: 'c'.repeat(64),
      target, managedResourceId: 'resource', repositoryIdentity: 'repository', worktreeIdentity: 'worktree', branch: 'managed',
      head: target.baseCommit, baseTree: 'd'.repeat(40), instanceId: 'runtime', sourceProjectPath: '/synthetic/repository' } };
  const current: WorkflowTaskView = { workflowId: attempt.workflowId, id: task.id, generation: 1, inputDigest: attempt.inputDigest,
    hold: 'output-unknown', holdReason: 'Synthetic uncertainty', nextEligibleAt: null, phase: 'outcome-unknown', blockedReason: null, attempt };
  const plan = { title: 'Synthetic workflow', goal: { kind: 'artifacts' as const, taskIds: [task.id] },
    policy: { concurrency: 1, allowRemoteWrites: false }, tasks: [task] };
  const revision = { revision: 1, digest: 'e'.repeat(64), plan };
  const detail: WorkflowDetail = { workflow: { id: attempt.workflowId, revision: 1, desired: 'paused', draftPlanRevision: 1,
    activePlanRevision: 1, admissionEpoch: 1, controlEpoch: 1, title: plan.title, captainChatId: null, archived: false,
    createdAt: '2026-01-01', updatedAt: '2026-01-01' }, draft: revision, active: revision, tasks: [current], artifacts: [],
    approvals: [], gates: [], outcome: 'needs-attention', activationManifest: { gateId: 'activation', planRevision: 1,
      planDigest: revision.digest, taskId: null, generation: null, artifacts: [], publication: null }, activationDigest: 'f'.repeat(64),
    operations: [], resources: [{ resourceKey: attempt.managedTarget!.resourceKey, attemptId: attempt.attemptId, executorId: 'local',
      quarantined: false, riskReleased: false, retained: true }] };
  const controller = new WorkflowsController(); controller.detail = detail; controller.attempts = [attempt];
  const mutate = vi.spyOn(controller, 'mutate').mockResolvedValue(true);
  const props = { row: { task, current, phase: current.phase }, controller, canDecide: true, canRecover: true,
    onOpenChat: vi.fn(), onclose: vi.fn() };
  return { props, controller, mutate, attempt, detail };
}

it('adoption submits the exact attempt and SHA with no implicit risk release', async () => {
  const f = fixture(); render(WorkflowTaskInspector, f.props);
  const decision = screen.getByLabelText('Decision') as HTMLSelectElement;
  // Happy DOM does not implement option :checked, which Svelte uses for select bindings.
  const query = decision.querySelector.bind(decision);
  vi.spyOn(decision, 'querySelector').mockImplementation((selector: string) => selector === ':checked'
    ? decision.options[decision.selectedIndex] ?? null : query(selector));
  decision.selectedIndex = 2;
  expect(decision.value).toBe('adopt');
  expect((decision.querySelector(':checked') as HTMLOptionElement | null)?.value).toBe('adopt');
  await fireEvent.change(decision);
  await fireEvent.input(await screen.findByLabelText('Exact commit'), { target: { value: '1'.repeat(40) } });
  await fireEvent.input(screen.getByLabelText('Evidence'), { target: { value: 'Synthetic independent inspection' } });
  await fireEvent.submit(screen.getByRole('button', { name: 'Record resolution' }).closest('form')!);
  expect(f.mutate).toHaveBeenCalledExactlyOnceWith({ action: 'resolve', workflowId: 'workflow', taskId: 'implement', attemptId: 'attempt',
    generation: 1, resolution: 'adopt', evidence: 'Synthetic independent inspection', commit: '1'.repeat(40), releaseRisk: false });
});

it('revoked browser authority blocks form submission as well as the button', async () => {
  const f = fixture(); const view = render(WorkflowTaskInspector, f.props);
  await fireEvent.input(screen.getByLabelText('Evidence'), { target: { value: 'Synthetic inspection' } });
  await view.rerender({ canRecover: false });
  const button = screen.getByRole('button', { name: 'Record resolution' });
  expect(button.hasAttribute('disabled')).toBe(true);
  await fireEvent.submit(button.closest('form')!);
  expect(f.mutate).not.toHaveBeenCalled();
});

it('cleanup requires explicit ignored-file acknowledgement and carries recorded identity', async () => {
  const f = fixture(); f.controller.detail = { ...f.detail, workflow: { ...f.detail.workflow, archived: true } };
  render(WorkflowTaskInspector, f.props);
  await fireEvent.click(screen.getByRole('button', { name: 'Remove worktree' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText(/Ignored files are removed/)).toBeDefined();
  const button = within(dialog).getByRole('button', { name: 'Remove worktree' });
  await fireEvent.submit(button.closest('form')!); expect(f.mutate).not.toHaveBeenCalled();
  await fireEvent.click(within(dialog).getByRole('checkbox'));
  await fireEvent.submit(button.closest('form')!);
  expect(f.mutate).toHaveBeenCalledExactlyOnceWith({ action: 'cleanup', workflowId: 'workflow', attemptId: 'attempt',
    resourceKey: 'c'.repeat(64), expectedHead: 'a'.repeat(40) });
});

it('publication recovery names the original effect and remains disabled without browser authority', async () => {
  const f = fixture(); f.controller.detail = { ...f.detail, operations: [{ id: 'original-create', attemptId: 'attempt', kind: 'publication',
    resourceKey: 'c'.repeat(64), status: 'unknown', reconcileCount: 5, nextReconcileAt: null, stage: 'create', detail: 'Synthetic lost reply' }] };
  const view = render(WorkflowTaskInspector, f.props);
  await fireEvent.click(screen.getByRole('button', { name: 'Recheck original PR' }));
  expect(f.mutate).toHaveBeenCalledExactlyOnceWith({ action: 'recheck-publication', workflowId: 'workflow', attemptId: 'attempt', publicationOperationId: 'original-create' });
  await view.rerender({ canRecover: false });
  expect(screen.getByRole('button', { name: 'Recheck original PR' }).hasAttribute('disabled')).toBe(true);
});

it('historical recovery remains reachable without current-plan membership or the latest attempt page', async () => {
  const f = fixture();
  f.controller.attempts = [];
  f.controller.detail = { ...f.detail, tasks: [], resources: [], workflow: { ...f.detail.workflow, archived: true } };
  render(WorkflowTaskInspector, { ...f.props, row: { ...f.props.row, current: null }, history: {
    task: f.props.row.task, attempt: f.attempt, artifacts: [], resources: f.detail.resources,
    operations: [{ id: 'historical-create', attemptId: f.attempt.attemptId, kind: 'publication', resourceKey: 'c'.repeat(64),
      stage: 'create', status: 'unknown', reconcileCount: 5, nextReconcileAt: null, detail: 'Synthetic historical uncertainty' }],
  } });
  expect(screen.getByText(/Historical attempt/)).toBeDefined();
  expect(screen.getByRole('button', { name: 'Remove worktree' })).toBeDefined();
  await fireEvent.click(screen.getByRole('button', { name: 'Recheck original PR' }));
  expect(f.mutate).toHaveBeenCalledExactlyOnceWith({ action: 'recheck-publication', workflowId: 'workflow', attemptId: 'attempt', publicationOperationId: 'historical-create' });
  f.mutate.mockClear();
  expect(screen.queryByRole('option', { name: 'Adopt independently verified output' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'New generation' })).toBeNull();
  await fireEvent.input(screen.getByLabelText('Evidence'), { target: { value: 'Synthetic historical abandonment' } });
  await fireEvent.submit(screen.getByRole('button', { name: 'Record resolution' }).closest('form')!);
  expect(f.mutate).toHaveBeenCalledExactlyOnceWith({ action: 'resolve', workflowId: 'workflow', taskId: 'implement', attemptId: 'attempt',
    generation: 1, resolution: 'abandon', evidence: 'Synthetic historical abandonment', commit: null, releaseRisk: false });
});

it('historical form submission cannot reuse a current-attempt adoption selection', async () => {
  const f = fixture(); const view = render(WorkflowTaskInspector, f.props);
  const decision = screen.getByLabelText('Decision') as HTMLSelectElement;
  const query = decision.querySelector.bind(decision);
  vi.spyOn(decision, 'querySelector').mockImplementation((selector: string) => selector === ':checked'
    ? decision.options[decision.selectedIndex] ?? null : query(selector));
  decision.selectedIndex = 2; await fireEvent.change(decision);
  await fireEvent.input(screen.getByLabelText('Evidence'), { target: { value: 'Synthetic inspection' } });
  await view.rerender({ row: { ...f.props.row, current: null }, history: {
    task: f.props.row.task, attempt: f.attempt, artifacts: [], operations: [], resources: [],
  } });
  await fireEvent.submit(screen.getByRole('button', { name: 'Record resolution' }).closest('form')!);
  expect(f.mutate).not.toHaveBeenCalled();
});

it('mismatched inspection evidence cannot expose recovery or retry controls for the current attempt', async () => {
  const f = fixture(); const view = render(WorkflowTaskInspector, f.props);
  await fireEvent.input(screen.getByLabelText('Evidence'), { target: { value: 'Synthetic old-attempt evidence' } });
  const form = screen.getByRole('button', { name: 'Record resolution' }).closest('form')!;
  await view.rerender({ history: { task: f.props.row.task, attempt: { ...f.attempt, attemptId: 'older' },
    artifacts: [], operations: [], resources: [] } });
  expect(screen.queryByRole('button', { name: 'Record resolution' })).toBeNull();
  await fireEvent.submit(form);
  expect(f.mutate).not.toHaveBeenCalled();
});

it('clear-hold submission rechecks the inspected identity after its form is removed', async () => {
  const f = fixture();
  const current = { ...f.props.row.current, attempt: { ...f.attempt, resolution: 'not-started' as const } };
  const view = render(WorkflowTaskInspector, { ...f.props, row: { ...f.props.row, current, phase: 'interrupted' } });
  await fireEvent.input(screen.getByLabelText('Resolution evidence'), { target: { value: 'Synthetic old-attempt evidence' } });
  const form = screen.getByRole('button', { name: 'Clear admission hold' }).closest('form')!;
  await view.rerender({ history: { task: f.props.row.task, attempt: { ...f.attempt, attemptId: 'older' },
    artifacts: [], operations: [], resources: [] } });
  expect(screen.queryByRole('button', { name: 'Clear admission hold' })).toBeNull();
  await fireEvent.submit(form);
  expect(f.mutate).not.toHaveBeenCalled();
});
