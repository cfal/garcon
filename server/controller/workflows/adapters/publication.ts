import type { ExecutionRuntimeApi } from '@garcon/server-agent-interface';
import type { GhPublicationRequest } from '../../../../common/gh.js';
import { matchesPublication, sameGhRepository } from '../../../../common/gh-identity.js';
import { GIT_OPERATION_TIMEOUT_MS } from '../../../../common/git-execution.js';
import { GitServiceError } from '../../../../common/git-error.js';
import type { WorkflowPublication, WorkflowPublicationEffect, WorkflowPublicationPort } from '../publication-contracts.js';
import { workflowPublicationMarker } from '../publication-manifest.js';
import { definitelyNotDispatched } from './repository-runtime.js';

export function createWorkflowPublicationPort(resolve: (id: string) => Promise<Pick<ExecutionRuntimeApi, 'getGitService' | 'getGhService'>>): WorkflowPublicationPort {
  return {
    async inspectTarget(spec, signal) {
      const gh = await (await resolve(spec.target.executorId)).getGhService({ signal });
      if (!spec.target.remote) throw new Error('Publication remote is absent.');
      return gh.getPublicationTarget({ projectPath: spec.target.projectPath, remote: spec.target.remote.name,
        expectedRemoteUrl: spec.target.remote.url, baseBranch: spec.baseBranch }, { signal, timeoutMs: GIT_OPERATION_TIMEOUT_MS });
    },
    async prepare(publication, resource, signal) {
      const runtime = await resolve(publication.executorId);
      const git = await runtime.getGitService({ signal });
      const gh = await runtime.getGhService({ signal });
      const remote = resource.target.remote;
      if (!remote || remote.url !== publication.remoteUrl) throw new Error('Publication remote changed.');
      const target = { projectPath: publication.projectPath, remote: remote.name, expectedRemoteUrl: remote.url, baseBranch: publication.baseBranch };
      const request: GhPublicationRequest = { ...target, repository: publication.repository, actor: publication.actor,
        baseCommit: publication.baseCommit, headBranch: publication.headBranch, headCommit: publication.headCommit,
        title: publication.title, body: publication.body, draft: publication.draft, marker: workflowPublicationMarker(publication.operationId) };
      const options = { signal, timeoutMs: GIT_OPERATION_TIMEOUT_MS, instanceId: publication.runtimeInstanceId };
      return {
        async verify(readSignal) {
          const observed = await gh.getPublicationTarget(target, { ...options, signal: readSignal });
          assertScope(observed, publication);
          if (!sameGhRepository(observed.repository, publication.repository) || observed.actor.id !== publication.actor.id
            || observed.actor.login !== publication.actor.login || observed.baseCommit !== publication.baseCommit) {
            throw new Error('Publication actor, repository or base changed after approval.');
          }
        },
        push: () => effect(async () => {
          const result = await git.pushExactRef({ projectPath: resource.sourceProjectPath, remote: remote.name,
            expectedRemoteUrl: remote.url, ref: `refs/heads/${publication.headBranch}`, commit: publication.headCommit,
            expectedRemoteCommit: null }, options);
          assertScope(result, publication);
          if (!result.success || result.ref !== `refs/heads/${publication.headBranch}` || result.commit !== publication.headCommit)
            throw new Error('Publication push identity changed.');
        }),
        create: () => effect(async () => {
          const result = await gh.createPullRequest(request, options);
          assertScope(result, publication);
          if (!matchesPublication(result, publication)) throw new Error('Publication response changed.');
          return result;
        }),
      };
    },
    async find(publication, signal) {
      const gh = await (await resolve(publication.executorId)).getGhService({ signal });
      const result = await gh.findPullRequests({ projectPath: publication.projectPath, repository: publication.repository, actor: publication.actor,
        headBranch: publication.headBranch, baseBranch: publication.baseBranch, marker: workflowPublicationMarker(publication.operationId) },
        { signal, timeoutMs: GIT_OPERATION_TIMEOUT_MS, instanceId: publication.runtimeInstanceId });
      assertScope(result, publication);
      return result;
    },
  };
}

export async function findRecoveredWorkflowPublication(resolve: (id: string) => Promise<Pick<ExecutionRuntimeApi, 'getGhService'>>,
  publication: WorkflowPublication, remote: string, signal: AbortSignal) {
  const gh = await (await resolve(publication.executorId)).getGhService({ signal });
  const target = await gh.getPublicationTarget({ projectPath: publication.projectPath, remote,
    expectedRemoteUrl: publication.remoteUrl, baseBranch: publication.baseBranch }, { signal, timeoutMs: GIT_OPERATION_TIMEOUT_MS });
  if (target.executorId !== publication.executorId || !sameGhRepository(target.repository, publication.repository)
    || target.actor.id !== publication.actor.id || target.actor.login !== publication.actor.login) throw new Error('Publication recovery target changed.');
  const found = await gh.findPullRequests({ projectPath: publication.projectPath, repository: publication.repository, actor: publication.actor,
    headBranch: publication.headBranch, baseBranch: publication.baseBranch, marker: workflowPublicationMarker(publication.operationId) },
    { signal, timeoutMs: GIT_OPERATION_TIMEOUT_MS, instanceId: target.instanceId });
  if (found.executorId !== target.executorId || found.instanceId !== target.instanceId) throw new Error('Publication recovery runtime changed.');
  return found;
}

function assertScope(value: { executorId: string; instanceId: string }, publication: WorkflowPublication): void {
  if (value.executorId !== publication.executorId || value.instanceId !== publication.runtimeInstanceId)
    throw new Error('Publication runtime changed.');
}

async function effect<T>(run: () => Promise<T>): Promise<WorkflowPublicationEffect<T>> {
  try { return { kind: 'observed', value: await run() }; }
  catch (error) {
    const notStarted = definitelyNotDispatched(error) || error instanceof GitServiceError && error.code === 'GH_MUTATION_REJECTED';
    return { kind: notStarted ? 'not-started' : 'unknown', detail: notStarted
      ? 'Publication effect was rejected before dispatch.' : 'Publication may have executed; it will not be repeated.' };
  }
}
