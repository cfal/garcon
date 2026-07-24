import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { UserMessage } from '../../../common/chat-types.js';
import { AgentRuntimeRouter } from '../runtime-router.ts';

let projectDir;

const terminalHandoff = () => ({
  validate: () => undefined,
  commit: () => undefined,
});

function makeRouter(overrides = {}) {
  const settings = { ownerId: 'test', schemaVersion: 1, values: {} };
  const entry = {
    id: 'chat-1',
    agentId: 'test',
    agentSessionId: null,
    nativeSession: null,
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
  const start = overrides.start ?? mock(async () => ({
    agentSessionId: 'native-1',
    nativeSession: { ownerId: 'test', schemaVersion: 1, value: { id: 'native-1' } },
  }));
  const resume = overrides.resume ?? mock(async () => undefined);
  const submitActiveInput = overrides.submitActiveInput ?? mock(async () => true);
  const integration = {
    descriptor: {
      id: 'test',
      supportedPermissionModes: ['default'],
      supportedThinkingModes: ['none'],
    },
    execution: { start, resume, submitActiveInput, isRunning: () => false, runningSessions: () => [] },
    settings: { defaults: () => settings, parse: (input) => input },
  };
  const registry = {
    getChat: mock(() => entry),
    updateChat: mock(async (_chatId, patch) => Object.assign(entry, patch)),
    getChatByAgentSessionId: mock(() => null),
  };
  let activeTurn = overrides.activeTurn;
  const events = {
    trackTurn: mock((_chatId, turn) => {
      if (activeTurn && activeTurn.turnId !== turn.turnId) throw new Error('active turn changed');
      activeTurn = turn;
    }),
    handoffTurn: mock((_chatId, predecessor, successor, downstream) => {
      const validate = () => {
        if (activeTurn?.turnId !== predecessor?.turnId) throw new Error('active turn changed');
      };
      validate();
      return {
        validate: () => {
          validate();
          downstream.validate();
        },
        commit: () => {
          activeTurn = successor;
          downstream.commit();
        },
      };
    }),
    clearTurn: mock(() => { activeTurn = undefined; }),
    getActiveTurn: mock(() => activeTurn),
    markTurnAbortable: mock(() => undefined),
  };
  const carryOver = overrides.carryOver ?? [
    new UserMessage('2026-07-18T00:00:00.000Z', 'carried context'),
  ];
  const router = new AgentRuntimeRouter({
    registry,
    directory: {
      require: mock(() => integration),
      get: mock(() => integration),
      list: mock(() => [integration]),
    },
    endpointResolver: {
      resolveSelection: mock((request) => ({
        model: request.model,
        apiProviderId: null,
        endpointId: null,
        protocol: null,
        isLocal: false,
      })),
      resolveEndpointReference: mock(() => null),
    },
    events,
    getCarryOverRevision: () => 'carry-1',
    loadCarryOver: () => carryOver,
  });
  return { router, start, resume, submitActiveInput, registry, events, carryOver };
}

describe('AgentRuntimeRouter fresh-session boundary', () => {
  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-runtime-router-'));
    await fs.writeFile(path.join(projectDir, 'notes.txt'), 'USER FILE BODY');
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('passes canonical carry-over separately from the resolved user prompt', async () => {
    const { router, start, carryOver } = makeRouter();

    await router.runAgentTurn('chat-1', 'review @notes.txt', {
      clientRequestId: 'request-1',
      clientMessageId: 'message-1',
      turnId: 'turn-1',
    });

    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('USER FILE BODY'),
      carryOver,
      operation: {
        commandType: 'agent-run',
        clientRequestId: 'request-1',
        clientMessageId: 'message-1',
        turnId: 'turn-1',
      },
    }));
  });

  it('binds only the opaque native session returned by the integration', async () => {
    const { router, registry } = makeRouter();

    await router.startSession('chat-1', 'start', { turnId: 'turn-1' });

    expect(registry.updateChat).toHaveBeenCalledWith('chat-1', {
      agentSessionId: 'native-1',
      nativeSession: { ownerId: 'test', schemaVersion: 1, value: { id: 'native-1' } },
      apiProviderId: null,
      modelEndpointId: null,
      modelProtocol: null,
    }, { flush: true });
  });

  it('does not invoke an integration after execution admission closes', async () => {
    const admission = new AbortController();
    admission.abort(new Error('server is shutting down'));
    const { router, start } = makeRouter();

    await expect(router.startSession('chat-1', 'do not start', {
      executionAdmission: { signal: admission.signal, markStarted: mock(), markAbortable: mock() },
    })).rejects.toThrow('server is shutting down');
    expect(start).not.toHaveBeenCalled();
  });

  it('keeps a pre-boundary decline from hiding the predecessor terminal or blocking a successor', async () => {
    const predecessor = {
      clientRequestId: 'request-predecessor',
      commandType: 'chat-start',
      turnId: 'turn-predecessor',
    };
    const { router, events, submitActiveInput, resume } = makeRouter({
      entry: { agentSessionId: 'native-1' },
      activeTurn: predecessor,
    });
    submitActiveInput.mockImplementation(async () => {
      events.clearTurn('chat-1');
      return false;
    });

    await expect(router.submitActiveInput('chat-1', 'steer', {
      clientRequestId: 'request-steer',
      turnId: 'turn-steer',
    }, async () => undefined)).resolves.toBe(false);

    expect(events.handoffTurn).not.toHaveBeenCalled();
    await router.runAgentTurn('chat-1', 'successor', {
      clientRequestId: 'request-successor',
      turnId: 'turn-successor',
    });
    expect(resume).toHaveBeenCalledOnce();
  });

  it('keeps a pre-boundary failure from hiding the predecessor terminal or blocking a successor', async () => {
    const predecessor = {
      clientRequestId: 'request-predecessor',
      commandType: 'chat-start',
      turnId: 'turn-predecessor',
    };
    const { router, events, submitActiveInput, resume } = makeRouter({
      entry: { agentSessionId: 'native-1' },
      activeTurn: predecessor,
    });
    submitActiveInput.mockImplementation(async () => {
      events.clearTurn('chat-1');
      throw new Error('delivery failed');
    });

    await expect(router.submitActiveInput('chat-1', 'steer', {
      clientRequestId: 'request-steer',
      turnId: 'turn-steer',
    }, async () => undefined)).rejects.toThrow('delivery failed');

    expect(events.handoffTurn).not.toHaveBeenCalled();
    await router.runAgentTurn('chat-1', 'successor', {
      clientRequestId: 'request-successor',
      turnId: 'turn-successor',
    });
    expect(resume).toHaveBeenCalledOnce();
  });

  it('retains successor metadata after a post-boundary delivery failure', async () => {
    const predecessor = {
      clientRequestId: 'request-predecessor',
      commandType: 'chat-start',
      turnId: 'turn-predecessor',
    };
    const { router, events, submitActiveInput } = makeRouter({
      entry: { agentSessionId: 'native-1' },
      activeTurn: predecessor,
    });
    submitActiveInput.mockImplementation(async (request) => {
      await request.beforeDelivery(terminalHandoff());
      throw new Error('delivery outcome unknown');
    });

    await expect(router.submitActiveInput('chat-1', 'steer', {
      clientRequestId: 'request-steer',
      turnId: 'turn-steer',
    }, async (handoff) => {
      handoff.validate();
      handoff.commit();
    })).rejects.toThrow('delivery outcome unknown');

    expect(events.getActiveTurn()).toMatchObject({ turnId: 'turn-steer' });
  });
});
