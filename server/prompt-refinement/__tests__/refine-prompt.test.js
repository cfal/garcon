import { access, readdir } from 'node:fs/promises';
import { describe, expect, it, mock } from 'bun:test';
import {
  AGENT_UNSUPPORTED_SINGLE_QUERY_THINKING_MODE,
  AgentIntegrationError,
} from '@garcon/server-agent-interface';
import {
  DEFAULT_PROMPT_REFINEMENT_PROMPT,
  GENERATION_PROMPT_TEMPLATE_MAX_LENGTH,
  PROMPT_REFINEMENT_USER_PROMPT_TOKEN,
} from '../../../common/generation-prompts.js';
import {
  PROMPT_REFINEMENT_DRAFT_MAX_LENGTH,
  PROMPT_REFINEMENT_OUTPUT_MAX_LENGTH,
} from '../../../common/prompt-refinement.js';
import { SNIPPET_TEMPLATE_MAX_LENGTH } from '../../../common/snippets.js';
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

    await expect(refinePrompt({ draft, target: 'prompt' }, test)).resolves.toEqual({
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

    await refinePrompt({ draft: '$& $1', target: 'prompt' }, test);
  });

  it('adds fixed snippet constraints and accepts an unchanged token signature', async () => {
    const test = harness();
    const draft = '{{arguments}} at \\{{project_path}} for {{chat_id}} and {{arguments}}';
    test.agents.runSingleQuery.mockImplementationOnce(async (prompt) => {
      expect(prompt).toContain(draft);
      expect(prompt).toContain('Preserve every supported template token verbatim');
      expect(prompt).toContain('\\{{arguments}}, \\{{project_path}}, and \\{{chat_id}}');
      return 'Review {{arguments}} in \\{{project_path}} for {{chat_id}}, then {{arguments}}.';
    });

    await expect(
      refinePrompt({ draft, target: 'snippet-template' }, test),
    ).resolves.toEqual({
      success: true,
      refinedPrompt:
        'Review {{arguments}} in \\{{project_path}} for {{chat_id}}, then {{arguments}}.',
    });
  });

  it('rejects snippet outputs that alter token identity, order, count, or escaping', async () => {
    const draft = '{{arguments}} \\{{project_path}} {{chat_id}} {{arguments}}';
    const changedOutputs = [
      '{{arguments}} \\{{project_path}} {{chat_id}}',
      '{{chat_id}} \\{{project_path}} {{arguments}} {{arguments}}',
      '{{arguments}} {{project_path}} {{chat_id}} {{arguments}}',
      '{{arguments}} \\{{project_path}} {{chat_id}} {{arguments}} {{chat_id}}',
    ];

    for (const output of changedOutputs) {
      const test = harness();
      test.agents.runSingleQuery.mockResolvedValueOnce(output);
      await expect(
        refinePrompt({ draft, target: 'snippet-template' }, test),
      ).rejects.toMatchObject({
        code: 'PROMPT_REFINEMENT_TOKEN_SIGNATURE_CHANGED',
        status: 502,
        retryable: true,
      });
    }
  });

  it('rejects invalid input before settings or model discovery', async () => {
    const blank = harness();
    await expect(refinePrompt({ draft: '   ', target: 'prompt' }, blank)).rejects.toMatchObject({
      code: 'PROMPT_REFINEMENT_INVALID_REQUEST',
      status: 400,
    });
    expect(blank.settings.getUiSettings).not.toHaveBeenCalled();

    const oversized = harness();
    await expect(
      refinePrompt(
        {
          draft: 'x'.repeat(PROMPT_REFINEMENT_DRAFT_MAX_LENGTH + 1),
          target: 'prompt',
        },
        oversized,
      ),
    ).rejects.toMatchObject({
      code: 'PROMPT_REFINEMENT_INPUT_TOO_LONG',
      status: 413,
    });
    expect(oversized.settings.getUiSettings).not.toHaveBeenCalled();
    expect(oversized.agents.runSingleQuery).not.toHaveBeenCalled();

    const oversizedSnippet = harness();
    await expect(
      refinePrompt(
        {
          draft: 'x'.repeat(SNIPPET_TEMPLATE_MAX_LENGTH + 1),
          target: 'snippet-template',
        },
        oversizedSnippet,
      ),
    ).rejects.toMatchObject({
      code: 'PROMPT_REFINEMENT_INPUT_TOO_LONG',
      status: 413,
    });
    expect(oversizedSnippet.settings.getUiSettings).not.toHaveBeenCalled();
  });

  it('rejects unsafe agents before reading or rendering the custom template', async () => {
    const test = harness({ config: { customPrompt: 42 } });
    test.agents.singleQueryRunsToolsWithoutPermission.mockImplementationOnce(() => true);

    await expect(
      refinePrompt({ draft: 'private draft', target: 'prompt' }, test),
    ).rejects.toMatchObject({
      code: 'PROMPT_REFINEMENT_UNSAFE_AGENT',
      status: 422,
    });
    expect(test.agents.runSingleQuery).not.toHaveBeenCalled();
  });

  it('rejects corrupt and over-expanded saved templates before provider invocation', async () => {
    const cases = [
      { customPrompt: 42, draft: 'draft' },
      { customPrompt: 'No user prompt token', draft: 'draft' },
      {
        customPrompt: '{{USER_PROMPT}}'.repeat(9),
        draft: 'x'.repeat(PROMPT_REFINEMENT_DRAFT_MAX_LENGTH),
      },
      {
        customPrompt: PROMPT_REFINEMENT_USER_PROMPT_TOKEN.repeat(
          Math.floor(
            GENERATION_PROMPT_TEMPLATE_MAX_LENGTH / PROMPT_REFINEMENT_USER_PROMPT_TOKEN.length,
          ),
        ),
        draft: 'x'.repeat(1_024),
      },
    ];
    for (const { customPrompt, draft } of cases) {
      const test = harness({ config: { customPrompt } });
      await expect(refinePrompt({ draft, target: 'prompt' }, test)).rejects.toMatchObject({
        code: 'PROMPT_REFINEMENT_TEMPLATE_INVALID',
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
        retryable: true,
      },
      {
        failure: 'x'.repeat(PROMPT_REFINEMENT_OUTPUT_MAX_LENGTH + 1),
        code: 'PROMPT_REFINEMENT_OUTPUT_TOO_LONG',
        status: 502,
        retryable: true,
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
        retryable: false,
      },
      {
        failure: new AgentIntegrationError('AUTH_REQUIRED', 'secret auth detail', false),
        code: 'PROMPT_REFINEMENT_AUTH_REQUIRED',
        status: 401,
        retryable: false,
      },
      {
        failure: new AgentIntegrationError('RATE_LIMITED', 'secret rate detail', true),
        code: 'PROMPT_REFINEMENT_RATE_LIMITED',
        status: 429,
        retryable: true,
      },
      {
        failure: new AgentIntegrationError('BINARY_NOT_FOUND', 'secret binary detail', false),
        code: 'PROMPT_REFINEMENT_AGENT_UNAVAILABLE',
        status: 503,
        retryable: false,
      },
      {
        failure: new AgentIntegrationError('UNAVAILABLE', 'secret unavailable detail', true),
        code: 'PROMPT_REFINEMENT_AGENT_UNAVAILABLE',
        status: 503,
        retryable: true,
      },
      {
        failure: new AgentIntegrationError('TIMEOUT', 'secret provider timeout detail', true),
        code: 'PROMPT_REFINEMENT_TIMEOUT',
        status: 504,
        retryable: true,
      },
      {
        failure: new DOMException('secret timeout detail', 'TimeoutError'),
        code: 'PROMPT_REFINEMENT_TIMEOUT',
        status: 504,
        retryable: true,
      },
      {
        failure: new Error('secret provider detail'),
        code: 'PROMPT_REFINEMENT_FAILED',
        status: 502,
        retryable: true,
      },
    ];

    for (const testCase of cases) {
      const test = harness();
      test.agents.runSingleQuery.mockImplementationOnce(() => {
        if (typeof testCase.failure === 'string') return Promise.resolve(testCase.failure);
        return Promise.reject(testCase.failure);
      });

      try {
        await refinePrompt({ draft: 'private sentinel', target: 'prompt' }, test);
        throw new Error('Expected prompt refinement to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(PromptRefinementError);
        expect(error).toMatchObject({
          code: testCase.code,
          status: testCase.status,
          retryable: testCase.retryable,
        });
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

    const running = refinePrompt(
      { draft: 'private draft sentinel', target: 'prompt' },
      test,
      controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(reason);
    await expect(running).rejects.toBe(reason);
    await expect(access(temporaryDirectory)).rejects.toThrow();
    expect(test.log.info).not.toHaveBeenCalled();
    expect(test.log.warn).not.toHaveBeenCalled();

    const serializedLogs = JSON.stringify([
      test.log.info.mock.calls,
      test.log.warn.mock.calls,
    ]);
    expect(serializedLogs).not.toContain('private draft sentinel');
    expect(serializedLogs).not.toContain('private template');
    expect(serializedLogs).not.toContain('private cancellation detail');
  });
});
