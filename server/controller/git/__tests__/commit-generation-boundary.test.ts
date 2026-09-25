import { expect, test } from 'bun:test';
import { generateCommitMessageForFiles } from '../commit-generation.js';
import { createGitOperations } from '../../../runtime/git/git-service.js';
import type { GitAgentRunner } from '../commit-generation-types.js';
import type { GitOperations } from '../../../runtime/git/types.js';

test('repository context collection is separate from model execution and its executor', async () => {
  const calls: string[] = [];
  const git = {
    async collectCommitMessageContext(request) {
      calls.push('repository');
      expect(request.projectPath).toBe('/worker-only/project');
      expect(request.files).toEqual(['src/example.ts']);
      return { diff: '+synthetic change' };
    },
  } satisfies Pick<GitOperations, 'collectCommitMessageContext'>;
  const agents = {
    async runSingleQuery(prompt, selection) {
      calls.push('model');
      expect(selection.executorId).toBe('model-executor');
      expect(selection).not.toHaveProperty('projectPath');
      expect(prompt).toContain('+synthetic change');
      return 'feat: synthetic change';
    },
  } satisfies GitAgentRunner;
  const result = await generateCommitMessageForFiles(agents, git, {
    projectPath: '/worker-only/project', files: ['src/example.ts'], agentId: 'codex', executorId: 'model-executor',
  });
  expect(result.message).toBe('feat: synthetic change');
  expect(calls).toEqual(['repository', 'model']);
});

test('machine Git operations expose neither HTTP formatting nor model generation', () => {
  const git = createGitOperations();
  expect(Object.keys(git)).toHaveLength(45);
  expect(git).not.toHaveProperty('toHttpError');
  expect(git).not.toHaveProperty('generateCommitMessageForFiles');
});
