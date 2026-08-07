import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UserMessage } from '../../../common/chat-types.js';
import { AgentHandoffService } from '../agent-handoff-service.ts';
import { CarryOverTranscriptStore } from '../../chats/carryover-transcript-store.ts';
import { carryOverRevision } from '../../chats/carryover-segments.ts';

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
    carryOverSegments: [],
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

  it('preserves a committed segment when the journal fails after mutating the live registry entry', async () => {
    const current = sourceChat();
    const registry = { getChat: () => current };
    let targetSegments;
    const ownership = {
      findHandoff: () => null,
      beginHandoff: mock(async (input) => {
        targetSegments = input.targetCarryOverSegments;
        return handoffIntent(input, 'target-epoch');
      }),
      commitHandoff: mock(async () => {
        Object.assign(current, {
          agentId: 'target-agent',
          agentOwnershipEpoch: 'target-epoch',
          agentSessionId: null,
          carryOverSegments: targetSegments,
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
      carryOverSegments: targetSegments,
    });
    await expect(carryOver.readIndex(targetSegments[0].id)).resolves.toMatchObject({
      id: targetSegments[0].id,
    });
  });

  it('detects source ownership changes after native capture with a stable snapshot fence', async () => {
    const current = sourceChat();
    const registry = { getChat: () => current };
    const beginHandoff = mock(async (input) => handoffIntent(input, 'target-epoch'));
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
    expect(beginHandoff).toHaveBeenCalledTimes(1);
    expect(await segmentDirectories(workspaceDir)).toEqual([]);
  });

  it('resumes an existing prepared intent without recapturing or writing another segment', async () => {
    const current = sourceChat();
    const registry = { getChat: () => current };
    const segmentId = '7f1bb17c-0cc5-4a0d-b762-2c14b04c5f2e';
    const prepared = await carryOver.prepareSegment({
      operationId: 'existing-operation',
      id: segmentId,
      seedSanitation: 'not-applicable',
      messages: [new UserMessage(timestamp, 'captured')],
    });
    await prepared.commit();
    prepared.releaseRoot();
    const targetSegments = [{
      id: segmentId,
      agentId: 'source-agent',
      model: 'source-model',
      capturedAt: timestamp,
      storedMessageCount: 1,
      visibleMessageCount: 1,
      trailingHandoff: { agentId: 'target-agent', model: 'target-model' },
    }];
    const existing = handoffIntent({
      operationId: 'existing-operation',
      clientRequestId: 'request-1',
      submittedTargetHash: hashTarget(handoff()),
      chatId: 'chat',
      source: current,
      target: target(),
      targetCarryOverSegments: targetSegments,
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
        carryOverSegments: targetSegments,
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
    expect(await segmentDirectories(workspaceDir)).toEqual([segmentId]);
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
      targetCarryOverSegments: [],
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

  it('rejects quarantined history before resolving or preparing a handoff', async () => {
    const current = {
      ...sourceChat(),
      carryOverMigrationQuarantine: {
        artifactId: 'legacy-artifact',
        errorCode: 'INVALID_CARRYOVER_ENTRY',
      },
    };
    const beginHandoff = mock(async () => { throw new Error('unexpected begin'); });
    const service = createService({
      registry: { getChat: () => current },
      carryOver,
      ownership: {
        findHandoff: () => null,
        beginHandoff,
        commitHandoff: mock(async () => {}),
        compensateHandoff: mock(async () => {}),
      },
      ...targetResolutionDeps(),
    });

    await expect(service.resolveTarget({
      chat: current,
      handoff: handoff(),
    })).rejects.toMatchObject({
      code: 'CARRYOVER_HISTORY_UNAVAILABLE',
      status: 422,
      retryable: false,
    });

    const preparation = service.createPreparation({
      chatId: 'chat',
      clientRequestId: 'request-quarantined',
      handoff: handoff(),
      source: current,
      target: target(),
    });
    await expect(preparation.prepare(context())).rejects.toMatchObject({
      code: 'CARRYOVER_HISTORY_UNAVAILABLE',
      status: 422,
    });
    expect(beginHandoff).not.toHaveBeenCalled();
  });

  it('requires an explicit target bypass mode under the CLI fallback policy', async () => {
    const current = sourceChat();
    const service = createService({
      registry: { getChat: () => current },
      carryOver,
      ...targetResolutionDeps({ permissionModes: ['bypassPermissions'] }),
    });
    const request = handoff();
    delete request.target.permissionMode;

    await expect(service.resolveTarget({
      chat: current,
      handoff: request,
      permissionFallbackPolicy: 'require-explicit-bypass',
    })).rejects.toMatchObject({
      code: 'EXPLICIT_BYPASS_REQUIRED',
      status: 422,
    });

    request.target.permissionMode = 'bypassPermissions';
    await expect(service.resolveTarget({
      chat: current,
      handoff: request,
      permissionFallbackPolicy: 'require-explicit-bypass',
    })).resolves.toMatchObject({
      agentId: 'target-agent',
      permissionMode: 'bypassPermissions',
      agentSettings: envelope('target-agent'),
    });
  });

  it('validates target settings without requiring valid source execution settings', async () => {
    const current = {
      ...sourceChat(),
      agentSettingsById: {},
    };
    const service = createService({
      registry: { getChat: () => current },
      carryOver,
      ...targetResolutionDeps(),
    });

    await expect(service.resolveTarget({
      chat: current,
      handoff: handoff(),
    })).resolves.toMatchObject({
      agentId: 'target-agent',
      model: 'target-model',
      agentSettings: envelope('target-agent'),
    });

    const invalid = handoff();
    invalid.target.agentSettings = envelope('source-agent');
    await expect(service.resolveTarget({
      chat: current,
      handoff: invalid,
    })).rejects.toMatchObject({
      code: 'INCOMPLETE_EXECUTION_CONFIG',
      status: 422,
    });
  });
});

function createService({
  registry,
  ownership,
  carryOver,
  settledCapture,
  integrations: integrationRegistry,
  endpointResolver,
  catalog,
} = {}) {
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
    integrations: integrationRegistry ?? { get: (agentId) => integrations.get(agentId) },
    endpointResolver: endpointResolver ?? {},
    catalog: catalog ?? {},
  });
}

function targetResolutionDeps({ permissionModes = ['default'] } = {}) {
  const integrations = new Map([
    ['source-agent', integration('source-agent')],
    ['target-agent', integration('target-agent')],
  ]);
  return {
    integrations: { get: (agentId) => integrations.get(agentId) },
    endpointResolver: {
      resolveSelection: ({ model }) => ({
        model,
        apiProviderId: null,
        endpointId: null,
        protocol: null,
        isLocal: false,
      }),
      resolveEndpointReference: () => null,
    },
    catalog: {
      getAgentCatalogEntry: async () => ({
        supportedPermissionModes: permissionModes,
        supportedThinkingModes: ['none'],
      }),
    },
  };
}

function handoffIntent(input, targetEpoch) {
  return {
    version: 3,
    operationId: input.operationId,
    clientRequestId: input.clientRequestId,
    submittedTargetHash: input.submittedTargetHash,
    kind: 'handoff',
    chatId: input.chatId,
    phase: 'segment-prepared',
    source: {
      agentId: input.source.agentId,
      model: input.source.model,
      sessionId: input.source.agentSessionId,
      agentOwnershipEpoch: input.source.agentOwnershipEpoch,
      carryOverRevision: carryOverRevision(
        input.source.carryOverSegments,
        input.source.carryOverMigrationQuarantine,
      ),
      nativeSeedReceipt: input.source.nativeSeedReceipt,
      reference: {},
    },
    target: {
      execution: input.target,
      agentOwnershipEpoch: targetEpoch,
      carryOverSegments: input.targetCarryOverSegments,
    },
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

async function segmentDirectories(workspaceDir) {
  return (await fs.readdir(path.join(workspaceDir, 'carryover-transcripts', 'segments'))).sort();
}
