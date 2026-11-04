import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowAttempt, WorkflowManagedTarget, WorkflowMutation, WorkflowPlan } from '../../../../common/workflows.js';
import type { WorkflowAuthority, WorkflowEffectFence } from '../contracts.js';
import { WorkflowService } from '../service.js';
import { WorkflowStore } from '../store.js';
import { managedTargetRequest } from '../managed-target.js';
import type { WorkflowResources } from '../resources.js';

export const browser: WorkflowAuthority = { key: 'browser:synthetic', browserSession: true, assertCurrent() {} };
export const local: WorkflowAuthority = { key: 'local', browserSession: false, assertCurrent() {} };
export const commit = 'a'.repeat(40);
export function effectFence(): WorkflowEffectFence {
  return { revoked: false, reason: null, revocationKind: null,
    revokedSignal: new AbortController().signal, shutdown: new AbortController().signal };
}

export function managedTarget(attempt: WorkflowAttempt, resourceKey = attempt.attemptId,
  projectPath = `/synthetic/worktrees/${resourceKey}`): WorkflowManagedTarget {
  return { operationId: crypto.randomUUID(), resourceKey, target: { ...attempt.target!, projectPath },
    managedResourceId: crypto.randomUUID(), repositoryIdentity: '/synthetic/admin', worktreeIdentity: `/synthetic/admin/${resourceKey}`,
    branch: `managed/${resourceKey}`, head: attempt.target!.baseCommit };
}

export function prepareManagedTarget(resources: WorkflowResources, attempt: WorkflowAttempt, resourceKey = attempt.attemptId): WorkflowManagedTarget {
  const resource = managedTarget(attempt, resourceKey);
  resources.plan({ operationId: resource.operationId, attemptId: attempt.attemptId, kind: 'worktree', resourceKey,
    payload: JSON.stringify(managedTargetRequest(resource)) });
  resources.begin(resource.operationId, effectFence());
  resources.observe(resource.operationId, 'succeeded', JSON.stringify(resource));
  return resource;
}
export function plan(): WorkflowPlan {
  return { title: 'Synthetic delivery', goal: { kind: 'artifacts', taskIds: ['check'] },
    policy: { allowRemoteWrites: false, concurrency: 2 }, tasks: [{ id: 'check', title: 'Check', dependsOn: [],
      spec: { kind: 'command', target: { executorId: 'local', projectPath: '/synthetic/repo', repositoryId: 'synthetic', baseCommit: commit, remote: null },
        shellModel: 'bash', command: 'printf synthetic', timeoutMs: 1000, expectedExitCode: 0, outputRequirement: 'full-log' },
      acceptance: [], retry: { maxAttempts: 1, backoffMs: 1000, repeatableFailure: false } }] };
}
export function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'workflow-test-'));
  const controls = { failCommit: false, enabled: true };
  let store = new WorkflowStore(directory, () => { if (controls.failCommit) throw new Error('Synthetic commit failure'); });
  let service = new WorkflowService(store, { enabled: () => controls.enabled });
  const write = (mutation: WorkflowMutation, authority = browser, operationId = crypto.randomUUID()) => service.execute({ operationId, mutation }, authority);
  return { directory, controls, get store() { return store; }, get service() { return service; }, write,
    create() { return write({ action: 'create', plan: plan(), captainChatId: null }); },
    activate(id: string) { return write({ action: 'activate', workflowId: id, manifestDigest: service.detail(id).activationDigest }); },
    reopen() { store.close(); controls.failCommit = false; store = new WorkflowStore(directory); service = new WorkflowService(store, { enabled: () => controls.enabled }); },
    cleanup() { store.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
