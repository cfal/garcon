import { describe, expect, mock, test } from 'bun:test';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import { generateCommitMessageForFiles } from '../commit-message.js';
import { GitDomainError } from '../git-types.js';

const source = Object.freeze({
  projectPath: '/owner/canonical-repository',
  files: Object.freeze(['feature/a.ts', 'feature/b.ts']),
  diffContext: 'synthetic selected staged diff',
});

function fixture(capture = async () => source) {
  /** @satisfies {Pick<import('../../execution-nodes/workspace-git.js').WorkspaceGitService, 'captureCommitMessageSource'>} */
  const git = { captureCommitMessageSource: mock(capture) };
  /** @satisfies {import('../types.js').GitAgentRunner} */
  const agents = { runSingleQuery: mock(async () => 'fix: synthetic change') };
  return { git, agents };
}

describe('controller commit-message coordinator', () => {
  test('captures configuration and file selection before owner IO and generates from canonical source', async () => {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const { git, agents } = fixture(async () => { entered.resolve(); await release.promise; return source; });
    const controller = new AbortController();
    /** @satisfies {import('../types.js').CommitMessageFileOptions} */
    const options = {
      projectPath: '/caller/alias', files: ['feature/a.ts', 'feature/b.ts'], agentId: 'codex',
      model: 'synthetic-model', apiProviderId: 'synthetic-provider', modelEndpointId: 'synthetic-endpoint',
      modelProtocol: 'openai-responses', thinkingMode: 'low', customPrompt: '{{files}}\n{{diff}}',
      useCommonDirPrefix: true, signal: controller.signal,
    };
    const pending = generateCommitMessageForFiles(git, agents, options);
    try {
      await entered.promise;
      options.files[0] = 'not-selected.ts';
      options.projectPath = '/not-selected';
      options.model = 'not-selected-model';
      options.customPrompt = 'not-selected-prompt';
      options.useCommonDirPrefix = false;
      release.resolve();
      expect(await pending).toEqual({ message: 'feature: fix: synthetic change', directoryPrefix: 'feature' });
      expect(git.captureCommitMessageSource).toHaveBeenCalledTimes(1);
      expect(git.captureCommitMessageSource).toHaveBeenCalledWith({
        projectPath: '/caller/alias', files: ['feature/a.ts', 'feature/b.ts'], signal: controller.signal,
      });
      expect(agents.runSingleQuery).toHaveBeenCalledTimes(1);
      expect(agents.runSingleQuery).toHaveBeenCalledWith(
        '- feature/a.ts\n- feature/b.ts\nsynthetic selected staged diff',
        {
          agentId: 'codex', cwd: source.projectPath, model: 'synthetic-model', apiProviderId: 'synthetic-provider',
          modelEndpointId: 'synthetic-endpoint', modelProtocol: 'openai-responses', thinkingMode: 'low',
          timeoutMs: 110_000, signal: controller.signal,
        },
      );
    } finally {
      release.resolve();
      await pending.catch(() => {});
    }
  });

  test('shares cancellation across capture and generation without calling the generator after abort', async () => {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const { git, agents } = fixture(async () => { entered.resolve(); await release.promise; return source; });
    const controller = new AbortController();
    const pending = generateCommitMessageForFiles(git, agents, {
      projectPath: '/caller/alias', files: ['feature/a.ts'], agentId: 'codex', signal: controller.signal,
    });
    try {
      await entered.promise;
      controller.abort();
      release.resolve();
      await expect(pending).rejects.toBe(controller.signal.reason);
      expect(git.captureCommitMessageSource.mock.calls[0][0].signal).toBe(controller.signal);
      expect(agents.runSingleQuery).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await pending.catch(() => {});
    }
  });

  test('does not generate when the owner rejects an empty selected staged source', async () => {
    const refusal = new GitDomainError('COMMIT_MESSAGE_NO_STAGED_FILES', 'No staged changes found for selected files.');
    const { git, agents } = fixture(async () => { throw refusal; });
    await expect(generateCommitMessageForFiles(git, agents, {
      projectPath: '/caller/alias', files: ['feature/a.ts'], agentId: 'codex',
    })).rejects.toBe(refusal);
    expect(agents.runSingleQuery).not.toHaveBeenCalled();
  });

  test('retains the unprefixed result and default thinking policy', async () => {
    const { git, agents } = fixture();
    expect(await generateCommitMessageForFiles(git, agents, {
      projectPath: '/caller/alias', files: ['feature/a.ts'], agentId: 'codex',
    })).toEqual({ message: 'fix: synthetic change', directoryPrefix: '' });
    const options = agents.runSingleQuery.mock.calls[0][1];
    expect(options.thinkingMode).toBe('none');
    expect(options.timeoutMs).toBe(110_000);
    expect(options.signal).toBe(git.captureCommitMessageSource.mock.calls[0][0].signal);
    expect(options).not.toHaveProperty('permissionMode');
  });
  test('preserves provider error classification after owner capture', async () => {
    const { git, agents } = fixture();
    agents.runSingleQuery.mockRejectedValueOnce(new AgentIntegrationError('AUTH_REQUIRED', 'Synthetic login required', false));
    await expect(generateCommitMessageForFiles(git, agents, {
      projectPath: '/caller/alias', files: ['feature/a.ts'], agentId: 'codex',
    })).rejects.toMatchObject({ code: 'COMMIT_MESSAGE_AGENT_AUTH_REQUIRED' });
    expect(git.captureCommitMessageSource).toHaveBeenCalledTimes(1);
  });
});
