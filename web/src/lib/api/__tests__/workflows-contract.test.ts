import { afterEach, expect, it, vi } from 'vitest';
import { apiGet } from '../client.js';
import { workflowApi } from '../workflows.js';
import type { WorkflowOverview, WorkflowPlanRevision } from '$shared/workflows';

vi.mock('../client.js', () => ({ apiGet: vi.fn(), apiPost: vi.fn(), apiPut: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const plan: WorkflowPlanRevision = { revision: 1, digest: 'sha256:' + 'a'.repeat(64), plan: { title: 'Synthetic',
  policy: { allowRemoteWrites: false, concurrency: 1 }, goal: { kind: 'artifacts', taskIds: ['gate'] }, tasks: [{
    id: 'gate', title: 'Synthetic gate', spec: { kind: 'approval', purpose: 'manual', requirements: [] }, dependsOn: [],
    acceptance: [], retry: { maxAttempts: 1, backoffMs: 1000, repeatableFailure: false },
  }] } };
const overview: WorkflowOverview = { workflow: { id: 'workflow', revision: 1, desired: 'paused', draftPlanRevision: 1,
  activePlanRevision: 1, admissionEpoch: 1, controlEpoch: 1, title: 'Synthetic', captainChatId: null, archived: false,
  createdAt: '2026-01-01', updatedAt: '2026-01-01' }, draft: { revision: plan.revision, digest: plan.digest },
  active: { revision: plan.revision, digest: plan.digest }, tasks: [], gates: [], outcome: 'pending', operations: [], resources: [],
  activationDigest: 'sha256:' + 'b'.repeat(64), activationManifest: { gateId: 'activation', planRevision: 1, planDigest: plan.digest,
    taskId: null, generation: null, artifacts: [], publication: null } };

it('assembles the bounded overview and exact immutable plan without loading artifacts or history', async () => {
  vi.mocked(apiGet).mockResolvedValueOnce(overview).mockResolvedValueOnce(plan);
  const detail = await workflowApi.detail('workflow');
  expect(detail).toMatchObject({ active: plan, draft: plan, artifacts: [], approvals: [] });
  expect(apiGet).toHaveBeenCalledTimes(2);
  expect(vi.mocked(apiGet).mock.calls.map(call => call[0])).toEqual([
    '/api/v1/workflows/detail?id=workflow', '/api/v1/workflows/plan?id=workflow&planRevision=1',
  ]);
});

it('rejects a mismatched immutable plan before publishing the detail', async () => {
  vi.mocked(apiGet).mockResolvedValueOnce(overview).mockResolvedValueOnce({ ...plan, digest: 'changed' });
  await expect(workflowApi.detail('workflow')).rejects.toThrow('plan reply identity changed');
});

it('exact attempt inspection rejects another workflow or attempt identity', async () => {
  vi.mocked(apiGet).mockResolvedValueOnce({ attempt: { workflowId: 'another', attemptId: 'historical' } });
  await expect(workflowApi.inspectAttempt('workflow', 'historical')).rejects.toThrow('identity changed');
  expect(apiGet).toHaveBeenCalledWith('/api/v1/workflows/attempt?id=workflow&attemptId=historical', expect.anything());
});
