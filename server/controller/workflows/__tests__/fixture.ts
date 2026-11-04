import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowMutation, WorkflowPlan } from '../../../../common/workflows.js';
import type { WorkflowAuthority } from '../contracts.js';
import { WorkflowService } from '../service.js';
import { WorkflowStore } from '../store.js';

export const browser: WorkflowAuthority = { key: 'browser:synthetic', browserSession: true, assertCurrent() {} };
export const local: WorkflowAuthority = { key: 'local', browserSession: false, assertCurrent() {} };
export const commit = 'a'.repeat(40);
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
