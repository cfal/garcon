import { access, readdir } from 'node:fs/promises';
import { describe, expect, it, mock } from 'bun:test';
import {
  AGENT_UNSUPPORTED_SINGLE_QUERY_THINKING_MODE,
  AgentIntegrationError,
} from '@garcon/server-agent-interface';
import {
  DEFAULT_PROMPT_REFINEMENT_PROMPT,
  PROMPT_REFINEMENT_USER_PROMPT_TOKEN,
} from '../../../common/generation-prompts.js';
import {
  PROMPT_REFINEMENT_DRAFT_MAX_LENGTH,
  PROMPT_REFINEMENT_OUTPUT_MAX_LENGTH,
} from '../../../common/prompt-refinement.js';
import { PromptRefinementError, refinePrompt } from '../refine-prompt.js';

function harness(overrides = {}) {
  const config = {
    agentId: 'claude',
    model: 'opus',
    thinkingMode: 'high',
    ...(overrides.config ?? {}),
  };
  const settings = {
    getUiSettings: mock(() => ({ promptRefinement: config })),
  };
  const agents = {
    getAgentAuthStatusMap: mock(() => Promise.resolve({})),
    getAgentReadinessMap: mock(() => Promise.resolve({})),
    getAgentCatalogEntries: mock(() => Promise.resolve([])),
    getModels: mock(() => Promise.resolve([])),
    singleQueryRunsToolsWithoutPermission: mock(() => false),
    runSingleQuery: mock(() => Promise.resolve('  Refined prompt.  ')),
  };
  const log = {
    info: mock(() => undefined),
    warn: mock(() => undefined),
  };
  return { settings, agents, log, config };
}

describe('refinePrompt', () => {
  it('renders the default template exactly and uses a cleaned empty directory', async () => {
    const test = harness();
    const draft = 'Keep $& and $1 exactly.';
    let temporaryDirectory;
    test.agents.runSingleQuery.mockImplementationOnce(async (prompt, options) => {
      temporaryDirectory = options.cwd;
      expect(prompt).toBe(
        DEFAULT_PROMPT_REFINEMENT_PROMPT.replaceAll(
          PROMPT_REFINEMENT_USER_PROMPT_TOKEN,
          () => draft,
        ),
      );
      expect(await readdir(options.cwd)).toEqual([]);
      expect(options.projectPath).toBe(options.cwd);
      expect(options).toMatchObject({
        agentId: 'claude',
        model: 'opus',
        thinkingMode: 'high',
        permissionMode: 'plan',
        timeoutMs: 110_000,
      });
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return '  Refined prompt.  ';
    });

    await expect(refinePrompt({ draft }, test)).resolves.toEqual({
      success: true,
      refinedPrompt: 'Refined prompt.',
    });
    await expect(access(temporaryDirectory)).rejects.toThrow();
    expect(test.log.info).toHaveBeenCalledWith(
      'prompt refinement completed',
      expect.objectContaining({ outcome: 'success', agentId: 'claude', model: 'opus' }),
    );
  });

  it('replaces every token in a custom template without replacement-string expansion', async () => {
    const test = harness({
      config: {
        customPrompt: 'First: {{USER_PROMPT}}\nSecond: {{USER_PROMPT}}',
      },
    });
    test.agents.runSingleQuery.mockImplementationOnce(async (prompt) => {
      expect(prompt).toBe('First: $& $1\nSecond: $& $1');
      return 'Done';
    });

    await refinePrompt({ draft: '$& $1' }, test);
  });

  it('rejects invalid input before settings or model discovery', async () => {
    for (const draft of ['   ', 'x'.repeat(PROMPT_REFINEMENT_DRAFT_MAX_LENGTH + 1)]) {
      const test = harness();
      await expect(refinePrompt({ draft }, test)).rejects.toMatchObject({
        code: 'PROMPT_REFINEMENT_INVALID_REQUEST',
        status: 400,
      });
      expect(test.settings.getUiSettings).not.toHaveBeenCalled();
      expect(test.agents.runSingleQuery).not.toHaveBeenCalled();
    }
  });

  it('rejects unsafe agents before reading or rendering the custom template', async () => {
    const test = harness({ config: { customPrompt: 42 } });
    test.agents.singleQueryRunsToolsWithoutPermission.mockImplementationOnce(() => true);

    await expect(refinePrompt({ draft: 'private draft' }, test)).rejects.toMatchObject({
      code: 'PROMPT_REFINEMENT_UNSAFE_AGENT',
      status: 422,
    });
    expect(test.agents.runSingleQuery).not.toHaveBeenCalled();
  });

  it('rejects corrupt and amplifying saved templates', async () => {
    const invalidTemplates = [
      42,
      'No user prompt token',
      '{{USER_PROMPT}}'.repeat(9),
    ];
    for (const customPrompt of invalidTemplates) {
      const test = harness({ config: { customPrompt } });
      const draft = customPrompt === invalidTemplates[2]
        ? 'x'.repeat(PROMPT_REFINEMENT_DRAFT_MAX_LENGTH)
        : 'draft';
      await expect(refinePrompt({ draft }, test)).rejects.toMatchObject({
        code: 'PROMPT_REFINEMENT_INVALID_TEMPLATE',
        status: 409,
      });
      expect(test.agents.runSingleQuery).not.toHaveBeenCalled();
    }
  });

  it('classifies empty, oversized, unsupported-effort, timeout, and provider failures', async () => {
    const cases = [
      {
        failure: '',
        code: 'PROMPT_REFINEMENT_EMPTY_RESPONSE',
        status: 502,
      },
      {
        failure: 'x'.repeat(PROMPT_REFINEMENT_OUTPUT_MAX_LENGTH + 1),
        code: 'PROMPT_REFINEMENT_OUTPUT_TOO_LARGE',
        status: 502,
      },
      {
        failure: new AgentIntegrationError(
          'OPERATION_UNSUPPORTED',
          'secret effort detail',
          false,
          AGENT_UNSUPPORTED_SINGLE_QUERY_THINKING_MODE,
        ),
        code: 'PROMPT_REFINEMENT_UNSUPPORTED_EFFORT',
        status: 422,
      },
      {
        failure: new DOMException('secret timeout detail', 'TimeoutError'),
        code: 'PROMPT_REFINEMENT_TIMEOUT',
        status: 504,
      },
      {
        failure: new Error('secret provider detail'),
        code: 'PROMPT_REFINEMENT_FAILED',
        status: 502,
      },
    ];

    for (const testCase of cases) {
      const test = harness();
      test.agents.runSingleQuery.mockImplementationOnce(() => {
        if (typeof testCase.failure === 'string') return Promise.resolve(testCase.failure);
        return Promise.reject(testCase.failure);
      });

      try {
        await refinePrompt({ draft: 'private sentinel' }, test);
        throw new Error('Expected prompt refinement to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(PromptRefinementError);
        expect(error).toMatchObject({ code: testCase.code, status: testCase.status });
        expect(error.message).not.toContain('secret');
      }
    }
  });

  it('propagates caller cancellation, cleans up, and logs metadata only', async () => {
    const test = harness({
      config: { customPrompt: 'private template {{USER_PROMPT}}' },
    });
    const controller = new AbortController();
    const reason = new DOMException('private cancellation detail', 'AbortError');
    let temporaryDirectory;
    test.agents.runSingleQuery.mockImplementationOnce((_prompt, options) => {
      temporaryDirectory = options.cwd;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    });

    const running = refinePrompt({ draft: 'private draft sentinel' }, test, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(reason);
    await expect(running).rejects.toBe(reason);
    await expect(access(temporaryDirectory)).rejects.toThrow();
    expect(test.log.info).not.toHaveBeenCalled();

    const serializedLogs = JSON.stringify([
      test.log.info.mock.calls,
      test.log.warn.mock.calls,
    ]);
    expect(serializedLogs).not.toContain('private draft sentinel');
    expect(serializedLogs).not.toContain('private template');
    expect(serializedLogs).not.toContain('private cancellation detail');
  });
});
