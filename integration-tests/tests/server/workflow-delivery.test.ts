import { expect, test } from 'bun:test';
import { chmod, copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { WorkflowAgentSelection, WorkflowArtifact, WorkflowAttemptInspection, WorkflowOverview, WorkflowMutation, WorkflowMutationResult, WorkflowPlan, WorkflowPlanTask } from '../../../common/workflows.js';
import { WORKFLOW_MUTATION_PATHS, type WorkflowBootstrap } from '../../../common/workflow-http.js';
import { runGit } from '../../../server/runtime/git/run.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { startScriptedClaudeTestEnvironment } from '../../support/scripted-claude.js';
import { startScriptedCodexTestEnvironment } from '../../support/scripted-codex.js';
import { claudeText, claudeToolUse } from '../../support/fake-claude-model.js';
import { codexAssistantMessage, codexExecCommandCall } from '../../support/fake-codex-model.js';
type WorkflowDetail = WorkflowOverview & { artifacts: WorkflowArtifact[] };

for (const executionBackend of ['remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`CSV delivery uses Claude Local, Codex remote, exact integration and one approved PR: ${executionBackend}`, async () => {
    const claude = await startScriptedClaudeTestEnvironment();
    const codex = await startScriptedCodexTestEnvironment();
    const commit = (file: string, text: string) => `printf '%s\\n' '${text}' > ${file} && git add ${file} && git -c user.name=Synthetic -c user.email=synthetic@example.invalid commit -m 'Synthetic ${file}'`;
    claude.model.scriptTurn([claudeToolUse('synthetic_ui', 'Bash', { command: commit('export-control.js', 'export const exportLabel = "Export CSV";') })]);
    claude.model.scriptTurn([claudeText('Synthetic export control committed.')]);
    claude.model.scriptTurn(request => {
      const sha = /Review input commit: ([a-f0-9]{40})/.exec(request.lastUserText)?.[1];
      if (!sha) throw new Error('Review lacks exact input identity.');
      return [claudeText(JSON.stringify({ commit: sha, decision: 'accept', summary: 'Synthetic exact-head review accepted.' }))];
    });
    codex.model.scriptTurn([codexExecCommandCall('synthetic_endpoint', commit('orders-csv.js', 'export const csv = (rows, allowed) => { if (!allowed) throw new Error("denied"); return rows.map(row => row.join(",")).join("\\n"); };'))]);
    codex.model.scriptTurn([codexAssistantMessage('Synthetic access-controlled CSV endpoint committed.')]);
    let remote = '';
    try {
      await withIntegrationFixture(`workflow-delivery-${executionBackend}`, async fixture => {
        const localProject = join(fixture.dirs.project, 'repository');
        const remoteProject = join(fixture.executionDirs.project, 'repository');
        await mkdir(localProject); await mkdir(remoteProject);
        await runGit(localProject, ['init', '-b', 'main']);
        await runGit(localProject, ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '--allow-empty', '-m', 'Synthetic root']);
        const baseCommit = (await runGit(localProject, ['rev-parse', 'HEAD'])).stdout.trim();
        await runGit(remoteProject, ['clone', localProject, '.']);
        await runGit(fixture.dirs.root, ['clone', '--bare', localProject, remote]);
        const remoteUrl = 'ssh://git@git.example.invalid/synthetic/repository.git';
        await runGit(localProject, ['remote', 'add', 'origin', remoteUrl]);
        await runGit(remoteProject, ['remote', 'set-url', 'origin', remoteUrl]);
        const localRoot = join(fixture.dirs.project, 'managed');
        const remoteRoot = join(fixture.executionDirs.project, 'managed');
        await mkdir(localRoot); await mkdir(remoteRoot);
        const target = { executorId: 'local', projectPath: localProject, repositoryId: 'synthetic-repository', baseCommit,
          worktreeRoot: localRoot, inputTaskId: null, remote: { name: 'origin', url: remoteUrl } };
        const selection = (agentId: 'claude' | 'codex'): WorkflowAgentSelection => ({ agentId,
          model: agentId === 'claude' ? 'haiku' : 'integration-codex-model', apiProviderId: null, modelEndpointId: null,
          modelProtocol: null, providerRevision: null, permissionMode: 'bypassPermissions', thinkingMode: 'low',
          agentSettings: { ownerId: agentId, schemaVersion: 1, values: {} }, preambles: [] });
        const retry = { maxAttempts: 1, backoffMs: 1000, repeatableFailure: false };
        const task = (id: string, dependsOn: string[], spec: WorkflowPlanTask['spec']): WorkflowPlanTask =>
          ({ id, title: id, dependsOn, retry, acceptance: [], spec });
        const integrated = { ...target, inputTaskId: 'integrate' };
        const plan: WorkflowPlan = { title: 'Synthetic orders CSV delivery', goal: { kind: 'pr-open', taskIds: ['publish'] },
          policy: { concurrency: 2, allowRemoteWrites: true }, tasks: [
            task('control', [], { kind: 'agent', target, selection: selection('claude'), prompt: 'Implement the synthetic export control.', outputs: ['commit', 'summary'] }),
            task('endpoint', [], { kind: 'agent', target: { ...target, executorId: fixture.client.executorId, projectPath: remoteProject, worktreeRoot: remoteRoot },
              selection: selection('codex'), prompt: 'Implement the synthetic CSV endpoint with access control.', outputs: ['commit', 'summary'] }),
            task('integrate', ['control', 'endpoint'], { kind: 'integrate', target, strategy: 'ordered-merge', inputs: ['endpoint', 'control'] }),
            task('checks', ['integrate'], { kind: 'command', target: integrated, shellModel: 'bash', timeoutMs: 30_000,
              command: `bun -e 'import { csv } from "./orders-csv.js"; import { exportLabel } from "./export-control.js"; if (csv([["id", "total"], [1, 2]], true) !== "id,total\\n1,2" || exportLabel !== "Export CSV") process.exit(1); try { csv([], false); process.exit(1); } catch (e) { if (e.message !== "denied") throw e; } console.log("Synthetic access control and CSV checks passed");'`,
              expectedExitCode: 0, outputRequirement: 'full-log' }),
            task('review', ['integrate'], { kind: 'agent', target: integrated, selection: selection('claude'), prompt: 'Review synthetic CSV access control.', outputs: ['review'] }),
            task('approve', ['integrate', 'checks', 'review'], { kind: 'approval', purpose: 'publication', requirements: ['integrate', 'checks', 'review'] }),
            { ...task('publish', ['integrate', 'checks', 'review', 'approve'], { kind: 'publish-pr', target,
              sourceTaskId: 'integrate', approvalTaskId: 'approve', baseBranch: 'main', headBranch: 'garcon/synthetic-delivery',
              title: 'Synthetic CSV export', body: 'Synthetic access-controlled CSV export with checks and review.', draft: false }),
              acceptance: [{ kind: 'independent-review', taskId: 'review' }] },
          ] };
        await fixture.client.put('/api/v1/workflows/enabled', { enabled: true });
        const bootstrap = await fixture.client.get<WorkflowBootstrap>('/api/v1/workflows/bootstrap');
        const mutate = (mutation: WorkflowMutation) => fixture.client.post<WorkflowMutationResult>(WORKFLOW_MUTATION_PATHS[mutation.action],
          { expectedStoreId: bootstrap.storeId, operationId: crypto.randomUUID(), mutation });
        const created = await mutate({ action: 'create', captainChatId: null, plan });
        const detail = async (): Promise<WorkflowDetail> => ({
          ...await fixture.client.get<WorkflowOverview>(`/api/v1/workflows/detail?id=${created.workflowId}`),
          ...await fixture.client.get<{ artifacts: WorkflowArtifact[] }>(`/api/v1/workflows/artifacts?id=${created.workflowId}`),
        });
        await mutate({ action: 'activate', workflowId: created.workflowId, manifestDigest: (await detail()).activationDigest });
        let current = await waitFor(detail, value => value.gates.some(gate => gate.manifest.gateId === 'approve'));
        const gate = current.gates.find(gate => gate.manifest.gateId === 'approve')!;
        expect(current.tasks.filter(task => ['checks', 'review', 'integrate'].includes(task.id)).map(task => task.phase))
          .toEqual(['succeeded', 'succeeded', 'succeeded']);
        expect(current.artifacts.find(artifact => artifact.kind === 'command')).toMatchObject({ outcome: 'pass', commandOutcome: { exitCode: 0 }, receivedOutputCoverage: 'complete' });
        expect(current.artifacts.find(artifact => artifact.kind === 'review')).toMatchObject({ outcome: 'pass', provenance: 'agent-asserted' });
        expect(await Bun.file(join(remote, 'publications.json')).exists()).toBe(false);
        await mutate({ action: 'approve', workflowId: created.workflowId, gateId: 'approve', manifestDigest: gate.digest, decision: 'approve' });
        current = await waitFor(detail, value => value.outcome === 'succeeded');
        const publication = current.artifacts.find(artifact => artifact.kind === 'pull-request')!;
        expect(publication).toMatchObject({ outcome: 'pass', provenance: 'runtime-observed', commit: gate.manifest.publication!.headCommit });
        expect(JSON.parse(await readFile(join(remote, 'publications.json'), 'utf8'))).toHaveLength(1);
        const calls = (await readFile(join(remote, 'gh-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
        expect(calls.filter(args => args.includes('POST'))).toHaveLength(1);
        const inspect = (taskId: string) => fixture.client.get<WorkflowAttemptInspection>(`/api/v1/workflows/attempt?id=${created.workflowId}&attemptId=${current.tasks.find(task => task.id === taskId)!.attempt!.attemptId}`);
        expect((await inspect('integrate')).operations.filter(operation => operation.kind === 'transfer')).toHaveLength(2);
        expect((await inspect('endpoint')).attempt.target!.executorId).toBe(fixture.client.executorId);
        expect((await inspect('control')).attempt.target!.executorId).toBe('local');
        expect((await runGit(localProject, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(baseCommit);
        expect((await runGit(remoteProject, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(baseCommit);
        claude.model.assertSettled(); codex.model.assertSettled();
      }, { executionBackend, projectRoots: 'separate',
        serverEnvironment: { ...claude.serverEnvironment, ...codex.serverEnvironment, GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid',
          GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid' },
        resolveServerEnvironment(dirs) {
          remote = join(dirs.root, 'remote.git');
          return { PATH: `${join(dirs.root, 'bin')}:${dirname(process.execPath)}:${codex.serverEnvironment.PATH}`,
            GIT_SSH_COMMAND: join(dirs.root, 'bin', 'workflow-ssh'), GIT_SSH_VARIANT: 'ssh', WORKFLOW_TEST_REMOTE: remote };
        },
        prepareControllerWorkspace: dirs => codex.prepareWorkspace(dirs),
        async prepareWorkspace(dirs) {
          await codex.prepareWorkspace(dirs);
          const bin = join(dirs.root, 'bin'); await mkdir(bin);
          for (const [source, name] of [['workflow-gh.js', 'gh'], ['workflow-ssh.js', 'workflow-ssh']]) {
            const destination = join(bin, name!);
            await copyFile(new URL(`../../support/fixtures/${source}`, import.meta.url), destination); await chmod(destination, 0o755);
          }
        },
      });
    } finally { claude.dispose(); await codex.dispose(); }
  }, 180_000);
}

async function waitFor(read: () => Promise<WorkflowDetail>, ready: (value: WorkflowDetail) => boolean) {
  const deadline = Date.now() + 90_000;
  let current = await read();
  while (!ready(current) && !current.tasks.some(task => ['failed', 'outcome-unknown', 'interrupted'].includes(task.phase)) && Date.now() < deadline) {
    await Bun.sleep(100); current = await read();
  }
  expect(current.tasks.map(task => ({ id: task.id, phase: task.phase, reason: task.blockedReason,
    result: task.attempt?.result }))).not.toContainEqual(expect.objectContaining({ phase: 'failed' }));
  expect(ready(current)).toBe(true);
  return current;
}
