import { expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkflowArtifact, WorkflowOverview, WorkflowMutation, WorkflowMutationResult, WorkflowPlan, WorkflowPlanTask } from '../../../common/workflows.js';
import { WORKFLOW_MUTATION_PATHS, type WorkflowBootstrap } from '../../../common/workflow-http.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { runGit } from '../../../server/runtime/git/run.js';
type WorkflowDetail = WorkflowOverview & { artifacts: WorkflowArtifact[] };

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`workflow commands, exact manual gate and restart through production composition: ${executionBackend}`, async () => {
    await withIntegrationFixture(`workflows-${executionBackend}`, async fixture => {
      const projectPath = join(fixture.executionDirs.project, 'repository');
      await mkdir(projectPath);
      await runGit(projectPath, ['init', '-b', 'main']);
      await runGit(projectPath, ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid',
        'commit', '--allow-empty', '-m', 'Synthetic root']);
      const baseCommit = (await runGit(projectPath, ['rev-parse', 'HEAD'])).stdout.trim();
      const worktreeRoot = join(fixture.executionDirs.project, 'managed');
      await mkdir(worktreeRoot);
      const target = { executorId: fixture.client.executorId, projectPath, repositoryId: 'synthetic-repository',
        baseCommit, worktreeRoot, inputTaskId: null, remote: null };
      const retry = { maxAttempts: 1, backoffMs: 1000, repeatableFailure: false };
      const check = (id: string, dependsOn: string[], command = 'printf "Synthetic verification\\n"'): WorkflowPlanTask => ({
        id, title: id, dependsOn, retry, acceptance: [], spec: { kind: 'command', target, command,
          shellModel: 'bash', timeoutMs: 30_000, expectedExitCode: 0, outputRequirement: 'full-log' },
      });
      const plan: WorkflowPlan = { title: 'Synthetic delivery', goal: { kind: 'artifacts', taskIds: ['release'] },
        policy: { concurrency: 2, allowRemoteWrites: false }, tasks: [check('check', []),
          { id: 'gate', title: 'Exact approval', dependsOn: ['check'], retry, acceptance: [],
            spec: { kind: 'approval', purpose: 'manual', requirements: ['check'] } }, check('release', ['gate'])] };
      await fixture.client.put('/api/v1/workflows/enabled', { enabled: true });
      const bootstrap = await fixture.client.get<WorkflowBootstrap>('/api/v1/workflows/bootstrap');
      const mutate = (mutation: WorkflowMutation) => fixture.client.post<WorkflowMutationResult>(WORKFLOW_MUTATION_PATHS[mutation.action], {
        expectedStoreId: bootstrap.storeId, operationId: crypto.randomUUID(), mutation,
      });
      const created = await mutate({ action: 'create', captainChatId: null, plan });
      const detail = async (): Promise<WorkflowDetail> => ({
        ...await fixture.client.get<WorkflowOverview>(`/api/v1/workflows/detail?id=${created.workflowId}`),
        ...await fixture.client.get<{ artifacts: WorkflowArtifact[] }>(`/api/v1/workflows/artifacts?id=${created.workflowId}`),
      });
      expect((await detail()).tasks).toEqual([]);
      await mutate({ action: 'activate', workflowId: created.workflowId, manifestDigest: (await detail()).activationDigest });
      let current = await waitForWorkflow(detail, value => value.gates.length === 1);
      expect(Object.fromEntries(current.tasks.map(task => [task.id, task.phase])))
        .toEqual({ check: 'succeeded', gate: 'awaiting-approval', release: 'blocked' });
      expect(current.artifacts).toMatchObject([{ kind: 'command', provenance: 'runtime-observed', outcome: 'pass',
        executorId: target.executorId, commandOutcome: { exitCode: 0 } }]);
      const workerId = current.tasks[0]!.attempt!.chatId!;
      const worker = (await fixture.client.listChats()).sessions.find(chat => chat.id === workerId);
      expect(worker).toMatchObject({ presentation: { collection: 'automation', notifications: 'attention-only' } });
      expect(worker?.executorId ?? 'local').toBe(target.executorId);
      const sourceArtifact = current.artifacts[0];
      await fixture.restartGarcon();
      current = await detail();
      expect(current.artifacts[0]).toEqual(sourceArtifact);
      expect(current.gates).toHaveLength(1);
      const gate = current.gates[0]!;
      await mutate({ action: 'approve', workflowId: created.workflowId, gateId: 'gate', manifestDigest: gate.digest, decision: 'approve' });
      current = await waitForWorkflow(detail, value => value.outcome === 'succeeded');
      expect(current.tasks.map(task => task.phase)).toEqual(['succeeded', 'succeeded', 'succeeded']);
      expect(current.artifacts).toHaveLength(2);
      expect(new Set(current.tasks.flatMap(task => task.attempt?.chatId ? [task.attempt.chatId] : [])).size).toBe(2);
      expect((await runGit(projectPath, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(baseCommit);
      await fixture.client.put('/api/v1/workflows/enabled', { enabled: false });
      expect((await detail()).outcome).toBe('succeeded');
    }, { executionBackend, projectRoots: 'separate' });
  }, 120_000);
}

async function waitForWorkflow(read: () => Promise<WorkflowDetail>, predicate: (detail: WorkflowDetail) => boolean): Promise<WorkflowDetail> {
  const deadline = Date.now() + 30_000;
  let detail = await read();
  while (!predicate(detail) && Date.now() < deadline) { await Bun.sleep(50); detail = await read(); }
  expect(predicate(detail)).toBe(true);
  return detail;
}
