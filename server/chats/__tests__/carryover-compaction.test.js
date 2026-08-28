import { describe, expect, it, mock } from 'bun:test';
import {
  MAX_DIRECT_SINGLE_QUERY_TIMEOUT_MS,
} from '@garcon/server-agent-common/direct/single-query-options';
import {
  AssistantMessage,
  BashToolUseMessage,
  TranscriptNoticeMessage,
  UserMessage,
} from '../../../common/chat-types.js';
import {
  CARRYOVER_INJECTION_MAX_CHARS,
  createCarryoverTranscript,
} from '../../../common/transcript-seed.js';
import {
  SMALL_HISTORY_NO_COMPACTION_MAX_ESTIMATED_TOKENS,
  usableHandoffTokenBudget,
} from '../../../common/handoff-sizing.js';
import {
  CARRYOVER_COMPACTION_TIMEOUT_MS,
  CarryOverCompactionService,
} from '../carryover-compaction.ts';
import { estimateHandoffTokens } from '../handoff-token-budget.ts';

const TIME = '2026-01-01T00:00:00.000Z';
const DESTINATION = { agentId: 'claude', model: 'opus', prompt: 'keep going' };

function shortHistory() {
  return turns(8, (turn) => `short content ${turn}`);
}

function longHistory(count = 40) {
  return turns(count, (turn) => Array.from(
    { length: 500 },
    (_, token) => `token_${turn}_${token}`,
  ).join(' '));
}

function turns(count, content) {
  const messages = [];
  for (let turn = 0; turn < count; turn += 1) {
    const body = content(turn);
    messages.push(new UserMessage(TIME, body));
    messages.push(new AssistantMessage(TIME, body));
  }
  return messages;
}

function spineOf(commands) {
  const messages = turns(5, (turn) => `short content ${turn}`);
  for (let index = 0; index < commands; index += 1) {
    messages.push(new BashToolUseMessage(TIME, `t${index}`, `command-${index} ${'x'.repeat(140)}`));
  }
  return messages;
}

function historyAtExactUncompactedLimit() {
  const messages = [];
  for (let turn = 0; turn < 161; turn += 1) {
    const marker = String(messages.length);
    messages.push(
      new UserMessage(TIME, `${'word '.repeat(300)}${marker}`),
      new AssistantMessage(TIME, `${'word '.repeat(300)}${marker}`),
    );
  }
  messages.push(new UserMessage(TIME, 'word '.repeat(447)));
  return messages;
}

function service({
  enabled = true,
  respond = async () => '<summary>objective: ship it</summary>',
  discovery = 'ok',
  selection,
  unsafeSingleQuery = false,
  contextWindowTokens = 200_000,
  getUiSettings,
  onCompactionStarted = mock(() => {}),
} = {}) {
  const empty = discovery === 'empty';
  const fail = () => {
    throw new Error('provider unavailable');
  };
  const runSingleQuery = mock(respond);
  const settings = getUiSettings ?? mock(() => ({
    agentSwitchCompaction: {
      enabled,
      contextWindowTokens,
      ...(selection ?? { agentId: 'claude', model: 'haiku' }),
    },
  }));
  const agents = {
    getAgentAuthStatusMap: mock(async () => (discovery === 'throws'
      ? fail()
      : { claude: { authenticated: !empty } })),
    getAgentReadinessMap: mock(async () => (discovery === 'throws'
      ? fail()
      : { claude: { ready: !empty } })),
    getAgentCatalogEntries: mock(async () => (discovery === 'throws' ? fail() : (empty ? [] : [{
      id: 'claude',
      label: 'Claude',
      kind: 'agent',
      models: [{ id: 'haiku', label: 'Haiku' }],
    }]))),
    runSingleQuery,
    singleQueryRunsToolsWithoutPermission: mock(() => unsafeSingleQuery),
  };
  return {
    instance: new CarryOverCompactionService({
      agents,
      getUiSettings: settings,
      onCompactionStarted,
    }),
    agents,
    getUiSettings: settings,
    onCompactionStarted,
    runSingleQuery,
  };
}

function run(instance, {
  messages = longHistory(),
  signal,
  operation = 'agent-switch',
  destination = DESTINATION,
} = {}) {
  return instance.planFor({
    operation,
    chatId: 'chat-1',
    projectPath: '/workspace',
    messages,
    destination,
    ...(signal ? { signal } : {}),
  });
}

describe('carryover compaction', () => {
  it('keeps the Direct timeout cap at least as large as a compaction attempt', () => {
    expect(MAX_DIRECT_SINGLE_QUERY_TIMEOUT_MS).toBeGreaterThanOrEqual(
      CARRYOVER_COMPACTION_TIMEOUT_MS,
    );
  });

  it('returns no history before reading Settings', async () => {
    const getUiSettings = mock(() => {
      throw new Error('Settings must not be read');
    });
    const { instance, agents } = service({ getUiSettings });

    expect(await run(instance, { messages: [] })).toEqual({ kind: 'no-history' });
    expect(getUiSettings).not.toHaveBeenCalled();
    expect(agents.getAgentAuthStatusMap).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'carries a small projection without consulting Settings when compaction enabled is %s',
    async (enabled) => {
      const { instance, agents, getUiSettings, runSingleQuery } = service({ enabled });
      const messages = shortHistory();
      const result = await run(instance, { messages });

      expect(result).toEqual({
        kind: 'complete',
        context: createCarryoverTranscript(messages, 0),
      });
      expect(getUiSettings).not.toHaveBeenCalled();
      expect(agents.getAgentAuthStatusMap).not.toHaveBeenCalled();
      expect(runSingleQuery).not.toHaveBeenCalled();
    },
  );

  it('carries a small projection above the compacted injection ceiling in full', async () => {
    const messages = turns(30, () => 'word '.repeat(1_500));
    const complete = createCarryoverTranscript(messages, 0);
    expect(complete.prefix.length).toBeGreaterThan(CARRYOVER_INJECTION_MAX_CHARS);
    expect(estimateHandoffTokens(complete.prefix)).toBeLessThan(100_000);
    const { instance, runSingleQuery } = service({ enabled: false });

    expect(await run(instance, { messages })).toEqual({ kind: 'complete', context: complete });
    expect(runSingleQuery).not.toHaveBeenCalled();
  });

  it('carries history at the exact uncompacted token limit without reading Settings', async () => {
    const messages = historyAtExactUncompactedLimit();
    const complete = createCarryoverTranscript(messages, 0);
    expect(estimateHandoffTokens(complete.prefix))
      .toBe(SMALL_HISTORY_NO_COMPACTION_MAX_ESTIMATED_TOKENS);
    const getUiSettings = mock(() => {
      throw new Error('Settings must not be read at the uncompacted limit');
    });
    const { instance, runSingleQuery } = service({ getUiSettings });

    expect(await run(instance, { messages })).toEqual({ kind: 'complete', context: complete });
    expect(runSingleQuery).not.toHaveBeenCalled();
  });

  it('applies strict compaction only above the 100,000 estimated-token boundary', async () => {
    const below = longHistory(19);
    const above = longHistory(20);
    expect(estimateHandoffTokens(createCarryoverTranscript(below, 0).prefix)).toBeLessThan(100_000);
    expect(estimateHandoffTokens(createCarryoverTranscript(above, 0).prefix)).toBeGreaterThan(100_000);
    const { instance, onCompactionStarted, runSingleQuery } = service();

    expect(await run(instance, { messages: below })).toMatchObject({ kind: 'complete' });
    expect(await run(instance, { messages: above })).toMatchObject({
      kind: 'compacted',
      summary: 'objective: ship it',
    });
    expect(onCompactionStarted).toHaveBeenCalledOnce();
    expect(onCompactionStarted).toHaveBeenCalledWith('chat-1');
    expect(runSingleQuery).toHaveBeenCalledTimes(1);
    expect(runSingleQuery.mock.calls[0][1]).toMatchObject({
      timeoutMs: CARRYOVER_COMPACTION_TIMEOUT_MS,
      signal: expect.any(AbortSignal),
    });
  });

  it('requires enabled compaction for long histories with operation-aware copy', async () => {
    const { instance, runSingleQuery } = service({ enabled: false });

    await expect(run(instance)).rejects.toMatchObject({
      code: 'CARRYOVER_COMPACTION_REQUIRED',
      status: 422,
      message: "This chat's history is too large to carry directly. Enable agent-switch compaction in Settings to switch agents during long chats.",
    });
    await expect(run(instance, { operation: 'fresh-start' })).rejects.toMatchObject({
      code: 'CARRYOVER_COMPACTION_REQUIRED',
      message: expect.stringContaining('restart long chats with their history'),
    });
    expect(runSingleQuery).not.toHaveBeenCalled();
  });

  it.each([
    ['unresolved model', { discovery: 'empty', selection: {} }, 'could be resolved'],
    ['discovery failure', { discovery: 'throws', selection: {} }, 'could be resolved'],
    ['unsafe integration', { unsafeSingleQuery: true }, 'without a permission gate'],
  ])('rejects %s before querying', async (_label, options, reason) => {
    const { instance, onCompactionStarted, runSingleQuery } = service(options);

    await expect(run(instance)).rejects.toMatchObject({
      code: 'CARRYOVER_COMPACTION_UNAVAILABLE',
      status: 422,
      message: expect.stringContaining(reason),
    });
    expect(onCompactionStarted).not.toHaveBeenCalled();
    expect(runSingleQuery).not.toHaveBeenCalled();
  });

  it('rejects a spine that cannot share the compacted carryover envelope', async () => {
    const { instance, runSingleQuery } = service();

    await expect(run(instance, { messages: spineOf(3_000) })).rejects.toMatchObject({
      code: 'CARRYOVER_COMPACTION_UNAVAILABLE',
      message: expect.stringContaining('most recent turns already fill'),
    });
    expect(runSingleQuery).not.toHaveBeenCalled();
  });

  it('reports when all long history belongs to the protected recent spine', async () => {
    const messages = [new UserMessage(TIME, 'objective')];
    for (let index = 0; index < 20; index += 1) {
      messages.push(new AssistantMessage(TIME, '界'.repeat(8_000)));
    }
    const complete = createCarryoverTranscript(messages, 0);
    expect(estimateHandoffTokens(complete.prefix)).toBeGreaterThan(100_000);
    expect(complete.prefix.length).toBeLessThan(CARRYOVER_INJECTION_MAX_CHARS);
    const { instance, runSingleQuery } = service();

    await expect(run(instance, { messages })).rejects.toMatchObject({
      code: 'CARRYOVER_COMPACTION_UNAVAILABLE',
      message: expect.stringContaining('newest-three-turn verbatim spine'),
    });
    expect(runSingleQuery).not.toHaveBeenCalled();
  });

  it('reports protected-spine capacity when older history is not projectable', async () => {
    const messages = [new TranscriptNoticeMessage(TIME, 'handoff boundary')];
    for (let turn = 0; turn < 3; turn += 1) {
      messages.push(new UserMessage(TIME, `objective ${turn}`));
      for (let reply = 0; reply < 7; reply += 1) {
        messages.push(new AssistantMessage(TIME, '界'.repeat(8_000)));
      }
    }
    const complete = createCarryoverTranscript(messages, 0);
    expect(estimateHandoffTokens(complete.prefix)).toBeGreaterThan(100_000);
    expect(complete.prefix.length).toBeLessThan(CARRYOVER_INJECTION_MAX_CHARS);
    const { instance, runSingleQuery } = service();

    await expect(run(instance, { messages })).rejects.toMatchObject({
      code: 'CARRYOVER_COMPACTION_UNAVAILABLE',
      message: expect.stringContaining('newest-three-turn verbatim spine'),
    });
    expect(runSingleQuery).not.toHaveBeenCalled();
  });

  it('rejects a wrapper that leaves no room for a transcript', async () => {
    const { instance, onCompactionStarted, runSingleQuery } = service();
    const destination = { ...DESTINATION, prompt: 'instruction '.repeat(200_000) };

    await expect(run(instance, { destination })).rejects.toMatchObject({
      code: 'CARRYOVER_COMPACTION_UNAVAILABLE',
      message: expect.stringContaining('does not fit the configured window'),
    });
    expect(onCompactionStarted).not.toHaveBeenCalled();
    expect(runSingleQuery).not.toHaveBeenCalled();
  });

  it.each([200_000, 500_000, 1_000_000])(
    'fits the complete authored prompt within 75%% of a %d-token window',
    async (contextWindowTokens) => {
      const { instance, runSingleQuery } = service({ contextWindowTokens });
      await run(instance, {
        messages: longHistory(80),
        destination: { ...DESTINATION, prompt: `Focus on this request: ${'detail '.repeat(2_000)}` },
      });

      const prompt = runSingleQuery.mock.calls[0][0];
      expect(prompt).toContain('Focus on this request:');
      expect(estimateHandoffTokens(prompt))
        .toBeLessThanOrEqual(usableHandoffTokenBudget(contextWindowTokens));
    },
  );

  it('fits the default window when whole-entry selection initially stalls', async () => {
    const { instance, runSingleQuery } = service({ contextWindowTokens: 500_000 });

    await run(instance, {
      messages: turns(400, () => 'word '.repeat(500)),
    });

    expect(runSingleQuery).toHaveBeenCalledTimes(1);
    expect(estimateHandoffTokens(runSingleQuery.mock.calls[0][0]))
      .toBeLessThanOrEqual(usableHandoffTokenBudget(500_000));
  });

  it('keeps the newest three turns out of the compaction prompt and beside the summary', async () => {
    let prompt = '';
    const { instance } = service({
      respond: async (value) => {
        prompt = value;
        return '<summary>objective: ship it</summary>';
      },
    });

    const result = await run(instance, { messages: longHistory(20) });

    expect(prompt).toContain('token_0_0');
    expect(prompt).not.toContain('token_19_0');
    expect(result.context.prefix).toContain('<summary>objective: ship it</summary>');
    expect(result.context.prefix).toContain('token_19_0');
    expect(result.context.prefix).not.toContain('token_16_0');
  });

  it('retries once from the original history at 70% of the first entry budget', async () => {
    let attempt = 0;
    const { instance, onCompactionStarted, runSingleQuery } = service({
      respond: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('first attempt failed');
        return '<summary>second attempt succeeded</summary>';
      },
    });

    const result = await run(instance, { messages: longHistory(40) });

    expect(result.summary).toBe('second attempt succeeded');
    expect(onCompactionStarted).toHaveBeenCalledOnce();
    expect(runSingleQuery).toHaveBeenCalledTimes(2);
    const firstPrompt = runSingleQuery.mock.calls[0][0];
    const secondPrompt = runSingleQuery.mock.calls[1][0];
    expect(estimateHandoffTokens(secondPrompt)).toBeLessThan(estimateHandoffTokens(firstPrompt));
    expect(firstPrompt).toContain('token_0_0');
    expect(secondPrompt).toContain('token_0_0');
    expect(runSingleQuery.mock.calls[0][1].signal)
      .not.toBe(runSingleQuery.mock.calls[1][1].signal);
    expect(runSingleQuery.mock.calls.map(([, options]) => options.timeoutMs)).toEqual([
      CARRYOVER_COMPACTION_TIMEOUT_MS,
      CARRYOVER_COMPACTION_TIMEOUT_MS,
    ]);
  });

  it.each([
    ['malformed framing', 'summary without XML'],
    ['empty summary', '<summary> </summary>'],
    ['duplicate summary', '<summary>outer <summary>inner</summary></summary>'],
    ['oversized summary', `<summary>${'é'.repeat(32_769)}</summary>`],
  ])('retries a %s result once', async (_label, response) => {
    const { instance, runSingleQuery } = service({ respond: async () => response });

    await expect(run(instance)).rejects.toMatchObject({
      code: 'CARRYOVER_COMPACTION_FAILED',
      status: 502,
      retryable: true,
    });
    expect(runSingleQuery).toHaveBeenCalledTimes(2);
  });

  it('retries an uninjectable summary once', async () => {
    const { instance, runSingleQuery } = service({
      respond: async () => `<summary>${'x'.repeat(65_537)}</summary>`,
    });

    await expect(run(instance)).rejects.toMatchObject({
      code: 'CARRYOVER_COMPACTION_FAILED',
      message: expect.stringContaining('65536 UTF-8 bytes'),
    });
    expect(runSingleQuery).toHaveBeenCalledTimes(2);
  });

  it('stops after two provider failures without returning a fallback', async () => {
    const { instance, runSingleQuery } = service({
      respond: async () => {
        throw new Error('model unavailable');
      },
    });

    await expect(run(instance)).rejects.toMatchObject({
      code: 'CARRYOVER_COMPACTION_FAILED',
      status: 502,
      retryable: true,
      message: expect.stringContaining('failed after two attempts (model unavailable)'),
    });
    expect(runSingleQuery).toHaveBeenCalledTimes(2);
  });

  it('does not retry an outer cancellation', async () => {
    const controller = new AbortController();
    const { instance, runSingleQuery } = service({
      respond: async () => {
        controller.abort(new Error('handoff stopped'));
        throw controller.signal.reason;
      },
    });

    await expect(run(instance, { signal: controller.signal })).rejects.toThrow('handoff stopped');
    expect(runSingleQuery).toHaveBeenCalledTimes(1);
  });

  it('accepts outer whitespace and preserves logical summary formatting', async () => {
    const logical = 'Objective\n\n    Keep <path> & command indentation.';
    const { instance } = service({
      respond: async () => ` \n<summary>\n  ${logical}\n</summary>\n\t`,
    });

    const result = await run(instance);

    expect(result.summary).toBe(logical);
    expect(result.context.prefix).toContain(
      '<summary>Objective\n\n    Keep &lt;path&gt; &amp; command indentation.</summary>',
    );
    expect(result.context.prefix.match(/<carried-context/g)).toHaveLength(1);
  });
});
