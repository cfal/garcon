import { expect, test } from 'bun:test';
import { generateCommitMessageForFiles } from '../commit-generation.js';
import { createGitOperations } from '../git-service.js';
import type { GitAgentRunner, GitOperations } from '../types.js';

test('repository context collection is separate from model execution and its node', async () => {
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
      expect(selection.nodeId).toBe('model-node');
      expect(selection).not.toHaveProperty('projectPath');
      expect(prompt).toContain('+synthetic change');
      return 'feat: synthetic change';
    },
  } satisfies GitAgentRunner;
  const result = await generateCommitMessageForFiles(agents, git, {
    projectPath: '/worker-only/project', files: ['src/example.ts'], agentId: 'codex', nodeId: 'model-node',
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
