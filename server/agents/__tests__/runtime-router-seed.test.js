import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { createLocalProviderInstances } from '../../execution-node/local-provider-instance.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AssistantMessage, UserMessage } from '../../../common/chat-types.js';
import { renderCarriedContext } from '../../../common/transcript-seed.js';
import { AgentRuntimeRouter } from '../runtime-router.ts';
import { AgentInstanceDirectory } from '../instance-directory.ts';
import { testExecutionLocation } from '../../execution-nodes/testing/placement.ts';
import { DomainError } from '../../lib/domain-error.ts';
import { createRuntimeTranscriptFixture } from './runtime-router-test-fixture.js';
import { LocalWorkspaceFileMentionService } from '../../execution-node/local-workspace-file-mentions.js';
import { WorkspaceFileMentionResolver } from '../../chats/workspace-file-mention-resolver.js';

let projectDir;

function makeRouter(overrides = {}) {
  const settings = { ownerId: 'test', schemaVersion: 1, values: {} };
  const entry = {
    id: 'chat-1',
    agentId: 'test',
    executionLocation: testExecutionLocation(),
    agentSessionId: null,
    nativeSession: null,
    nativeSeedReceipt: null,
    agentOwnershipEpoch: 'epoch-1',
    agentSettingsById: { test: settings },
    projectPath: projectDir,
    model: 'model-a',
    apiProviderId: null,
    modelEndpointId: null,
    modelProtocol: null,
    permissionMode: 'default',
    thinkingMode: 'none',
    tags: [],
    ...overrides.entry,
  };
  const conversation = overrides.conversation ?? [
    new UserMessage('2026-08-12T00:00:00.000Z', 'prior context'),
  ];
  const transcript = createRuntimeTranscriptFixture({
    conversation,
    composition: overrides.composition,
    conversationMessages: overrides.conversationMessages,
    appendNotice: overrides.appendNotice,
    currentView: overrides.currentView,
  });
  const start = overrides.start ?? mock(async (request) => {
    request.output.emit({
      type: 'session',
      session: {
        agentSessionId: 'native-1',
        nativeSession: { ownerId: 'test', schemaVersion: 1, value: { id: 'native-1' } },
        nativeSeedReceipt: null,
      },
    });
    request.output.emit({ type: 'run-ended', runId: request.runId, outcome: 'finished' });
    return { id: 'start-handle' };
  });
  const resume = overrides.resume ?? mock(async (request) => {
    request.output.emit({ type: 'run-ended', runId: request.runId, outcome: 'finished' });
    return { id: 'resume-handle' };
  });
  const submitGoalControl = overrides.submitGoalControl ?? mock(async () => true);
  const steer = overrides.steer ?? mock(async () => ({ kind: 'accepted' }));
  const providerTarget = overrides.providerTarget ?? {};
  const captureTarget = overrides.captureTarget ?? mock(() => providerTarget);
  const integration = {
    descriptor: {
      id: 'test',
      supportedPermissionModes: ['default'],
      supportedThinkingModes: ['none'],
    },
    execution: {
      start,
      resume,
      abort: mock(async () => undefined),
    },
    steering: { captureTarget, steer },
    goals: { submitControl: submitGoalControl },
    settings: { defaults: () => settings, parse: (input) => input },
  };
  const registry = {
    getChat: mock(() => entry),
    updateChat: mock((_chatId, patch) => Object.assign(entry, patch)),
  };
  let activeTurn = overrides.activeTurn;
  const events = {
    trackTurn: mock((_chatId, turn) => { activeTurn = turn; }),
    handoffTurn: mock((_chatId, predecessor, successor, downstream) => ({
      validate: () => {
        if (activeTurn?.turnId !== predecessor?.turnId) throw new Error('active turn changed');
        downstream.validate();
      },
      commit: () => {
        activeTurn = successor;
        downstream.commit();
      },
    })),
    clearTurn: mock(() => { activeTurn = undefined; }),
    getActiveTurn: mock(() => activeTurn),
  };
  const endpointResolver = {
    resolveSelection: mock((request) => ({
      model: request.model,
      apiProviderId: request.apiProviderId ?? null,
      endpointId: request.modelEndpointId ?? null,
      protocol: request.apiProviderId ? 'openai-compatible' : null,
      isLocal: false,
    })),
    resolveEndpointReference: mock(() => null),
  };
  const instances = overrides.instances?.(integration) ?? new AgentInstanceDirectory(createLocalProviderInstances([
    { configuration: instanceConfiguration('test-test', true), integration },
  ]));
  const router = new AgentRuntimeRouter({
    fileMentions: overrides.fileMentions ?? {
      resolve: (command, target, signal) => new LocalWorkspaceFileMentionService()
        .resolve({ command, projectPath: target.projectPath }, signal),
    },
    registry,
    providerIds: ['test'],
    localNodeId: testExecutionLocation().nodeId,
    instances,
    endpointResolver,
    events,
    getCarryOverRevision: () => 'carry-1',
    createCarriedContext: overrides.createCarriedContext ?? (async ({ messages }) => {
      const context = renderCarriedContext(messages);
      return context ? { kind: 'complete', context } : { kind: 'no-history' };
    }),
    ledger: transcript.ledger,
    hasPendingOwnershipTransfer: () => false,
    adoption: transcript.adoption,
  });
  return {
    router,
    start,
    resume,
    submitGoalControl,
    captureTarget,
    providerTarget,
    steer,
    registry,
    events,
    conversation,
    endpointResolver,
    transcript,
    integration,
    instances,
  };
}

describe('AgentRuntimeRouter producer boundary', () => {
  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-runtime-router-'));
    await fs.writeFile(path.join(projectDir, 'notes.txt'), 'USER FILE BODY');
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  for (const operation of ['start', 'resume']) {
    it.each(['synthetic input', 'read @notes.txt'])(`preserves ${operation} input when mention placement is unavailable: %s`, async (prompt) => {
      const serviceFor = mock(() => { throw new DomainError('NODE_UNAVAILABLE', 'Synthetic placement failure', 409); });
      const fixture = makeRouter({
        fileMentions: new WorkspaceFileMentionResolver(serviceFor),
        entry: { agentSessionId: operation === 'resume' ? 'native-1' : null },
      });
      await fixture.router.runAgentTurn('chat-1', prompt);
      expect(fixture[operation]).toHaveBeenCalledWith(expect.objectContaining({ prompt }));
      expect(serviceFor).toHaveBeenCalledTimes(prompt.includes('@') ? 1 : 0);
    });

    it(`captures the workspace target and admission cancellation for ${operation} file mentions`, async () => {
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      const cancellation = new AbortController();
      const fileMentions = {
        resolve: mock(async (_command, _target, signal) => {
          entered.resolve();
          await release.promise;
          signal.throwIfAborted();
          return 'resolved synthetic context';
        }),
      };
      const f = makeRouter({ fileMentions, entry: { agentSessionId: operation === 'resume' ? 'native-1' : null } });
      const pending = f.router.runAgentTurn('chat-1', 'read @notes.txt', {
        executionAdmission: { signal: cancellation.signal, async markStarted() {} },
      });
      await entered.promise;
      const target = fileMentions.resolve.mock.calls[0][1];
      expect(target).toMatchObject({ projectPath: projectDir, executionLocation: testExecutionLocation() });
      expect(fileMentions.resolve.mock.calls[0][2]).toBe(cancellation.signal);
      f.registry.updateChat('chat-1', { projectPath: '/successor', executionLocation: testExecutionLocation('successor') });
      expect(target).toMatchObject({ projectPath: projectDir, executionLocation: testExecutionLocation() });
      cancellation.abort(new Error('Synthetic mention admission cancellation'));
      release.resolve();
      await expect(pending).rejects.toBe(cancellation.signal.reason);
      expect(f[operation]).not.toHaveBeenCalled();
      expect(f.transcript.ledger.activeRunId()).toBeNull();
    });

    it(`uses the validated configuration snapshot for ${operation}`, async () => {
      const fixture = makeRouter({
        entry: { agentSessionId: operation === 'resume' ? 'native-1' : null },
      });
      const validation = Promise.withResolvers();
      const entered = Promise.withResolvers();
      fixture.integration.descriptor.supportedPermissionModes = ['default', 'manualBypass'];
      fixture.integration.descriptor.supportedThinkingModes = ['none', 'low'];
      fixture.integration.endpoints = { validate: mock(() => { entered.resolve(); return validation.promise; }) };
      fixture.integration.settings.parse = mock((value) => value);
      const reference = {
        apiProvider: { label: 'Synthetic endpoint' },
        endpoint: { baseUrl: 'https://original.invalid/v1', headers: { 'x-synthetic': 'original' } },
      };
      fixture.endpointResolver.resolveEndpointReference.mockImplementation(() => reference);
      const options = {
        apiProviderId: 'synthetic-api', modelEndpointId: 'synthetic-endpoint',
        permissionMode: 'manualBypass', thinkingMode: 'low',
        agentSettings: { ownerId: 'test', schemaVersion: 1, values: { option: 'original' } },
      };
      const pending = fixture.router.runAgentTurn('chat-1', 'synthetic prompt', options);
      await Promise.race([entered.promise, pending]);
      reference.endpoint.baseUrl = 'https://changed.invalid/v1';
      reference.endpoint.headers['x-synthetic'] = 'changed';
      options.permissionMode = 'default';
      options.thinkingMode = 'none';
      options.agentSettings.values.option = 'changed';
      validation.resolve();
      await pending;
      expect(fixture[operation]).toHaveBeenCalledWith(expect.objectContaining({
        permissionMode: 'manualBypass', thinkingMode: 'low',
        settings: { ownerId: 'test', schemaVersion: 1, values: { option: 'original' } },
        endpoint: { selection: expect.objectContaining({
          baseUrl: 'https://original.invalid/v1', headers: { 'x-synthetic': 'original' },
        }), credential: null },
      }));
      expect(fixture.endpointResolver.resolveEndpointReference).toHaveBeenCalledTimes(1);
      expect(fixture.integration.settings.parse).toHaveBeenCalledTimes(1);
    });

    it(`cancels ${operation} during configuration validation without creating a run`, async () => {
      const fixture = makeRouter({ entry: { agentSessionId: operation === 'resume' ? 'native-1' : null } });
      const validation = Promise.withResolvers();
      const entered = Promise.withResolvers();
      fixture.integration.endpoints = { validate: mock(() => { entered.resolve(); return validation.promise; }) };
      fixture.endpointResolver.resolveEndpointReference.mockImplementation(() => ({
        apiProvider: { label: 'Synthetic API' }, endpoint: { baseUrl: 'https://synthetic.invalid/v1' },
      }));
      const abort = new AbortController();
      const pending = fixture.router.runAgentTurn('chat-1', 'synthetic prompt', {
        apiProviderId: 'synthetic-api', modelEndpointId: 'synthetic-endpoint',
        executionAdmission: { signal: abort.signal, markStarted: async () => {} },
      });
      await Promise.race([entered.promise, pending]);
      const reason = new Error('Synthetic admission closed');
      abort.abort(reason);
      validation.resolve();
      await expect(pending).rejects.toBe(reason);
      expect(fixture[operation]).not.toHaveBeenCalled();
      expect(fixture.events.trackTurn).not.toHaveBeenCalled();
    });

    it(`routes ${operation} and settings to the selected same-provider instance`, async () => {
      const location = { ...testExecutionLocation(), instanceId: 'secondary-test' };
      const execute = mock(async () => ({ id: 'secondary-handle' }));
      const parse = mock((value) => value);
      const fixture = makeRouter({
        entry: {
          executionLocation: location,
          agentSessionId: operation === 'resume' ? 'same-native-id' : null,
        },
        instances: (integration) => new AgentInstanceDirectory(createLocalProviderInstances([
          {
            configuration: instanceConfiguration('test-test', true),
            integration,
          },
          {
            configuration: instanceConfiguration(location.instanceId, false),
            integration: {
              ...integration,
              execution: { ...integration.execution, [operation]: execute },
              settings: { ...integration.settings, parse },
            },
          },
        ])),
      });

      await fixture.router.runAgentTurn('chat-1', 'synthetic input', { turnId: 'synthetic-turn' });

      expect(execute).toHaveBeenCalledTimes(1);
      expect(parse).toHaveBeenCalledTimes(1);
      expect(fixture[operation]).not.toHaveBeenCalled();
    });

    it(`rejects ${operation} for an unavailable instance without using the provider default`, async () => {
      const fixture = makeRouter({
        entry: { agentSessionId: operation === 'resume' ? 'same-native-id' : null },
        instances: () => new AgentInstanceDirectory(createLocalProviderInstances([])),
      });

      await expect(fixture.router.runAgentTurn('chat-1', 'synthetic input'))
        .rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
      expect(fixture[operation]).not.toHaveBeenCalled();
    });

    it(`aborts a retained ${operation} handle through its captured execution owner`, async () => {
      const handle = { id: 'synthetic-handle' };
      const { router, integration, instances } = makeRouter({
        entry: { agentSessionId: operation === 'resume' ? 'synthetic-session' : null },
        [operation]: mock(async () => handle),
      });
      await router.runAgentTurn('chat-1', 'synthetic input', { turnId: 'synthetic-turn' });
      const replacementAbort = mock(async () => true);
      const lookup = spyOn(instances, 'get').mockImplementation(() => ({
        ...integration, execution: { ...integration.execution, abort: replacementAbort },
      }));

      expect(await router.abortSession('chat-1')).toBe(true);

      expect(integration.execution.abort).toHaveBeenCalledWith(handle);
      expect(replacementAbort).not.toHaveBeenCalled();
      expect(lookup).not.toHaveBeenCalled();
    });

    it(`keeps a delayed ${operation} handle owned by its interrupted launch`, async () => {
      const launched = Promise.withResolvers();
      const completed = Promise.withResolvers();
      const handle = { id: 'synthetic-delayed-handle' };
      const { router, integration, instances } = makeRouter({
        entry: { agentSessionId: operation === 'resume' ? 'synthetic-session' : null },
        [operation]: mock(() => {
          launched.resolve();
          return completed.promise;
        }),
      });
      const dispatch = router.runAgentTurn('chat-1', 'synthetic input', { turnId: 'synthetic-turn' });
      await launched.promise;
      expect(await router.abortSession('chat-1')).toBe(true);
      const replacementAbort = mock(async () => true);
      const lookup = spyOn(instances, 'get').mockImplementation(() => ({
        ...integration, execution: { ...integration.execution, abort: replacementAbort },
      }));
      completed.resolve(handle);
      await dispatch;

      expect(integration.execution.abort).toHaveBeenCalledWith(handle);
      expect(replacementAbort).not.toHaveBeenCalled();
      expect(lookup).not.toHaveBeenCalled();
    });
  }

  it('resolves the prompt and derives carried context for a fresh session', async () => {
    const { router, start } = makeRouter();

    await router.runAgentTurn('chat-1', 'review @notes.txt', {
      clientRequestId: 'request-1',
      clientMessageId: 'message-1',
      turnId: 'turn-1',
    });

    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('USER FILE BODY'),
      carriedContext: expect.objectContaining({
        prefix: expect.stringContaining('prior context'),
      }),
      runId: 'turn-1',
      output: expect.objectContaining({ emit: expect.any(Function) }),
    }));
    expect(start.mock.calls[0][0]).not.toHaveProperty('priorContext');
  });

  it('keeps the private preamble out of carryover planning and prepends it to the outbound prompt', async () => {
    const providerPrefix = '<garcon-preambles>PRIVATE</garcon-preambles>\n\n';
    const createCarriedContext = mock(async ({ destinationPrompt }) => {
      expect(destinationPrompt).toContain('USER FILE BODY');
      expect(destinationPrompt).not.toContain('PRIVATE');
      return { kind: 'complete', context: { prefix: 'carried context' } };
    });
    const { router, start } = makeRouter({
      composition: {
        inserted: true,
        input: inputRow(1, 'review @notes.txt'),
        prompt: [inputRow(1, 'review @notes.txt')],
        providerPrefix,
      },
      createCarriedContext,
    });

    await router.runAgentTurn('chat-1', 'fallback', {
      clientMessageId: 'message-1',
      turnId: 'turn-1',
    });

    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringMatching(/^<garcon-preambles>PRIVATE<\/garcon-preambles>\n\nreview @notes\.txt/),
      carriedContext: { prefix: 'carried context' },
    }));
    expect(start.mock.calls[0][0].prompt).toContain('USER FILE BODY');
    expect(start.mock.calls[0][0]).not.toHaveProperty('providerPrefix');
  });

  it('excludes every composed prompt row from fresh-session carried context', async () => {
    const context = [new AssistantMessage('2026-08-12T00:00:00.000Z', 'earlier answer')];
    const conversationMessages = mock((_chatId, excluded) => {
      expect([...excluded]).toEqual([2, 3]);
      return context;
    });
    const composition = {
      inserted: true,
      input: inputRow(3, 'current'),
      prompt: [inputRow(2, 'unanswered'), inputRow(3, 'current')],
    };
    const { router, start } = makeRouter({ composition, conversationMessages });

    await router.runAgentTurn('chat-1', 'fallback', {
      clientMessageId: 'message-3',
      turnId: 'turn-1',
    });

    expect(conversationMessages).toHaveBeenCalledWith('chat-1', expect.any(Set));
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'unanswered\n\ncurrent',
      carriedContext: expect.objectContaining({
        prefix: expect.stringContaining('earlier answer'),
      }),
    }));
  });

  it('derives a new session seed from the authoritative ledger context', async () => {
    const createCarriedContext = mock(async ({ messages }) => ({
      kind: 'compacted',
      context: {
        prefix: `compacted:${messages.map((message) => message.content).join('|')}`,
      },
      summary: 'compacted prior context',
    }));
    const { router, start, conversation, transcript } = makeRouter({ createCarriedContext });

    await router.runAgentTurn('chat-1', 'continue', {
      clientMessageId: 'message-1',
      turnId: 'turn-1',
    });

    expect(createCarriedContext).toHaveBeenCalledWith({
      chatId: 'chat-1',
      entry: expect.objectContaining({ agentId: 'test' }),
      messages: conversation,
      transcriptViewId: 'view-1',
      destinationPrompt: 'continue',
      clientRequestId: null,
      signal: undefined,
    });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      carriedContext: { prefix: 'compacted:prior context' },
    }));
    expect(transcript.notices).toEqual([expect.objectContaining({
      kind: 'notice',
      message: 'compacted prior context',
      detail: { type: 'handoff-summary', title: 'Handoff summary' },
    })]);
  });

  it('appends the accepted handoff summary immediately before provider start', async () => {
    const order = [];
    const summary = 'Objective\n\n  Preserve this indentation.';
    const start = mock(async (request) => {
      order.push('provider-start');
      request.output.emit({ type: 'run-ended', runId: request.runId, outcome: 'finished' });
      return { id: 'start-handle' };
    });
    const { router, transcript } = makeRouter({
      start,
      appendNotice: (_chatId, _viewId, notice) => order.push(`notice:${notice.content}`),
      createCarriedContext: async () => ({
        kind: 'compacted',
        context: { prefix: 'compacted seed' },
        summary,
      }),
    });

    await router.runAgentTurn('chat-1', 'continue', {
      clientMessageId: 'message-1',
      turnId: 'turn-1',
    });

    expect(order).toEqual([`notice:${summary}`, 'provider-start']);
    expect(transcript.notices).toEqual([expect.objectContaining({
      kind: 'notice',
      message: summary,
      detail: { type: 'handoff-summary', title: 'Handoff summary' },
    })]);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      carriedContext: { prefix: 'compacted seed' },
    }));
  });

  it('appends a compact durable notice for a complete projection', async () => {
    const order = [];
    const start = mock(async (request) => {
      order.push('provider-start');
      request.output.emit({ type: 'run-ended', runId: request.runId, outcome: 'finished' });
      return { id: 'start-handle' };
    });
    const { router, transcript } = makeRouter({
      start,
      appendNotice: (_chatId, _viewId, notice) => order.push(`notice:${notice.title}`),
      createCarriedContext: async () => ({
        kind: 'complete',
        context: { prefix: 'deterministic seed' },
      }),
    });

    await router.runAgentTurn('chat-1', 'continue', {
      turnId: 'turn-1',
    });

    expect(order).toEqual(['notice:History carried without compaction', 'provider-start']);
    expect(transcript.notices).toEqual([expect.objectContaining({
      kind: 'notice',
      message: 'Earlier chat history was small enough to carry over as context.',
      detail: { title: 'History carried without compaction' },
    })]);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      carriedContext: { prefix: 'deterministic seed' },
    }));
  });

  it('appends no carryover notice when there is no projectable history', async () => {
    const { router, transcript } = makeRouter({
      conversation: [],
      createCarriedContext: async () => ({ kind: 'no-history' }),
    });

    await router.runAgentTurn('chat-1', 'continue', {
      turnId: 'turn-1',
    });

    expect(transcript.notices).toEqual([]);
  });

  it('does not duplicate a handoff notice when accepted input is replayed', async () => {
    let takeCount = 0;
    const composition = {
      input: inputRow(1, 'continue'),
      prompt: [inputRow(1, 'continue')],
    };
    const { router, start, transcript } = makeRouter({
      composition: () => ({ ...composition, inserted: takeCount++ === 0 }),
      createCarriedContext: async () => ({
        kind: 'complete',
        context: { prefix: 'complete seed' },
      }),
    });
    const options = {
      clientMessageId: 'message-1',
    };

    await router.runAgentTurn('chat-1', 'continue', { ...options, turnId: 'turn-1' });
    await router.runAgentTurn('chat-1', 'continue', { ...options, turnId: 'turn-2' });

    expect(start).toHaveBeenCalledTimes(1);
    expect(transcript.notices).toHaveLength(1);
  });

  it('does not repeat an unchanged carryover notice after provider start fails', async () => {
    let attempt = 0;
    const start = mock(async (request) => {
      attempt += 1;
      if (attempt === 1) throw new Error('provider start failed');
      request.output.emit({
        type: 'session',
        session: {
          agentSessionId: 'native-1',
          nativeSession: { ownerId: 'test', schemaVersion: 1, value: { id: 'native-1' } },
          nativeSeedReceipt: null,
        },
      });
      request.output.emit({ type: 'run-ended', runId: request.runId, outcome: 'finished' });
      return { id: 'start-handle' };
    });
    const { router, transcript } = makeRouter({
      start,
      createCarriedContext: async () => ({
        kind: 'complete',
        context: { prefix: 'complete seed' },
      }),
    });

    await expect(router.runAgentTurn('chat-1', 'first attempt', {
      turnId: 'turn-1',
    })).rejects.toThrow('provider start failed');
    await router.runAgentTurn('chat-1', 'retry', { turnId: 'turn-2' });

    expect(start).toHaveBeenCalledTimes(2);
    expect(transcript.notices).toHaveLength(1);
  });

  it('appends neither notice nor provider request when final admission closes', async () => {
    const admission = new AbortController();
    const { router, start, transcript } = makeRouter({
      createCarriedContext: async () => {
        admission.abort(new Error('handoff stopped'));
        return {
          kind: 'complete',
          context: { prefix: 'complete seed' },
        };
      },
    });

    await expect(router.runAgentTurn('chat-1', 'continue', {
      turnId: 'turn-1',
      executionAdmission: { signal: admission.signal, markStarted: mock() },
    })).rejects.toThrow('handoff stopped');

    expect(start).not.toHaveBeenCalled();
    expect(transcript.notices).toEqual([]);
  });

  it('does not invoke the provider when the handoff notice cannot commit', async () => {
    const { router, start, transcript } = makeRouter({
      appendNotice: () => { throw new Error('notice commit failed'); },
      createCarriedContext: async () => ({
        kind: 'complete',
        context: { prefix: 'complete seed' },
      }),
    });

    await expect(router.runAgentTurn('chat-1', 'continue', {
      turnId: 'turn-1',
    })).rejects.toThrow('notice commit failed');

    expect(start).not.toHaveBeenCalled();
    expect(transcript.notices).toEqual([]);
  });

  it('fails the begun run with the carryover domain code before provider start', async () => {
    const failure = new DomainError(
      'CARRYOVER_COMPACTION_FAILED',
      'Agent-switch compaction failed after two attempts.',
      502,
      true,
    );
    const { router, start, transcript } = makeRouter({
      createCarriedContext: async () => { throw failure; },
    });
    const failRun = mock(transcript.ledger.failRun.bind(transcript.ledger));
    transcript.ledger.failRun = failRun;

    await expect(router.runAgentTurn('chat-1', 'continue', {
      clientRequestId: 'request-1',
      turnId: 'turn-1',
    })).rejects.toBe(failure);

    expect(failRun).toHaveBeenCalledWith('chat-1', 'turn-1', {
      code: 'CARRYOVER_COMPACTION_FAILED',
      message: failure.message,
    });
    expect(start).not.toHaveBeenCalled();
    expect(transcript.notices).toEqual([]);
    expect(transcript.activeRunId()).toBeNull();
  });

  it('keeps the admitted start configuration through asynchronous carryover planning', async () => {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const { router, start, registry } = makeRouter({
      composition: {
        inserted: true, input: inputRow(1, 'continue'), prompt: [inputRow(1, 'continue')],
      },
      createCarriedContext: async () => {
        entered.resolve();
        await release.promise;
        return { kind: 'complete', context: { prefix: 'synthetic seed' } };
      },
    });
    const pending = router.runAgentTurn('chat-1', 'continue', { clientMessageId: 'message-1', turnId: 'turn-1' });
    await entered.promise;
    registry.updateChat('chat-1', { model: 'synthetic-later-model' });
    release.resolve();
    await pending;
    expect(start.mock.calls[0][0]).toMatchObject({ model: 'model-a', carriedContext: { prefix: 'synthetic seed' } });
    expect(registry.getChat('chat-1').model).toBe('synthetic-later-model');
  });

  it('fails closed when the transcript view changes during carryover planning', async () => {
    let currentView = {
      viewId: 'view-1',
      status: 'current',
      createdAt: '2026-08-12T00:00:00.000Z',
      contentStartOrdinal: 1,
    };
    const { router, start, transcript } = makeRouter({
      composition: {
        inserted: true,
        input: inputRow(1, 'continue'),
        prompt: [inputRow(1, 'continue')],
      },
      currentView: () => currentView,
      createCarriedContext: async () => {
        currentView = { ...currentView, viewId: 'view-2' };
        return {
          kind: 'complete',
          context: { prefix: 'complete seed' },
        };
      },
    });

    await expect(router.runAgentTurn('chat-1', 'continue', {
      clientMessageId: 'message-1',
      turnId: 'turn-1',
    })).rejects.toMatchObject({ code: 'SESSION_BUSY', retryable: true });

    expect(start).not.toHaveBeenCalled();
    expect(transcript.notices).toEqual([]);
  });

  it('resumes without materializing the ledger conversation', async () => {
    const conversationMessages = mock(() => {
      throw new Error('resume must not scan ledger context');
    });
    const { router, resume, transcript } = makeRouter({
      entry: {
        agentSessionId: 'native-1',
        nativeSession: { ownerId: 'test', schemaVersion: 1, value: { id: 'native-1' } },
      },
      conversationMessages,
    });

    await router.runAgentTurn('chat-1', 'resume', { turnId: 'turn-1' });

    expect(conversationMessages).not.toHaveBeenCalled();
    expect(resume.mock.calls[0][0]).not.toHaveProperty('priorContext');
    expect(transcript.notices).toEqual([]);
  });

  it('prepends a private preamble to a resumed provider prompt without changing the adapter contract', async () => {
    const { router, resume } = makeRouter({
      entry: {
        agentSessionId: 'native-1',
        nativeSession: { ownerId: 'test', schemaVersion: 1, value: { id: 'native-1' } },
      },
      composition: {
        inserted: true,
        input: inputRow(1, 'visible'),
        prompt: [inputRow(1, 'visible')],
        providerPrefix: 'private-prefix\n\n',
      },
    });

    await router.runAgentTurn('chat-1', 'fallback', {
      clientMessageId: 'message-1',
      turnId: 'turn-1',
    });

    expect(resume).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'private-prefix\n\nvisible',
    }));
    expect(resume.mock.calls[0][0]).not.toHaveProperty('providerPrefix');
  });

  it.each(['synthetic goal', 'read @notes.txt'])('preserves goal input when mention placement is unavailable: %s', async (prompt) => {
    const serviceFor = mock(() => { throw new DomainError('NODE_UNAVAILABLE', 'Synthetic placement failure', 409); });
    const { router, submitGoalControl } = makeRouter({
      entry: {
        agentSessionId: 'native-1',
        nativeSession: { ownerId: 'test', schemaVersion: 1, value: { id: 'native-1' } },
      },
      resume: mock(async () => ({ id: 'active-handle' })),
      fileMentions: new WorkspaceFileMentionResolver(serviceFor),
    });
    await router.runAgentTurn('chat-1', 'start active run', { turnId: 'turn-1' });
    const signal = new AbortController().signal;
    await expect(router.submitGoalControl('chat-1', prompt,
      { turnId: 'turn-2', executionAdmission: { signal, async markStarted() {} } }, async () => undefined)).resolves.toBe(true);
    expect(submitGoalControl.mock.calls[0][0].prompt).toBe(prompt);
    expect(serviceFor).toHaveBeenCalledTimes(prompt.includes('@') ? 1 : 0);
  });

  it('submits goal control without materializing the ledger conversation', async () => {
    const conversationMessages = mock(() => {
      throw new Error('goal control must not scan ledger context');
    });
    const resume = mock(async () => ({ id: 'active-handle' }));
    const fileMentions = { resolve: mock(async () => 'Synthetic expanded goal.') };
    const { router, submitGoalControl } = makeRouter({
      entry: {
        agentSessionId: 'native-1',
        nativeSession: { ownerId: 'test', schemaVersion: 1, value: { id: 'native-1' } },
      },
      conversationMessages,
      resume,
      fileMentions,
    });
    await router.runAgentTurn('chat-1', 'start active run', { turnId: 'turn-1' });
    fileMentions.resolve.mockClear();
    const signal = new AbortController().signal;

    await expect(router.submitGoalControl(
      'chat-1',
      'update goal',
      { turnId: 'turn-2', executionAdmission: { signal, async markStarted() {} } },
      async () => undefined,
    )).resolves.toBe(true);

    expect(conversationMessages).not.toHaveBeenCalled();
    expect(fileMentions.resolve).toHaveBeenCalledWith('update goal', expect.objectContaining({
      projectPath: projectDir, executionLocation: testExecutionLocation(),
    }), signal);
    expect(submitGoalControl.mock.calls[0][0].prompt).toBe('Synthetic expanded goal.');
    expect(submitGoalControl.mock.calls[0][0]).not.toHaveProperty('priorContext');
  });

  it('persists one coherent endpoint selection after a lazy start', async () => {
    const { router, registry } = makeRouter({
      entry: {
        model: 'model-a',
        apiProviderId: 'provider-a',
        modelEndpointId: 'endpoint-a',
      },
    });

    await router.runAgentTurn('chat-1', 'start with override', {
      model: 'model-b',
      apiProviderId: 'provider-b',
      modelEndpointId: 'endpoint-b',
      turnId: 'turn-1',
    });

    expect(registry.updateChat).toHaveBeenCalledWith('chat-1', expect.objectContaining({
      model: 'model-b',
      apiProviderId: 'provider-b',
      modelEndpointId: 'endpoint-b',
      modelProtocol: 'openai-compatible',
    }));
  });

  it('[TLV5-L09.03-RUNTIME-UNIT-01] resumes without a native-activity scheduling dependency', async () => {
    const order = [];
    const resume = mock(async (request) => {
      order.push('resume');
      request.output.emit({ type: 'run-ended', runId: request.runId, outcome: 'finished' });
      return { id: 'resume-handle' };
    });
    const { router, transcript } = makeRouter({
      entry: {
        agentSessionId: 'native-1',
        nativeSession: { ownerId: 'test', schemaVersion: 1, value: { id: 'native-1' } },
      },
      resume,
    });
    const beginRun = transcript.ledger.beginRun.bind(transcript.ledger);
    transcript.ledger.beginRun = (...args) => {
      order.push('begin');
      return beginRun(...args);
    };

    await router.runAgentTurn('chat-1', 'resume', { turnId: 'turn-1' });

    expect(order).toEqual(['begin', 'resume']);
  });

  it('rejects a local-to-cloud override before provider dispatch', async () => {
    const { router, start, endpointResolver } = makeRouter({
      entry: {
        model: 'local-model',
        apiProviderId: 'local-provider',
        modelEndpointId: 'local-endpoint',
      },
    });
    endpointResolver.resolveSelection.mockImplementation((request) => ({
      model: request.model,
      apiProviderId: request.apiProviderId ?? null,
      endpointId: request.modelEndpointId ?? null,
      protocol: request.apiProviderId ? 'openai-compatible' : null,
      isLocal: request.apiProviderId === 'local-provider',
    }));

    await expect(router.runAgentTurn('chat-1', 'do not dispatch', {
      model: 'cloud-model',
      apiProviderId: 'cloud-provider',
      modelEndpointId: 'cloud-endpoint',
    })).rejects.toThrow('Cannot switch from local to cloud model mid-session');
    expect(start).not.toHaveBeenCalled();
  });

  it('does not invoke a producer after execution admission closes', async () => {
    const admission = new AbortController();
    admission.abort(new Error('server is shutting down'));
    const { router, start } = makeRouter();

    await expect(router.startSession('chat-1', 'do not start', {
      executionAdmission: { signal: admission.signal, markStarted: mock() },
    })).rejects.toThrow('server is shutting down');
    expect(start).not.toHaveBeenCalled();
  });

  it('routes steering through its facet without replacing the active run', async () => {
    const activeTurn = {
      agentOwnershipEpoch: 'epoch-1',
      clientRequestId: 'request-active',
      commandType: 'agent-run',
      turnId: 'turn-active',
      turnOwner: {
        agentOwnershipEpoch: 'epoch-1',
        commandType: 'agent-run',
        clientRequestId: 'request-active',
        turnId: 'turn-active',
      },
    };
    const { router, events, captureTarget, providerTarget, steer } = makeRouter({
      entry: { agentSessionId: 'native-1' },
      activeTurn,
      resume: mock(async () => ({})),
    });
    await router.runAgentTurn('chat-1', 'synthetic input', { turnId: 'turn-active', clientRequestId: 'request-active' });
    const prepareDelivery = mock(async () => undefined);
    const target = router.captureSteerTarget('chat-1');
    await router.prepareSteerTarget('chat-1', target);

    await expect(router.steerInput('chat-1', 'guidance', {
      clientRequestId: 'request-steer',
      clientMessageId: 'message-steer',
    }, target, prepareDelivery)).resolves.toEqual({ kind: 'accepted' });

    expect(captureTarget).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 'chat-1',
      agentSessionId: 'native-1',
    }));
    expect(steer).toHaveBeenCalledWith(expect.objectContaining({
      target: providerTarget,
      input: 'guidance',
      prepareDelivery: expect.any(Function),
    }));
    expect(events.handoffTurn).not.toHaveBeenCalled();
    expect(events.getActiveTurn()).toEqual(activeTurn);
  });

  it('replaces the producer capability before the next run', async () => {
    const sinks = [];
    const start = mock(async (request) => {
      sinks.push(request.output);
      request.output.emit({ type: 'run-ended', runId: request.runId, outcome: 'finished' });
      return { id: `handle-${sinks.length}` };
    });
    const { router } = makeRouter({ start });

    await router.runAgentTurn('chat-1', 'first', { turnId: 'turn-1' });
    router.reopenProducer('chat-1');

    expect(() => sinks[0].emit({ type: 'rows', rows: [] })).toThrow('sink closed');
    await router.runAgentTurn('chat-1', 'second', { turnId: 'turn-2' });
    expect(sinks[1]).not.toBe(sinks[0]);
  });
});

function instanceConfiguration(id, isDefault) {
  return {
    id,
    nodeId: 'test-local-node',
    agentId: 'test',
    label: id,
    storageNamespace: id,
    default: isDefault,
    removedAt: null,
  };
}

function inputRow(ordinal, content) {
  const message = new UserMessage('2026-08-12T00:00:00.000Z', content);
  return {
    kind: 'user-input',
    viewId: 'view-1',
    ordinal,
    at: message.timestamp,
    detail: {
      clientMessageId: `message-${ordinal}`,
      message,
      attachments: [],
      steer: false,
    },
    providerMeta: null,
  };
}
