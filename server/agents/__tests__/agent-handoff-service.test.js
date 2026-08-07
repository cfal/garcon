import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UserMessage } from '../../../common/chat-types.js';
import { AgentHandoffService } from '../agent-handoff-service.ts';
import { CarryOverTranscriptStore } from '../../chats/carryover-transcript-store.ts';

const timestamp = '2026-01-01T00:00:00.000Z';

function envelope(ownerId) {
  return { ownerId, schemaVersion: 1, values: {} };
}

function sourceChat() {
  return {
    agentId: 'source-agent',
    agentSessionId: 'source-session',
    nativeSession: null,
    nativeSeedReceipt: null,
    carryOverHeadId: null,
    carryOverMigrationQuarantine: null,
    agentOwnershipEpoch: 'source-epoch',
    agentSettingsById: { 'source-agent': envelope('source-agent') },
    projectPath: '/workspace/project',
    tags: [],
    model: 'source-model',
    apiProviderId: null,
    modelEndpointId: null,
    modelProtocol: null,
    permissionMode: 'default',
    thinkingMode: 'none',
  };
}

function target() {
  return {
    agentId: 'target-agent',
    model: 'target-model',
    apiProviderId: null,
    modelEndpointId: null,
    modelProtocol: null,
    permissionMode: 'default',
    thinkingMode: 'none',
    agentSettings: envelope('target-agent'),
  };
}

function handoff(agentId = 'target-agent') {
  return {
    target: {
      agentId,
      model: agentId === 'target-agent' ? 'target-model' : `${agentId}-model`,
      permissionMode: 'default',
      thinkingMode: 'none',
      agentSettings: envelope(agentId),
    },
    expectedAgentOwnershipEpoch: 'source-epoch',
  };
}

function integration(agentId) {
  return {
    descriptor: { id: agentId },
    settings: {
      defaults: () => envelope(agentId),
      parse: (value) => value,
    },
  };
}

function context() {
  return {
    signal: new AbortController().signal,
    assertAdmissionActive: mock(() => {}),
  };
}

describe('AgentHandoffService', () => {
  let workspaceDir;
  let carryOver;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-handoff-service-'));
    carryOver = new CarryOverTranscriptStore({ workspaceDir });
    await carryOver.initialize();
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it('preserves a committed node when the journal fails after mutating the live registry entry', async () => {
    const current = sourceChat();
    const registry = { getChat: () => current };
    let targetHeadId;
    const ownership = {
      findHandoff: () => null,
      beginHandoff: mock(async (input) => {
        targetHeadId = input.targetHistoryHeadId;
        return handoffIntent(input, 'target-epoch');
      }),
      commitHandoff: mock(async () => {
        Object.assign(current, {
          agentId: 'target-agent',
          agentOwnershipEpoch: 'target-epoch',
          agentSessionId: null,
          carryOverHeadId: targetHeadId,
        });
        throw new Error('journal follow-up write failed');
      }),
      compensateHandoff: mock(async () => {}),
    };
    const service = createService({ registry, ownership, carryOver });
    const preparation = service.createPreparation({
      chatId: 'chat',
      clientRequestId: 'request-1',
      handoff: handoff(),
      source: current,
      target: target(),
    });

    await expect(preparation.prepare(context())).rejects.toThrow('journal follow-up write failed');
    await preparation.compensate();

    expect(current).toMatchObject({
      agentId: 'target-agent',
      agentOwnershipEpoch: 'target-epoch',
      carryOverHeadId: targetHeadId,
    });
    await expect(carryOver.readManifest(targetHeadId)).resolves.toMatchObject({ id: targetHeadId });
  });

  it('detects source ownership changes after native capture with a stable snapshot fence', async () => {
    const current = sourceChat();
    const registry = { getChat: () => current };
    const beginHandoff = mock(async () => { throw new Error('unexpected begin'); });
    const settledCapture = {
      loadStable: mock(async () => {
        current.agentOwnershipEpoch = 'new-owner-epoch';
        return {
          messages: [new UserMessage(timestamp, 'captured')],
          revision: 'native-r1',
        };
      }),
      assertRevision: mock(async () => {}),
    };
    const service = createService({
      registry,
      carryOver,
      settledCapture,
      ownership: {
        findHandoff: () => null,
        beginHandoff,
        commitHandoff: mock(async () => {}),
        compensateHandoff: mock(async () => {}),
      },
    });
    const preparation = service.createPreparation({
      chatId: 'chat',
      clientRequestId: 'request-1',
      handoff: handoff(),
      source: current,
      target: target(),
    });

    await expect(preparation.prepare(context())).rejects.toMatchObject({
      code: 'STALE_CHAT_OWNERSHIP',
      status: 409,
    });
    await preparation.compensate();
    expect(beginHandoff).not.toHaveBeenCalled();
  });

  it('resumes an existing prepared intent without recapturing or writing another node', async () => {
    const current = sourceChat();
    const registry = { getChat: () => current };
    const nodeId = '7f1bb17c-0cc5-4a0d-b762-2c14b04c5f2e';
    const prepared = await carryOver.prepareMaterialized({
      operationId: 'existing-operation',
      id: nodeId,
      parentId: null,
      source: {
        agentId: 'source-agent',
        model: 'source-model',
        nativeSessionId: 'source-session',
        nativeRevision: 'native-r1',
      },
      boundary: {
        kind: 'handoff',
        targetAtCapture: { agentId: 'target-agent', model: 'target-model' },
      },
      seedSanitation: 'not-applicable',
      messages: [new UserMessage(timestamp, 'captured')],
    });
    await prepared.commit();
    prepared.releaseRoot();
    const existing = handoffIntent({
      operationId: 'existing-operation',
      clientRequestId: 'request-1',
      submittedTargetHash: hashTarget(handoff()),
      chatId: 'chat',
      source: current,
      target: target(),
      targetHistoryHeadId: nodeId,
      preparedNodeId: nodeId,
    }, 'target-epoch');
    const settledCapture = {
      loadStable: mock(async () => { throw new Error('unexpected capture'); }),
      assertRevision: mock(async () => {}),
    };
    const commitHandoff = mock(async () => {
      Object.assign(current, {
        agentId: 'target-agent',
        agentOwnershipEpoch: 'target-epoch',
        agentSessionId: null,
        carryOverHeadId: nodeId,
      });
    });
    const service = createService({
      registry,
      carryOver,
      settledCapture,
      ownership: {
        findHandoff: () => existing,
        beginHandoff: mock(async () => { throw new Error('unexpected begin'); }),
        commitHandoff,
        compensateHandoff: mock(async () => {}),
      },
    });
    const preparation = service.createPreparation({
      chatId: 'chat',
      clientRequestId: 'request-1',
      handoff: handoff(),
      source: current,
      target: target(),
    });

    await preparation.prepare(context());

    expect(settledCapture.loadStable).not.toHaveBeenCalled();
    expect(commitHandoff).toHaveBeenCalledWith('existing-operation', expect.any(Function));
    expect(await nodeDirectories(workspaceDir)).toEqual([nodeId]);
  });

  it('rejects a resumed request whose submitted handoff target differs', async () => {
    const current = sourceChat();
    const registry = { getChat: () => current };
    const existing = handoffIntent({
      operationId: 'existing-operation',
      clientRequestId: 'request-1',
      submittedTargetHash: hashTarget(handoff()),
      chatId: 'chat',
      source: current,
      target: target(),
      targetHistoryHeadId: null,
      preparedNodeId: null,
    }, 'target-epoch');
    const commitHandoff = mock(async () => {});
    const service = createService({
      registry,
      carryOver,
      ownership: {
        findHandoff: () => existing,
        beginHandoff: mock(async () => {}),
        commitHandoff,
        compensateHandoff: mock(async () => {}),
      },
    });
    const preparation = service.createPreparation({
      chatId: 'chat',
      clientRequestId: 'request-1',
      handoff: handoff('other-agent'),
      source: current,
      target: {
        ...target(),
        agentId: 'other-agent',
        model: 'other-agent-model',
        agentSettings: envelope('other-agent'),
      },
    });

    await expect(preparation.prepare(context())).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      status: 409,
    });
    expect(commitHandoff).not.toHaveBeenCalled();
  });
});

function createService({ registry, ownership, carryOver, settledCapture } = {}) {
  const integrations = new Map([
    ['source-agent', integration('source-agent')],
    ['target-agent', integration('target-agent')],
  ]);
  return new AgentHandoffService({
    registry,
    ownership,
    carryOver,
    settledCapture: settledCapture ?? {
      loadStable: mock(async () => ({
        messages: [new UserMessage(timestamp, 'captured')],
        revision: 'native-r1',
      })),
      assertRevision: mock(async () => {}),
    },
    integrations: { get: (agentId) => integrations.get(agentId) },
    endpointResolver: {},
    catalog: {},
  });
}

function handoffIntent(input, targetEpoch) {
  return {
    version: 2,
    operationId: input.operationId,
    clientRequestId: input.clientRequestId,
    submittedTargetHash: input.submittedTargetHash,
    kind: 'handoff',
    chatId: input.chatId,
    phase: 'node-prepared',
    source: {
      agentId: input.source.agentId,
      model: input.source.model,
      sessionId: input.source.agentSessionId,
      agentOwnershipEpoch: input.source.agentOwnershipEpoch,
      historyHeadId: input.source.carryOverHeadId,
      nativeSeedReceipt: input.source.nativeSeedReceipt,
      reference: {},
    },
    target: {
      execution: input.target,
      agentOwnershipEpoch: targetEpoch,
      historyHeadId: input.targetHistoryHeadId,
    },
    preparedNodeId: input.preparedNodeId,
    createdAt: timestamp,
  };
}

function hashTarget(request) {
  return crypto.createHash('sha256').update(stableStringify(request.target)).digest('hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}

async function nodeDirectories(workspaceDir) {
  return (await fs.readdir(path.join(workspaceDir, 'carryover-transcripts', 'nodes'))).sort();
}
