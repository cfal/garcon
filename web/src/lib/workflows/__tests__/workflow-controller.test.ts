import { afterEach, expect, it, vi } from 'vitest';
import type { WorkflowApi } from '$lib/api/workflows.js';
import type { WorkflowDetail, WorkflowAttemptInspection } from '$shared/workflows';
import { SESSION_STORAGE_KEYS } from '$lib/utils/local-persistence.js';
import { WorkflowsController } from '../catalog/workflows-controller.svelte.js';
import { workflowRows, workflowNeedsAttention } from '../detail/workflow-projection.js';

function detail(id: string): WorkflowDetail {
  const plan = { title: id, goal: { kind: 'artifacts' as const, taskIds: ['gate'] }, policy: { allowRemoteWrites: false, concurrency: 1 },
    tasks: [{ id: 'gate', title: 'Decision', dependsOn: [], spec: { kind: 'approval' as const, purpose: 'manual' as const, requirements: [] },
      acceptance: [], retry: { maxAttempts: 1, backoffMs: 1000, repeatableFailure: false } }] };
  const revision = { revision: 1, digest: 'a'.repeat(64), plan };
  return { workflow: { id, revision: 1, desired: 'draft', draftPlanRevision: 1, activePlanRevision: null, admissionEpoch: 0,
    controlEpoch: 0, title: id, captainChatId: null, archived: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    draft: revision, active: null, tasks: [], artifacts: [], approvals: [], gates: [], operations: [], resources: [], outcome: 'pending', activationDigest: 'b'.repeat(64),
    activationManifest: { gateId: 'activation', taskId: null, generation: null, planRevision: 1, planDigest: revision.digest, artifacts: [], publication: null } };
}
function setup() {
  const api = {
    bootstrap: vi.fn<WorkflowApi['bootstrap']>(async () => ({ storeId: 'synthetic-store', revision: 1, enabled: true })),
    list: vi.fn<WorkflowApi['list']>(async () => ({ revision: 1, workflows: ['first', 'second'].map(id => ({ ...detail(id).workflow,
      goal: 'artifacts', completedTasks: 0, totalTasks: 1, attentionTasks: 0, attentionOperations: 0, executorIds: [] })) })),
    detail: vi.fn<WorkflowApi['detail']>(async id => detail(id)),
    attempts: vi.fn<WorkflowApi['attempts']>(async () => []), activity: vi.fn<WorkflowApi['activity']>(async () => []),
    inspectAttempt: vi.fn<WorkflowApi['inspectAttempt']>(async () => { throw new Error('No synthetic attempt'); }),
    inspectGate: vi.fn<WorkflowApi['inspectGate']>(async () => { throw new Error('No synthetic gate'); }),
    operation: vi.fn<WorkflowApi['operation']>(async () => ({ kind: 'not-found' })),
    mutate: vi.fn<WorkflowApi['mutate']>(async request => ({ operationId: request.operationId, workflowId: 'first', revision: 2, collectionRevision: 2 })),
    setEnabled: vi.fn<WorkflowApi['setEnabled']>(async enabled => ({ enabled })),
  } satisfies WorkflowApi;
  const controller = new WorkflowsController(api);
  controller.setAuthority('synthetic-browser');
  controllers.push(controller);
  return { api, controller };
}
const controllers: WorkflowsController[] = [];
afterEach(() => { controllers.splice(0).forEach(controller => controller.dispose()); sessionStorage.clear(); vi.restoreAllMocks(); });

it('does not query before opening, disposes reads on close, and refreshes on reopen', async () => {
  const { controller, api } = setup();
  controller.invalidate(); await controller.refresh();
  expect(api.bootstrap).not.toHaveBeenCalled();
  controller.setPresentationVisible(true); await controller.refresh();
  await vi.waitFor(() => expect(controller.catalog).toHaveLength(2));
  controller.setPresentationVisible(false); const count = api.bootstrap.mock.calls.length;
  controller.invalidate(); await controller.refresh();
  expect(api.bootstrap).toHaveBeenCalledTimes(count);
  controller.setPresentationVisible(true);
  await vi.waitFor(() => expect(api.bootstrap.mock.calls.length).toBeGreaterThan(count));
});

it('late responses from an old selection cannot replace the current workflow', async () => {
  const { controller, api } = setup();
  let resolve!: (value: WorkflowDetail) => void;
  api.detail.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  controller.selectedId = 'first'; controller.setPresentationVisible(true);
  await vi.waitFor(() => expect(resolve).toBeDefined());
  controller.select('second'); resolve(detail('first'));
  await vi.waitFor(() => expect(controller.detail?.workflow.id).toBe('second'));
});

it('keeps lost-reply identity through controller replacement; recovery is explicit and exact', async () => {
  const { controller, api } = setup();
  controller.setPresentationVisible(true);
  await vi.waitFor(() => expect(controller.bootstrap).not.toBeNull());
  api.mutate.mockRejectedValueOnce(new TypeError('Synthetic lost reply'));
  expect(await controller.mutate({ action: 'pause', workflowId: 'first' })).toBe(false);
  const request = controller.recovery!;
  expect(request.mutation).toEqual({ action: 'pause', workflowId: 'first' });
  controller.dispose();
  const restored = new WorkflowsController(api); controllers.push(restored);
  restored.setAuthority('synthetic-browser');
  restored.setPresentationVisible(true);
  await vi.waitFor(() => expect(restored.bootstrap).not.toBeNull());
  expect(api.mutate).toHaveBeenCalledTimes(1);
  await restored.recover();
  expect(api.mutate).toHaveBeenLastCalledWith(request);
  expect(restored.recovery).toBeNull();
});

it('blocks saved operations after storage replacement', async () => {
  const { controller, api } = setup(); controller.setPresentationVisible(true);
  await vi.waitFor(() => expect(controller.bootstrap).not.toBeNull());
  api.mutate.mockRejectedValueOnce(new TypeError('Synthetic lost reply'));
  await controller.mutate({ action: 'pause', workflowId: 'first' });
  controller.bootstrap = { storeId: 'replacement', revision: 0, enabled: true };
  await controller.recover();
  expect(api.mutate).toHaveBeenCalledTimes(1); expect(api.operation).not.toHaveBeenCalled();
  expect(controller.error).toContain('different workflow storage');
  const request = controller.recovery!;
  controller.dismissRecovery();
  expect(controller.recovery).toBeNull();
  expect(JSON.parse(sessionStorage.getItem(SESSION_STORAGE_KEYS.workflowDismissedOperations)!)).toMatchObject([
    { operationId: request.operationId, expectedStoreId: request.expectedStoreId, authority: 'synthetic-browser' },
  ]);
  expect(controller.error).toContain('outcome remains unconfirmed');
  expect(await controller.mutate({ action: 'pause', workflowId: 'second' })).toBe(true);
  expect(api.mutate).toHaveBeenCalledTimes(2);
  expect(api.mutate.mock.calls[1]![0].expectedStoreId).toBe('replacement');
  const reopened = new WorkflowsController(api); controllers.push(reopened);
  expect(reopened.recovery).toBeNull();
  expect(reopened.dismissedRecoveryId).toBe(request.operationId);
});

it('byte-short attempt pages remain pageable and historical inspection is selection-fenced', async () => {
  const { controller, api } = setup();
  const attempt = { attemptId: 'historical', workflowId: 'first', taskId: 'removed', planRevision: 1, generation: 1,
    inputDigest: 'synthetic', dispatchPhase: 'settled' as const, resolution: 'unknown' as const, controlState: 'revoked' as const,
    revocationReason: null, revocationKind: null, admissionFailure: false, requestId: 'synthetic', serverInstanceId: null,
    chatId: null, turnId: null, target: null, result: null, effectiveInput: null, managedTarget: null, createdAt: '2026-01-01' };
  api.attempts.mockResolvedValue([attempt]);
  controller.select('first'); controller.setPresentationVisible(true);
  await vi.waitFor(() => expect(controller.attempts).toHaveLength(1));
  expect(controller.hasMoreAttempts).toBe(true);
  const inspection: WorkflowAttemptInspection = { attempt, task: { ...detail('first').draft.plan.tasks[0]!, id: 'removed' },
    artifacts: [], operations: [], resources: [] };
  api.inspectAttempt.mockResolvedValueOnce(inspection);
  await controller.inspectAttempt(attempt.attemptId);
  expect(controller.inspection).toEqual(inspection);
  let resolve!: (value: WorkflowAttemptInspection) => void;
  api.inspectAttempt.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const pending = controller.inspectAttempt(attempt.attemptId);
  controller.select('second'); resolve(inspection); await pending;
  expect(controller.inspection).toBeNull();
});

it('draft tasks are never painted as accepted active evidence', () => {
  expect(workflowRows(detail('first'), 'draft')[0]?.phase).toBe('draft');
  expect(workflowNeedsAttention('outcome-unknown')).toBe(true);
  expect(workflowNeedsAttention('superseded')).toBe(true);
  expect(workflowNeedsAttention('succeeded')).toBe(false);
});

function inspection(attemptId: string): WorkflowAttemptInspection {
  return { task: detail('first').draft.plan.tasks[0]!, artifacts: [], operations: [], resources: [],
    attempt: { attemptId, workflowId: 'first', taskId: 'gate', planRevision: 1, generation: 1,
      inputDigest: 'synthetic', dispatchPhase: 'settled', resolution: 'unknown', controlState: 'revoked',
      revocationReason: null, revocationKind: null, admissionFailure: false, requestId: 'synthetic', serverInstanceId: null,
      chatId: null, turnId: null, target: null, result: null, effectiveInput: null, managedTarget: null, createdAt: '2026-01-01' } };
}

it.each(['click-first', 'refresh-first'] as const)('a concurrent history click wins over refresh: %s', async order => {
  const { controller, api } = setup(); controller.select('first'); controller.setPresentationVisible(true);
  await vi.waitFor(() => expect(controller.loading).toBe(false));
  api.inspectAttempt.mockImplementation(async (_id, attemptId) => inspection(attemptId));
  await controller.inspectAttempt('older');
  let release!: () => void;
  let click: Promise<void>;
  let refresh: Promise<void>;
  if (order === 'refresh-first') {
    api.activity.mockImplementationOnce(() => new Promise(done => { release = () => done([]); }));
    refresh = controller.refresh();
    await vi.waitFor(() => expect(release).toBeDefined());
    click = controller.inspectAttempt('clicked');
    await click; release();
  } else {
    api.inspectAttempt.mockImplementationOnce(() => new Promise(done => { release = () => done(inspection('clicked')); }));
    click = controller.inspectAttempt('clicked');
    refresh = controller.refresh();
    await refresh; release();
  }
  await click; await refresh;
  expect(controller.inspection?.attempt.attemptId).toBe('clicked');
  expect(controller.selectedTaskId).toBeNull();
  expect(api.inspectAttempt.mock.calls.slice(1).every(([, id]) => id === 'clicked')).toBe(true);
});

it.each(['attempts', 'activity', 'catalog'] as const)('refresh retains loaded and in-flight %s pages without reopening exhausted pagination', async kind => {
  const { controller, api } = setup();
  const activity = (sequence: number) => ({ sequence, workflowId: 'first', action: 'synthetic', actor: 'synthetic', detail: '', at: '2026-01-01' });
  const entry = (id: string) => ({ ...detail(id).workflow, goal: 'artifacts' as const, completedTasks: 0, totalTasks: 1,
    attentionTasks: 0, attentionOperations: 0, executorIds: [] });
  api.attempts.mockResolvedValue([inspection('newer').attempt]);
  api.activity.mockResolvedValue([activity(20)]);
  const firstPage = Array.from({ length: 50 }, (_, i) => entry(`a-${String(i).padStart(2, '0')}`));
  api.list.mockImplementation(async after => ({ revision: 1, workflows: after === null ? firstPage : [entry('z')] }));
  controller.select('first'); controller.setPresentationVisible(true);
  await vi.waitFor(() => expect(controller.loading).toBe(false));
  let release!: () => void;
  if (kind === 'attempts') api.attempts.mockImplementationOnce(() => new Promise(done => { release = () => done([inspection('older').attempt]); }));
  else if (kind === 'activity') api.activity.mockImplementationOnce(() => new Promise(done => { release = () => done([activity(10)]); }));
  else api.list.mockImplementationOnce(() => new Promise(done => { release = () => done({ revision: 1, workflows: [entry('z')] }); }));
  const page = kind === 'catalog' ? controller.loadMore() : controller.loadHistory(kind);
  await controller.refresh(); release(); await page;
  await controller.refresh();
  if (kind === 'attempts') {
    expect(controller.attempts.map(attempt => attempt.attemptId)).toEqual(['newer', 'older']);
    api.attempts.mockResolvedValueOnce([]); await controller.loadHistory(kind); await controller.refresh();
    expect(controller.hasMoreAttempts).toBe(false);
  } else if (kind === 'activity') {
    expect(controller.activity.map(event => event.sequence)).toEqual([20, 10]);
    expect(controller.hasMoreActivity).toBe(false);
  } else {
    expect(controller.catalog.map(workflow => workflow.id)).toEqual([...firstPage.map(workflow => workflow.id), 'z']);
    expect(controller.hasMore).toBe(false);
  }
});

it.each(['before-refresh', 'after-refresh'] as const)('retargets a concurrent task click to the refreshed attempt when its old reply arrives %s', async order => {
  const { controller, api } = setup();
  let generation = 1;
  const inspected = (id: string) => ({ ...inspection(id), attempt: { ...inspection(id).attempt, generation: Number(id.at(-1)) } });
  api.detail.mockImplementation(async () => ({ ...detail('first'), tasks: [{ workflowId: 'first', id: 'gate', generation,
    inputDigest: 'synthetic', hold: 'output-unknown', holdReason: null, nextEligibleAt: null,
    phase: 'outcome-unknown', blockedReason: null, attempt: inspected(`attempt-${generation}`).attempt }] }));
  api.inspectAttempt.mockImplementation(async (_id, id) => inspected(id));
  controller.select('first'); controller.setPresentationVisible(true);
  await vi.waitFor(() => expect(controller.loading).toBe(false));
  let releaseRefresh!: () => void;
  let releaseOldInspection!: () => void;
  api.activity.mockImplementationOnce(() => new Promise(done => { releaseRefresh = () => done([]); }));
  api.inspectAttempt.mockImplementationOnce(() => new Promise(done => { releaseOldInspection = () => done(inspected('attempt-1')); }));
  generation = 2;
  const refresh = controller.refresh();
  await vi.waitFor(() => expect(releaseRefresh).toBeDefined());
  controller.selectTask('gate');
  if (order === 'before-refresh') {
    releaseOldInspection();
    await vi.waitFor(() => expect(controller.inspection?.attempt.attemptId).toBe('attempt-1'));
  }
  releaseRefresh(); await refresh;
  if (order === 'after-refresh') releaseOldInspection();
  await vi.waitFor(() => expect(controller.inspection?.attempt.attemptId).toBe('attempt-2'));
  expect(controller.detail?.tasks[0]!.attempt?.attemptId).toBe('attempt-2');
  expect(controller.selectedTaskId).toBe('gate');
});

it('refresh reconciles an exhausted catalog tail, including insertions and changed attention beyond page one', async () => {
  const { controller, api } = setup();
  const entries = Array.from({ length: 60 }, (_, i) => ({ ...detail(`id-${String(i * 2).padStart(3, '0')}`).workflow,
    goal: 'artifacts' as const, completedTasks: 0, totalTasks: 1, attentionTasks: 0, attentionOperations: 0, executorIds: [] }));
  let revision = 1;
  api.list.mockImplementation(async after => ({ revision, workflows: entries.filter(entry => after === null || entry.id > after).slice(0, 50) }));
  controller.setPresentationVisible(true);
  await vi.waitFor(() => expect(controller.loading).toBe(false));
  await controller.loadMore(); expect(controller.catalog).toHaveLength(60); expect(controller.hasMore).toBe(false);
  entries[55] = { ...entries[55]!, attentionTasks: 1 };
  entries.push({ ...entries[0]!, id: 'id-109' }, { ...entries[0]!, id: 'id-999' });
  entries.sort((a, b) => a.id.localeCompare(b.id)); revision++;
  await controller.refresh();
  expect(controller.catalog).toEqual(entries);
  expect(controller.hasMore).toBe(false);
});

it('refresh updates a resolved exact attempt retained on an older history page', async () => {
  const { controller, api } = setup();
  api.attempts.mockResolvedValue([inspection('newer').attempt]);
  api.inspectAttempt.mockResolvedValue(inspection('older'));
  controller.select('first'); controller.setPresentationVisible(true);
  await vi.waitFor(() => expect(controller.loading).toBe(false));
  api.attempts.mockResolvedValueOnce([inspection('older').attempt]);
  await controller.loadHistory('attempts');
  await controller.inspectAttempt('older');
  api.inspectAttempt.mockResolvedValue({ ...inspection('older'), attempt: { ...inspection('older').attempt, resolution: 'abandoned' } });
  await controller.refresh();
  expect(controller.attempts.find(attempt => attempt.attemptId === 'older')?.resolution).toBe('abandoned');
});

it('gate inspection survives an unrelated refresh but remains selection and digest fenced', async () => {
  const { controller, api } = setup();
  const gate = { manifest: { ...detail('first').activationManifest, gateId: 'gate' }, digest: 'synthetic-gate' };
  api.detail.mockResolvedValue({ ...detail('first'), gates: [gate] });
  controller.select('first'); controller.setPresentationVisible(true);
  await vi.waitFor(() => expect(controller.loading).toBe(false));
  let release!: () => void;
  api.inspectGate.mockImplementationOnce(() => new Promise(done => { release = () => done({ ...gate, evidence: [] }); }));
  const pending = controller.inspectGate('gate');
  await controller.refresh(); release();
  expect(await pending).toEqual({ ...gate, evidence: [] });
  api.inspectGate.mockImplementationOnce(() => new Promise(done => { release = () => done({ ...gate, evidence: [] }); }));
  const stale = controller.inspectGate('gate'); controller.select('second'); release();
  expect(await stale).toBeNull();
});

it.each(['captured', 'refreshed'] as const)('gate inspection rejects %s evidence after its approval digest changes', async reply => {
  const { controller, api } = setup();
  const gate = { manifest: { ...detail('first').activationManifest, gateId: 'gate' }, digest: 'captured-gate' };
  api.detail.mockResolvedValue({ ...detail('first'), gates: [gate] });
  controller.select('first'); controller.setPresentationVisible(true);
  await vi.waitFor(() => expect(controller.loading).toBe(false));
  let release!: () => void;
  api.inspectGate.mockImplementationOnce(() => new Promise(done => { release = () => done({ ...gate,
    digest: reply === 'captured' ? gate.digest : 'refreshed-gate', evidence: [] }); }));
  const pending = controller.inspectGate('gate');
  api.detail.mockResolvedValue({ ...detail('first'), gates: [{ ...gate, digest: 'refreshed-gate' }] });
  await controller.refresh(); release();
  expect(await pending).toBeNull();
  expect(controller.error).toBe('Approval changed while loading its evidence.');
});

it.each([false, true])('hiding the surface cancels a pending gate inspection even after reopen=%s', async reopen => {
  const { controller, api } = setup();
  const gate = { manifest: { ...detail('first').activationManifest, gateId: 'gate' }, digest: 'synthetic-gate' };
  api.detail.mockResolvedValue({ ...detail('first'), gates: [gate] });
  controller.select('first'); controller.setPresentationVisible(true);
  await vi.waitFor(() => expect(controller.loading).toBe(false));
  let release!: () => void;
  api.inspectGate.mockImplementationOnce(() => new Promise(done => { release = () => done({ ...gate, evidence: [] }); }));
  const pending = controller.inspectGate('gate');
  controller.setPresentationVisible(false);
  if (reopen) controller.setPresentationVisible(true);
  release(); expect(await pending).toBeNull();
});

it.each(['current', 'history'] as const)('refresh follows the current generation only for a %s task selection', async selection => {
  const { controller, api } = setup();
  const task = detail('first').draft.plan.tasks[0]!;
  const inspection = (generation: number): WorkflowAttemptInspection => ({ task, artifacts: [], operations: [], resources: [],
    attempt: { attemptId: `attempt-${generation}`, workflowId: 'first', taskId: task.id, planRevision: 1, generation,
      inputDigest: 'synthetic', dispatchPhase: 'settled', resolution: 'unknown', controlState: 'revoked',
      revocationReason: null, revocationKind: null, admissionFailure: false, requestId: 'synthetic', serverInstanceId: null,
      chatId: null, turnId: null, target: null, result: null, effectiveInput: null, managedTarget: null, createdAt: '2026-01-01' } });
  let generation = 1;
  api.detail.mockImplementation(async () => ({ ...detail('first'), tasks: [{ workflowId: 'first', id: task.id,
    generation, inputDigest: 'synthetic', hold: 'none', holdReason: null, nextEligibleAt: null,
    phase: 'outcome-unknown', blockedReason: null, attempt: inspection(generation).attempt }] }));
  api.inspectAttempt.mockImplementation(async (_id, attemptId) => inspection(Number(attemptId.split('-')[1])));
  controller.select('first'); controller.setPresentationVisible(true);
  await vi.waitFor(() => expect(controller.loading).toBe(false));
  if (selection === 'current') controller.selectTask(task.id);
  else await controller.inspectAttempt('attempt-1');
  await vi.waitFor(() => expect(controller.inspection?.attempt.attemptId).toBe('attempt-1'));
  generation = 2;
  await controller.refresh();
  expect(controller.detail?.tasks[0]!.attempt?.attemptId).toBe('attempt-2');
  expect(controller.inspection?.attempt.attemptId).toBe(selection === 'current' ? 'attempt-2' : 'attempt-1');
});

it('draft-only plans select Draft and creation retains the explicit Captain link', async () => {
  const { controller, api } = setup();
  controller.select('first'); controller.setPresentationVisible(true);
  await vi.waitFor(() => expect(controller.detail).not.toBeNull());
  expect(controller.planView).toBe('draft');
  controller.newDraft('synthetic-chat');
  controller.editor = JSON.stringify(detail('new').draft.plan);
  await controller.saveDraft();
  expect(api.mutate.mock.calls[0]![0].mutation).toMatchObject({ action: 'create', captainChatId: 'synthetic-chat' });
});

it('a different browser principal cannot resubmit an unconfirmed mutation', async () => {
  const { controller, api } = setup(); controller.setPresentationVisible(true);
  await vi.waitFor(() => expect(controller.bootstrap).not.toBeNull());
  api.mutate.mockRejectedValueOnce(new TypeError('Lost reply'));
  await controller.mutate({ action: 'pause', workflowId: 'first' });
  controller.setAuthority('replacement-browser');
  await controller.recover();
  expect(api.operation).not.toHaveBeenCalled();
  expect(api.mutate).toHaveBeenCalledTimes(1);
  expect(controller.error).toContain('another browser principal');
});

it('old paginated history cannot leak into a new selection', async () => {
  const { controller, api } = setup(); controller.select('first'); controller.setPresentationVisible(true);
  await vi.waitFor(() => expect(controller.detail).not.toBeNull());
  let resolve!: (value: Awaited<ReturnType<WorkflowApi['activity']>>) => void;
  api.activity.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const loading = controller.loadHistory('activity');
  controller.select('second');
  resolve([{ sequence: 10, workflowId: 'first', action: 'stale', actor: 'synthetic', detail: '', at: '2026-01-01' }]);
  await loading;
  expect(controller.activity).toEqual([]);
});
