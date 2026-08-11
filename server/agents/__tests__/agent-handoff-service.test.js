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

function projectedIntegrations({ outgoing, incoming, calls = [] }) {
  const source = {
    ...integration('source-agent'),
    transcript: {
      prepareHandoffLease: mock(async () => {
        calls.push('outgoing-prepare');
        return { kind: 'ready', value: outgoing };
      }),
    },
  };
  const targetAgent = {
    ...integration('target-agent'),
    transcript: {
      prepareOwnershipSegment: mock(async () => {
        calls.push('incoming-prepare');
        return { kind: 'ready', value: incoming };
      }),
    },
  };
  const byId = new Map([
    ['source-agent', source],
    ['target-agent', targetAgent],
  ]);
  return {
    get: (agentId) => byId.get(agentId),
    require: (agentId) => {
      const value = byId.get(agentId);
      if (!value) throw new Error(`Missing integration: ${agentId}`);
      return value;
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

  it('decides once between a sealed outgoing lease and participant activation', async () => {
    const current = sourceChat();
    const calls = [];
    const sourceCheckpoint = checkpoint('source-epoch', 'source-content', 1);
    const incomingCheckpoint = checkpoint('target-epoch', 'target-content', 0);
    const outgoing = {
      operationId: 'unused',
      frozen: {
        checkpoint: sourceCheckpoint,
        entries: [entry('source-entry', new UserMessage(timestamp, 'captured'))],
      },
      sealForDecision: mock(() => { calls.push('seal'); return {}; }),
      commitAfterDecision: mock(async () => { calls.push('outgoing-commit'); }),
      rollbackBeforeDecision: mock(async () => { calls.push('outgoing-rollback'); }),
    };
    const incoming = {
      checkpoint: incomingCheckpoint,
      commitAfterDecision: mock(async () => { calls.push('incoming-commit'); }),
      rollbackBeforeDecision: mock(async () => { calls.push('incoming-rollback'); }),
    };
    let activeIntent = null;
    const ownership = {
      findHandoff: () => activeIntent,
      beginHandoff: mock(async (input) => {
        calls.push('intent');
        activeIntent = handoffIntent(input, 'target-epoch');
        return activeIntent;
      }),
      stageHandoff: mock(async (input) => {
        calls.push('stage');
        activeIntent = stagedIntent(activeIntent, input);
        return activeIntent;
      }),
      decideHandoff: mock(async () => {
        calls.push('decision');
        activeIntent = { ...activeIntent, phase: 'commit-decided' };
        return { operationId: activeIntent.operationId, targetOwnershipEpoch: 'target-epoch' };
      }),
      applyHandoffDecision: mock(async () => {
        calls.push('registry');
        Object.assign(current, {
          agentId: 'target-agent',
          agentOwnershipEpoch: 'target-epoch',
          agentSessionId: null,
          carryOverSegments: activeIntent.target.carryOverSegments,
        });
      }),
      completeHandoff: mock(async () => { calls.push('complete'); activeIntent = null; }),
      abortHandoff: mock(async () => { calls.push('abort'); activeIntent = null; }),
    };
    const capture = {
      loadStable: mock(async () => { throw new Error('native capture is forbidden'); }),
      assertRevision: mock(async () => { throw new Error('native recheck is forbidden'); }),
    };
    const service = createService({
      registry: { getChat: () => current },
      ownership,
      carryOver,
      capture,
      integrations: projectedIntegrations({ outgoing, incoming, calls }),
    });

    await service.createPreparation({
      chatId: 'chat',
      clientRequestId: 'request-1',
      handoff: handoff(),
      source: current,
      target: target(),
    }).prepare(context());

    expect(calls).toEqual([
      'intent',
      'outgoing-prepare',
      'incoming-prepare',
      'stage',
      'seal',
      'decision',
      'registry',
      'incoming-commit',
      'outgoing-commit',
      'complete',
    ]);
    expect(capture.loadStable).not.toHaveBeenCalled();
    expect(current).toMatchObject({ agentId: 'target-agent', agentOwnershipEpoch: 'target-epoch' });
    expect(await segmentDirectories(workspaceDir)).toHaveLength(1);
  });

  it('rolls back every staged artifact when the outgoing lease becomes dirty before decision', async () => {
    const current = sourceChat();
    const outgoing = {
      frozen: {
        checkpoint: checkpoint('source-epoch', 'source-content', 1),
        entries: [entry('source-entry', new UserMessage(timestamp, 'captured'))],
      },
      sealForDecision: mock(() => { throw new Error('buffered source mutation'); }),
      commitAfterDecision: mock(async () => {}),
      rollbackBeforeDecision: mock(async () => {}),
    };
    const incoming = {
      checkpoint: checkpoint('target-epoch', 'target-content', 0),
      commitAfterDecision: mock(async () => {}),
      rollbackBeforeDecision: mock(async () => {}),
    };
    let activeIntent = null;
    const ownership = ownershipState(() => activeIntent, (value) => { activeIntent = value; });
    const service = createService({
      registry: { getChat: () => current },
      ownership,
      carryOver,
      integrations: projectedIntegrations({ outgoing, incoming }),
    });

    await expect(service.createPreparation({
      chatId: 'chat',
      clientRequestId: 'request-1',
      handoff: handoff(),
      source: current,
      target: target(),
    }).prepare(context())).rejects.toThrow('buffered source mutation');

    expect(ownership.decideHandoff).not.toHaveBeenCalled();
    expect(incoming.rollbackBeforeDecision).toHaveBeenCalledTimes(1);
    expect(outgoing.rollbackBeforeDecision).toHaveBeenCalledTimes(1);
    expect(ownership.abortHandoff).toHaveBeenCalledTimes(1);
    expect(await segmentDirectories(workspaceDir)).toEqual([]);
  });

  it('rolls forward a previously decided intent without recapturing the source', async () => {
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
    let existing = stagedIntent(handoffIntent({
      operationId: 'existing-operation',
      clientRequestId: 'request-1',
      submittedTargetHash: hashTarget(handoff()),
      chatId: 'chat',
      source: current,
      target: target(),
      targetCarryOverSegments: targetSegments,
    }, 'target-epoch'), {
      targetCarryOverSegments: targetSegments,
      sourceCheckpoint: checkpoint('source-epoch', 'source-content', 1),
      incomingCheckpoint: checkpoint('target-epoch', 'target-content', 0),
    });
    existing = { ...existing, phase: 'commit-decided' };
    const capture = {
      loadStable: mock(async () => { throw new Error('unexpected capture'); }),
      assertRevision: mock(async () => {}),
    };
    const applyHandoffDecision = mock(async () => {
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
      capture,
      ownership: {
        findHandoff: () => existing,
        beginHandoff: mock(async () => { throw new Error('unexpected begin'); }),
        decideHandoff: mock(async () => ({
          operationId: existing.operationId,
          targetOwnershipEpoch: existing.target.agentOwnershipEpoch,
        })),
        applyHandoffDecision,
        completeHandoff: mock(async () => {}),
      },
      integrations: projectedIntegrations({
        outgoing: null,
        incoming: {
          checkpoint: existing.staging.incomingCheckpoint,
          commitAfterDecision: mock(async () => {}),
          rollbackBeforeDecision: mock(async () => {}),
        },
      }),
    });
    const preparation = service.createPreparation({
      chatId: 'chat',
      clientRequestId: 'request-1',
      handoff: handoff(),
      source: current,
      target: target(),
    });

    await preparation.prepare(context());

    expect(capture.loadStable).not.toHaveBeenCalled();
    expect(applyHandoffDecision).toHaveBeenCalledWith('existing-operation');
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
    const service = createService({
      registry,
      carryOver,
      ownership: {
        findHandoff: () => existing,
        beginHandoff: mock(async () => {}),
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
    expect(current.agentId).toBe('source-agent');
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
  capture,
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
    capture: capture ?? {
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
    version: 4,
    operationId: input.operationId,
    clientRequestId: input.clientRequestId,
    submittedTargetHash: input.submittedTargetHash,
    kind: 'handoff',
    chatId: input.chatId,
    phase: 'intent',
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
      reference: {
        chatId: input.chatId,
        agentId: input.source.agentId,
        agentSessionId: input.source.agentSessionId,
        projectPath: input.source.projectPath,
        model: input.source.model,
        nativeSession: input.source.nativeSession,
        carryOverRevision: carryOverRevision(input.source.carryOverSegments),
        nativeSeedReceipt: input.source.nativeSeedReceipt,
        settings: input.source.agentSettingsById[input.source.agentId],
        agentOwnershipEpoch: input.source.agentOwnershipEpoch,
      },
    },
    target: {
      execution: input.target,
      agentOwnershipEpoch: targetEpoch,
      carryOverSegments: input.targetCarryOverSegments ?? [],
    },
    staging: null,
    createdAt: timestamp,
  };
}

function stagedIntent(intent, staging) {
  return {
    ...intent,
    phase: 'staged',
    target: {
      ...intent.target,
      carryOverSegments: staging.targetCarryOverSegments,
    },
    staging: {
      sourceCheckpoint: staging.sourceCheckpoint,
      incomingCheckpoint: staging.incomingCheckpoint,
    },
  };
}

function ownershipState(getIntent, setIntent) {
  return {
    findHandoff: () => getIntent(),
    beginHandoff: mock(async (input) => {
      const intent = handoffIntent(input, 'target-epoch');
      setIntent(intent);
      return intent;
    }),
    stageHandoff: mock(async (input) => {
      const intent = stagedIntent(getIntent(), input);
      setIntent(intent);
      return intent;
    }),
    decideHandoff: mock(async () => {
      const intent = { ...getIntent(), phase: 'commit-decided' };
      setIntent(intent);
      return { operationId: intent.operationId, targetOwnershipEpoch: intent.target.agentOwnershipEpoch };
    }),
    applyHandoffDecision: mock(async () => {}),
    completeHandoff: mock(async () => setIntent(null)),
    abortHandoff: mock(async () => setIntent(null)),
  };
}

function checkpoint(agentOwnershipEpoch, contentEpoch, total) {
  return {
    chatId: 'chat',
    agentOwnershipEpoch,
    offset: '0',
    projection: {
      epoch: `${agentOwnershipEpoch}-stream`,
      contentEpoch,
      total,
      durableCount: total,
      durableRevision: `revision-${total}`,
      stateRevision: `state-${total}`,
    },
  };
}

function entry(id, message) {
  return {
    id,
    lifetime: 'durable',
    source: { namespace: 'fixture', itemId: id, subrowId: 'message' },
    provenance: null,
    message,
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
