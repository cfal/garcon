import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import type { WorkflowDetail } from '$shared/workflows';
import type * as Context from '$lib/context';
import { WorkflowsController } from '$lib/workflows/catalog/workflows-controller.svelte.js';
import WorkflowSurface from '../WorkflowSurface.svelte';

vi.mock('$lib/context', async (importOriginal) => ({
  ...await importOriginal<typeof import('$lib/context')>(),
  getAuth: () => ({ isAuthenticated: false, authDisabled: false, presentationOwner: null
  } satisfies Pick<ReturnType<typeof Context.getAuth>, 'isAuthenticated' | 'authDisabled' | 'presentationOwner'>),
  getRemoteSettings: () => ({ snapshot: null } satisfies Pick<ReturnType<typeof Context.getRemoteSettings>, 'snapshot'>),
  getExecutors: () => ({ isReady: () => true } satisfies Pick<ReturnType<typeof Context.getExecutors>, 'isReady'>),
  getConversationUi: () => ({ pendingPermissionChatIds: []
  } satisfies Pick<ReturnType<typeof Context.getConversationUi>, 'pendingPermissionChatIds'>),
}));

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function setup() {
  const plan = { title: 'Synthetic workflow', policy: { concurrency: 1, allowRemoteWrites: false },
    goal: { kind: 'artifacts' as const, taskIds: ['gate'] }, tasks: [{ id: 'gate', title: 'Synthetic gate',
      dependsOn: [], acceptance: [], retry: { maxAttempts: 1, backoffMs: 1000, repeatableFailure: false },
      spec: { kind: 'approval' as const, purpose: 'manual' as const, requirements: [] } }] };
  const manifest = { gateId: 'activation', taskId: null, generation: null, planRevision: 1,
    planDigest: 'a'.repeat(64), artifacts: [], publication: null };
  const detail: WorkflowDetail = { workflow: { id: 'synthetic', title: plan.title, revision: 1, desired: 'draft',
    draftPlanRevision: 1, activePlanRevision: null, admissionEpoch: 1, controlEpoch: 1, captainChatId: null,
    archived: false, createdAt: '2026-01-01', updatedAt: '2026-01-01' }, draft: { revision: 1, digest: manifest.planDigest, plan },
    active: null, tasks: [], artifacts: [], approvals: [], gates: [], operations: [], resources: [], outcome: 'pending',
    activationManifest: manifest, activationDigest: 'b'.repeat(64) };
  const controller = new WorkflowsController();
  controller.selectedId = detail.workflow.id;
  controller.detail = detail;
  return { controller, detail };
}

it('keeps the plan selector outside the workflow tablist', () => {
  const { controller } = setup();
  render(WorkflowSurface, { controller, visible: false, onOpenChat: vi.fn() });
  const tabs = screen.getByRole('tablist', { name: 'Workflow views' });
  expect(within(tabs).getAllByRole('tab')).toHaveLength(5);
  expect(tabs.contains(screen.getByRole('combobox', { name: 'Plan revision' }))).toBe(false);
  controller.dispose();
});

it('shows current cleanup attention without depending on the paginated attempt history', () => {
  const { controller, detail } = setup();
  controller.tab = 'attention';
  controller.detail = { ...detail, active: detail.draft, tasks: [{ workflowId: 'synthetic', id: 'gate', generation: 1,
    inputDigest: 'synthetic', hold: 'none', holdReason: null, nextEligibleAt: null, phase: 'succeeded', blockedReason: null,
    attempt: { workflowId: 'synthetic', taskId: 'gate', attemptId: 'old-current', generation: 1, inputDigest: 'synthetic',
      planRevision: 1, dispatchPhase: 'settled', resolution: 'succeeded', controlState: 'released', chatId: null,
      createdAt: '2026-01-01', result: null } }], operations: [{ id: 'refusal', attemptId: 'old-current',
      kind: 'cleanup', status: 'not-started', resourceKey: 'retained', stage: null, reconcileCount: 0,
      nextReconcileAt: null, detail: 'Synthetic cleanup refusal' }] };
  expect(controller.attempts).toEqual([]);
  render(WorkflowSurface, { controller, visible: false, onOpenChat: vi.fn() });
  expect(screen.getByText('Synthetic cleanup refusal')).toBeTruthy();
  expect(screen.getByText('Synthetic gate')).toBeTruthy();
  controller.dispose();
});

it.each([true, false])('changing the generation resets evidence with attempt=%s', async hasAttempt => {
  const { controller, detail } = setup();
  const current = { workflowId: 'synthetic', id: 'gate', generation: 1, inputDigest: 'synthetic', hold: 'output-unknown' as const,
    holdReason: null, nextEligibleAt: null, phase: 'outcome-unknown' as const, blockedReason: null,
    attempt: { workflowId: 'synthetic', taskId: 'gate', attemptId: 'first', generation: 1, inputDigest: 'synthetic',
      planRevision: 1, dispatchPhase: 'settled' as const, resolution: 'unknown' as const, controlState: 'released' as const,
      chatId: null, createdAt: '2026-01-01', result: null } };
  controller.detail = { ...detail, active: detail.draft, tasks: [{ ...current, attempt: hasAttempt ? current.attempt : null }] };
  controller.selectedTaskId = 'gate';
  render(WorkflowSurface, { controller, visible: false, onOpenChat: vi.fn() });
  const label = hasAttempt ? 'Evidence' : 'Resolution evidence';
  await fireEvent.input(screen.getByLabelText(label), { target: { value: 'Synthetic first-attempt evidence' } });
  if (hasAttempt) await fireEvent.click(screen.getByRole('checkbox'));
  flushSync(() => { controller.detail = { ...controller.detail!, tasks: [{ ...current, generation: 2,
    attempt: hasAttempt ? { ...current.attempt, attemptId: 'second', generation: 2 } : null }] }; });
  expect((screen.getByLabelText(label) as HTMLTextAreaElement).value).toBe('');
  if (hasAttempt) expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  controller.dispose();
});
