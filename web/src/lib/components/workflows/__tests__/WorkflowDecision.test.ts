import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import type { WorkflowDetail } from '$shared/workflows';
import WorkflowDecision from '../WorkflowDecision.svelte';

afterEach(cleanup);

function detail(): WorkflowDetail {
  const plan = { title: 'Synthetic plan', policy: { concurrency: 1, allowRemoteWrites: false },
    goal: { kind: 'artifacts' as const, taskIds: [] }, tasks: [] };
  const manifest = { gateId: 'activation', taskId: null, generation: null, planRevision: 1,
    planDigest: 'a'.repeat(64), artifacts: [], publication: null };
  return { workflow: { id: 'synthetic', title: plan.title, revision: 1, desired: 'draft', draftPlanRevision: 1,
    activePlanRevision: null, admissionEpoch: 1, controlEpoch: 1, captainChatId: null, archived: false,
    createdAt: '2026-01-01', updatedAt: '2026-01-01' }, draft: { revision: 1, digest: manifest.planDigest, plan },
    active: null, tasks: [], artifacts: [], approvals: [], gates: [], operations: [], resources: [], outcome: 'pending',
    activationManifest: manifest, activationDigest: 'b'.repeat(64) };
}

it('requires explicit acknowledgement and submits the displayed exact activation digest', async () => {
  const onsubmit = vi.fn(async () => true);
  const onclose = vi.fn();
  render(WorkflowDecision, { detail: detail(), gate: null, pending: false, onsubmit, onclose });
  const button = screen.getByRole('button', { name: 'Activate plan' });
  expect(button.hasAttribute('disabled')).toBe(true);
  await fireEvent.click(screen.getByRole('checkbox'));
  expect(button.hasAttribute('disabled')).toBe(false);
  await fireEvent.click(button);
  expect(onsubmit).toHaveBeenCalledExactlyOnceWith({ action: 'activate', workflowId: 'synthetic', manifestDigest: 'b'.repeat(64) });
  expect(onclose).toHaveBeenCalledOnce();
});

it('keeps a rejected stale-manifest submission open and fences pending decisions', async () => {
  const onsubmit = vi.fn(async () => false);
  const onclose = vi.fn();
  const view = render(WorkflowDecision, { detail: detail(), gate: null, pending: false, onsubmit, onclose });
  await fireEvent.click(screen.getByRole('checkbox'));
  await fireEvent.click(screen.getByRole('button', { name: 'Activate plan' }));
  expect(onclose).not.toHaveBeenCalled();
  await view.rerender({ pending: true });
  expect(screen.getByRole('button', { name: 'Activate plan' }).hasAttribute('disabled')).toBe(true);
});
