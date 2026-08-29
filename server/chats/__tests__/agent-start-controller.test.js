import { describe, expect, it, mock } from 'bun:test';
import { KeyedPromiseLock } from '../../lib/keyed-lock.ts';
import { AgentStartController } from '../agent-start-controller.ts';

const SOURCE_CHAT_ID = '1787974832309199';
const SECOND_SOURCE_CHAT_ID = '1787974832309200';
const CREATED_CHAT_ID = '1787974832309300';
const SECOND_CREATED_CHAT_ID = '1787974832309301';
const REF = '69b623a7-757e-49f6-93b8-4b7ea1bc569b';
const SECOND_REF = '2cf0e440-11b4-41aa-bc90-36145b214f66';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for agent-start state');
}

function params(overrides = {}) {
  return {
    ref: REF,
    agentId: 'claude',
    providerId: null,
    endpointId: null,
    model: 'claude-sonnet',
    reasoningEffort: 'high',
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    sourceChatId: SOURCE_CHAT_ID,
    sourceViewId: 'source-view',
    requestRunId: 'source-run',
    requestAt: '2026-08-29T00:00:00.000Z',
    prompt: 'Investigate the failure.',
    params: [params()],
    ...overrides,
  };
}

function selection(overrides = {}) {
  return {
    model: 'claude-sonnet',
    apiProviderId: null,
    modelEndpointId: null,
    modelProtocol: null,
    permissionMode: 'acceptEdits',
    thinkingMode: 'high',
    agentSettings: { ownerId: 'claude', schemaVersion: 1, values: { mode: 'saved' } },
    ...overrides,
  };
}

function executionDefaults(overrides = {}) {
  return {
    global: {
      permissionMode: 'acceptEdits',
      thinkingMode: 'high',
      agentSettingsById: {},
    },
    byAgent: {},
    ...overrides,
  };
}

function createFixture(overrides = {}) {
  const chats = overrides.chats ?? new Map([
    [SOURCE_CHAT_ID, { projectPath: '/repo/source' }],
    [SECOND_SOURCE_CHAT_ID, { projectPath: '/repo/second' }],
  ]);
  const views = overrides.views ?? new Map([
    [SOURCE_CHAT_ID, { viewId: 'source-view' }],
    [SECOND_SOURCE_CHAT_ID, { viewId: 'second-view' }],
  ]);
  const allocated = [...(overrides.allocated ?? [CREATED_CHAT_ID, SECOND_CREATED_CHAT_ID])];
  let enabled = overrides.enabled ?? true;
  let nextId = 0;
  const registry = {
    getChat: mock((chatId) => chats.get(chatId) ?? null),
  };
  const selectionService = {
    resolve: mock(async () => ({ ok: true, selection: selection() })),
    ...overrides.selection,
  };
  const commands = {
    submitAgentCommandStart: mock(async () => ({ success: true })),
    ...overrides.commands,
  };
  const chatIds = {
    allocate: mock(() => {
      const next = allocated.shift();
      if (!next) throw new Error('No allocated chat ID remains');
      return next;
    }),
  };
  const execution = {
    deliverAgentCommandResult: mock(async () => 'delivered'),
    ...overrides.execution,
  };
  const notices = {
    currentView: mock((chatId) => views.get(chatId) ?? null),
    appendNotice: mock(() => undefined),
    ...overrides.notices,
  };
  const errors = [];
  const dispositions = [];
  const defaults = overrides.defaults ?? executionDefaults();
  const controller = new AgentStartController({
    registry,
    selection: selectionService,
    commands,
    chatIds,
    execution,
    notices,
    chatMutationLock: overrides.chatMutationLock ?? new KeyedPromiseLock(),
    batchLock: overrides.batchLock ?? new KeyedPromiseLock(),
    getExecutionDefaults: overrides.getExecutionDefaults ?? (() => defaults),
    isEnabled: () => enabled,
    createId: () => `generated-${++nextId}`,
    onDisposition: (event) => dispositions.push(event),
    onError: (error, context) => errors.push({ error, context }),
  });
  return {
    controller,
    registry,
    selection: selectionService,
    commands,
    chatIds,
    execution,
    notices,
    chats,
    views,
    errors,
    dispositions,
    setEnabled(value) { enabled = value; },
  };
}

function sourceNotices(fixture) {
  return fixture.notices.appendNotice.mock.calls.filter(([chatId]) => chatId === SOURCE_CHAT_ID);
}

describe('AgentStartController', () => {
  it('starts ordinary tagged chats sequentially and delivers ordered result lines', async () => {
    const firstStart = deferred();
    let startCount = 0;
    const fixture = createFixture({
      commands: {
        submitAgentCommandStart: mock(async () => {
          startCount += 1;
          if (startCount === 1) await firstStart.promise;
        }),
      },
    });
    fixture.controller.request(request({
      params: [params(), params({ ref: SECOND_REF, model: 'claude-opus' })],
    }));

    await waitFor(() => fixture.commands.submitAgentCommandStart.mock.calls.length === 1);
    expect(fixture.selection.resolve).toHaveBeenCalledTimes(1);
    firstStart.resolve();
    await fixture.controller.waitForIdle();

    expect(fixture.commands.submitAgentCommandStart).toHaveBeenCalledTimes(2);
    expect(fixture.commands.submitAgentCommandStart.mock.calls[0][0]).toEqual({
      chatId: CREATED_CHAT_ID,
      clientRequestId: 'generated-1',
      clientMessageId: 'generated-2',
      agentId: 'claude',
      projectPath: '/repo/source',
      command: 'Investigate the failure.',
      model: 'claude-sonnet',
      apiProviderId: null,
      modelEndpointId: null,
      modelProtocol: null,
      permissionMode: 'acceptEdits',
      thinkingMode: 'high',
      agentSettings: { ownerId: 'claude', schemaVersion: 1, values: { mode: 'saved' } },
      tags: ['sub-agent'],
    });
    const delivery = fixture.execution.deliverAgentCommandResult.mock.calls[0];
    expect(delivery[0]).toBe(SOURCE_CHAT_ID);
    expect(delivery[1]).toMatchObject({
      transcriptViewId: 'source-view',
      content: `<garcon-create-chat-result ref="${REF}" error="false" msg="created" chat-id="${CREATED_CHAT_ID}" />\n<garcon-create-chat-result ref="${SECOND_REF}" error="false" msg="created" chat-id="${SECOND_CREATED_CHAT_ID}" />`,
      receipt: {
        detail: {
          type: 'sub-agent-start-outcome',
          deliveryStatus: 'delivered',
          results: [
            { ref: REF, error: false, msg: 'created', chatId: CREATED_CHAT_ID },
            { ref: SECOND_REF, error: false, msg: 'created', chatId: SECOND_CREATED_CHAT_ID },
          ],
        },
      },
    });
    expect(delivery[2]).toBe('source-run');
    expect(sourceNotices(fixture)[0][2].detail.deliveryStatus).toBe('delivered');
  });

  it('isolates semantic and typed start failures while preserving result order', async () => {
    const fixture = createFixture({
      selection: {
        resolve: mock(async (input) => input.ref === REF
          ? { ok: false, message: 'unknown-model' }
          : { ok: true, selection: selection() }),
      },
      commands: {
        submitAgentCommandStart: mock(async () => {
          throw { code: 'SESSION_LIMIT' };
        }),
      },
    });
    fixture.controller.request(request({
      params: [params(), params({ ref: SECOND_REF })],
    }));
    await fixture.controller.waitForIdle();

    expect(fixture.commands.submitAgentCommandStart).toHaveBeenCalledTimes(1);
    expect(fixture.execution.deliverAgentCommandResult.mock.calls[0][1].content).toBe(
      `<garcon-create-chat-result ref="${REF}" error="true" msg="unknown-model" />\n`
      + `<garcon-create-chat-result ref="${SECOND_REF}" error="true" msg="session-limit" />`,
    );
  });

  it('retries chat ID collisions with fresh command identities and reports exhaustion', async () => {
    const fixture = createFixture({
      allocated: [CREATED_CHAT_ID, SECOND_CREATED_CHAT_ID, '1787974832309302'],
      commands: {
        submitAgentCommandStart: mock(async () => {
          throw { code: 'CHAT_ID_COLLISION' };
        }),
      },
    });
    fixture.controller.request(request());
    await fixture.controller.waitForIdle();

    expect(fixture.commands.submitAgentCommandStart).toHaveBeenCalledTimes(3);
    expect(fixture.commands.submitAgentCommandStart.mock.calls.map(([input]) => [
      input.chatId,
      input.clientRequestId,
      input.clientMessageId,
    ])).toEqual([
      [CREATED_CHAT_ID, 'generated-1', 'generated-2'],
      [SECOND_CREATED_CHAT_ID, 'generated-3', 'generated-4'],
      ['1787974832309302', 'generated-5', 'generated-6'],
    ]);
    expect(fixture.execution.deliverAgentCommandResult.mock.calls[0][1].content)
      .toContain('error="true" msg="chat-id-collision"');
  });

  it('records an initially disabled batch without creating or delivering agent input', async () => {
    const fixture = createFixture({ enabled: false });
    fixture.controller.request(request({ params: [params(), params({ ref: SECOND_REF })] }));
    await fixture.controller.waitForIdle();

    expect(fixture.selection.resolve).not.toHaveBeenCalled();
    expect(fixture.commands.submitAgentCommandStart).not.toHaveBeenCalled();
    expect(fixture.execution.deliverAgentCommandResult).not.toHaveBeenCalled();
    expect(sourceNotices(fixture)[0][2]).toMatchObject({
      detail: {
        type: 'sub-agent-start-outcome',
        deliveryStatus: 'disabled',
        results: [
          { ref: REF, error: true, msg: 'disabled' },
          { ref: SECOND_REF, error: true, msg: 'disabled' },
        ],
      },
    });
  });

  it('stops unstarted refs after a mid-batch disable and still returns prior results', async () => {
    let fixture;
    fixture = createFixture({
      commands: {
        submitAgentCommandStart: mock(async () => {
          fixture.setEnabled(false);
        }),
      },
    });
    fixture.controller.request(request({ params: [params(), params({ ref: SECOND_REF })] }));
    await fixture.controller.waitForIdle();

    expect(fixture.commands.submitAgentCommandStart).toHaveBeenCalledTimes(1);
    expect(fixture.execution.deliverAgentCommandResult.mock.calls[0][1].receipt.detail.results)
      .toEqual([
        { ref: REF, error: false, msg: 'created', chatId: CREATED_CHAT_ID },
        { ref: SECOND_REF, error: true, msg: 'disabled' },
      ]);
  });

  it('captures the source project path and execution defaults at admission', async () => {
    const gate = deferred();
    const defaults = executionDefaults();
    const fixture = createFixture({
      defaults,
      batchLock: {
        runExclusive: async (_key, operation) => {
          await gate.promise;
          return operation();
        },
      },
    });
    fixture.controller.request(request());
    fixture.chats.get(SOURCE_CHAT_ID).projectPath = '/repo/changed';
    defaults.global.permissionMode = 'default';
    gate.resolve();
    await fixture.controller.waitForIdle();

    expect(fixture.selection.resolve.mock.calls[0][1].global.permissionMode).toBe('acceptEdits');
    expect(fixture.commands.submitAgentCommandStart.mock.calls[0][0].projectPath).toBe('/repo/source');
  });

  it('aborts later refs and result delivery when the source is discarded during a start', async () => {
    const start = deferred();
    const fixture = createFixture({
      commands: { submitAgentCommandStart: mock(() => start.promise) },
    });
    fixture.controller.request(request({ params: [params(), params({ ref: SECOND_REF })] }));
    await waitFor(() => fixture.commands.submitAgentCommandStart.mock.calls.length === 1);

    fixture.controller.discardSource(SOURCE_CHAT_ID);
    start.resolve({ success: true });
    await fixture.controller.waitForIdle();

    expect(fixture.commands.submitAgentCommandStart).toHaveBeenCalledTimes(1);
    expect(fixture.execution.deliverAgentCommandResult).not.toHaveBeenCalled();
    expect(sourceNotices(fixture)).toEqual([]);
  });

  it('records queued, ambiguous, and failed result-delivery dispositions without retrying', async () => {
    const queued = createFixture({
      execution: { deliverAgentCommandResult: mock(async () => 'queued') },
    });
    queued.controller.request(request());
    await queued.controller.waitForIdle();
    expect(sourceNotices(queued)[0][2].detail.deliveryStatus).toBe('queued');

    const unknown = createFixture({
      execution: {
        deliverAgentCommandResult: mock(async () => {
          throw { code: 'STEER_OUTCOME_UNKNOWN' };
        }),
      },
    });
    unknown.controller.request(request());
    await unknown.controller.waitForIdle();
    expect(sourceNotices(unknown)[0][2].detail.deliveryStatus).toBe('delivery-unknown');

    const failed = createFixture({
      execution: {
        deliverAgentCommandResult: mock(async () => {
          throw { code: 'CONTROL_INPUT_QUEUE_FULL' };
        }),
      },
    });
    failed.controller.request(request());
    await failed.controller.waitForIdle();
    expect(sourceNotices(failed)[0][2].detail.deliveryStatus).toBe('delivery-failed');
    expect(failed.execution.deliverAgentCommandResult).toHaveBeenCalledTimes(1);
  });

  it('suppresses stale outcomes when the source view changes before delivery', async () => {
    const start = deferred();
    const fixture = createFixture({
      commands: { submitAgentCommandStart: mock(() => start.promise) },
    });
    fixture.controller.request(request());
    await waitFor(() => fixture.commands.submitAgentCommandStart.mock.calls.length === 1);
    fixture.views.set(SOURCE_CHAT_ID, { viewId: 'replacement-view' });
    start.resolve({ success: true });
    await fixture.controller.waitForIdle();

    expect(fixture.execution.deliverAgentCommandResult).not.toHaveBeenCalled();
    expect(sourceNotices(fixture)).toEqual([]);
  });

  it('serializes batches per source while allowing a different source to proceed', async () => {
    const first = deferred();
    const started = [];
    const fixture = createFixture({
      allocated: [CREATED_CHAT_ID, SECOND_CREATED_CHAT_ID, '1787974832309302'],
      commands: {
        submitAgentCommandStart: mock(async (input) => {
          started.push(input.projectPath);
          if (started.length === 1) await first.promise;
        }),
      },
    });
    fixture.controller.request(request());
    fixture.controller.request(request({ requestRunId: 'second-source-batch' }));
    fixture.controller.request(request({
      sourceChatId: SECOND_SOURCE_CHAT_ID,
      sourceViewId: 'second-view',
      requestRunId: 'other-source-run',
    }));

    await waitFor(() => started.length === 2);
    expect(started).toContain('/repo/second');
    expect(started.filter((path) => path === '/repo/source')).toHaveLength(1);
    first.resolve();
    await fixture.controller.waitForIdle();
    expect(started.filter((path) => path === '/repo/source')).toHaveLength(2);
  });
});
