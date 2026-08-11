import { afterEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AssistantMessage, UserMessage } from '@garcon/common/chat-types';
import {
  AgentIntegrationError,
  agentOwnershipEpoch,
  type AgentChatReferenceV4,
  type AgentHost,
  type AgentTurnOwnerOperationIdentityV4,
} from '@garcon/server-agent-interface';
import type { AgentNativeEvidenceSource } from '../evidence-source.js';
import {
  AgentProjectionProducerEventChannel,
  projectionProducerMessages,
  type AgentProjectionRuntimeExecution,
} from '../../execution/projection-events.js';
import { createAgentOwnedProjection } from '../owned-projection.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe('AgentOwnedProjection', () => {
  it('persists admission before provider start and attributes later output to a steer', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-owned-projection-'));
    temporaryDirectories.push(directory);
    const events = new AgentProjectionProducerEventChannel();
    let projection!: ReturnType<typeof createAgentOwnedProjection>;
    let providerStarted = false;
    const execution: AgentProjectionRuntimeExecution = {
      async start(request) {
        await request.admission.markStarted();
        const page = await projection.transcript.loadPage({
          chat,
          signal: new AbortController().signal,
          limit: 10,
          beforeOrdinal: null,
          expectedProjection: null,
        });
        expect(page.kind).toBe('ready');
        if (page.kind === 'ready') expect(page.page.entries[0]?.lifetime).toBe('durable');
        providerStarted = true;
        return { agentSessionId: 'session', nativeSession: null, nativeSeedReceipt: null };
      },
      async resume() {},
      async abort() { return true; },
      isRunning() { return providerStarted; },
      runningSessions() { return []; },
      subscribeProjectionEvents(listener) { return events.subscribe(listener); },
    };
    projection = createAgentOwnedProjection({
      ownerId: 'test',
      host: host(directory),
      execution,
      nativeEvidence: emptyNativeEvidence(),
    });
    await projection.transcript.openSegment({ chat, signal: new AbortController().signal });

    const accepted = await projection.transcript.prepareInput({
      chat,
      signal: new AbortController().signal,
      message: new UserMessage(timestamp(), 'initial'),
      operation: ownerOperation,
    });
    await accepted.commit();
    await projection.execution.start({
      chatId: chat.chatId,
      projectPath: chat.projectPath,
      model: chat.model,
      permissionMode: 'default',
      thinkingMode: 'none',
      settings: chat.settings,
      endpoint: null,
      operation: ownerOperation,
      admission: admission(),
      prompt: 'initial',
      attachments: [],
      carriedContext: null,
    });
    expect(providerStarted).toBe(true);

    const steer = {
      ...ownerOperation,
      commandType: 'steer' as const,
      clientRequestId: 'steer-request',
      clientMessageId: 'steer-message',
    };
    const steerInput = await projection.transcript.prepareInput({
      chat,
      signal: new AbortController().signal,
      message: new UserMessage(timestamp(), 'steer'),
      operation: steer,
    });
    await steerInput.commit();
    await projection.deliverSteer(chat.chatId, steer, async () => {
      events.emit({
        type: 'messages',
        chatId: chat.chatId,
        messages: projectionProducerMessages('test', [
          new AssistantMessage(timestamp(), 'after steer'),
        ]),
        operation: ownerOperation,
      });
      return { kind: 'accepted' };
    });
    await projection.runTracked(chat.chatId, ownerOperation, async () => {});

    const page = await projection.transcript.loadPage({
      chat,
      signal: new AbortController().signal,
      limit: 10,
      beforeOrdinal: null,
      expectedProjection: null,
    });
    expect(page.kind).toBe('ready');
    if (page.kind !== 'ready') return;
    const output = page.page.entries.find((entry) => (
      entry.message.type === 'assistant-message' && entry.message.content === 'after steer'
    ));
    expect(output?.provenance?.clientRequestId).toBe('steer-request');
    expect(output?.provenance?.turnOwner).toEqual(ownerOperation.turnOwner);
  });

  it('withholds terminal success when the settled boundary cannot prove settlement', async () => {
    const cases: readonly {
      readonly label: string;
      readonly settlement?: 'confirmed' | 'unresolved';
      readonly evidenceFailure?: Error;
      readonly evidenceDegraded?: boolean;
      readonly expectSuccess: boolean;
    }[] = [
      { label: 'confirmed settlement', settlement: 'confirmed', expectSuccess: true },
      { label: 'unresolved settlement', settlement: 'unresolved', expectSuccess: false },
      {
        label: 'audit failure',
        settlement: 'confirmed',
        evidenceFailure: new Error('evidence store offline'),
        expectSuccess: false,
      },
      // A hook-less provider requires the evidence audit itself to complete.
      { label: 'hook-less audit completes', expectSuccess: true },
      {
        label: 'hook-less audit degraded',
        evidenceDegraded: true,
        expectSuccess: false,
      },
    ];
    for (const testCase of cases) {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-owned-projection-'));
      temporaryDirectories.push(directory);
      const events = new AgentProjectionProducerEventChannel();
      const settlementCalls: string[] = [];
      let boundaryArmed = false;
      const execution: AgentProjectionRuntimeExecution = {
        async start(request) {
          await request.admission.markStarted();
          return { agentSessionId: 'session', nativeSession: null, nativeSeedReceipt: null };
        },
        async resume() {},
        async abort() { return true; },
        isRunning() { return false; },
        runningSessions() { return []; },
        subscribeProjectionEvents(listener) { return events.subscribe(listener); },
      };
      const projection = createAgentOwnedProjection({
        ownerId: 'test',
        host: host(directory),
        execution,
        nativeEvidence: {
          ...emptyNativeEvidence(),
          async load() {
            settlementCalls.push('evidence');
            if (boundaryArmed && testCase.evidenceFailure) throw testCase.evidenceFailure;
            if (boundaryArmed && testCase.evidenceDegraded) {
              throw new AgentIntegrationError('TRANSCRIPT_UNAVAILABLE', 'degraded evidence', true);
            }
            return { messages: [] };
          },
        },
        ...(testCase.settlement
          ? {
              sourceSettlement: async () => {
                settlementCalls.push('settlement');
                return { kind: 'ready' as const, value: { verdict: testCase.settlement! } };
              },
            }
          : {}),
      });
      await projection.transcript.openSegment({ chat, signal: new AbortController().signal });
      const accepted = await projection.transcript.prepareInput({
        chat,
        signal: new AbortController().signal,
        message: new UserMessage(timestamp(), 'initial'),
        operation: ownerOperation,
      });
      await accepted.commit();
      const terminals: Array<{ outcome: string; sourceSettlement: string }> = [];
      projection.transcript.subscribe((event) => {
        if (event.kind === 'terminal') {
          terminals.push({
            outcome: event.outcome.kind,
            sourceSettlement: event.sourceSettlement,
          });
        }
      });
      // Genesis bootstrap read happens at open; only the settled boundary
      // reads below.
      settlementCalls.length = 0;
      boundaryArmed = true;
      await projection.runTracked(chat.chatId, ownerOperation, async () => {
        events.emit({
          type: 'finished',
          chatId: chat.chatId,
          exitCode: 0,
          operation: ownerOperation,
        });
      });

      expect({ label: testCase.label, terminals }).toEqual({
        label: testCase.label,
        terminals: [testCase.expectSuccess
          ? { outcome: 'finished', sourceSettlement: 'confirmed' }
          : { outcome: 'failed', sourceSettlement: 'unresolved' }],
      });
      if (!testCase.evidenceFailure && !testCase.evidenceDegraded) {
        // The provider persistence proof runs first; the audited evidence is
        // read at or after that proof.
        expect(settlementCalls).toEqual(
          testCase.settlement ? ['settlement', 'evidence'] : ['evidence'],
        );
      }
    }
  });
});

const ownershipEpoch = agentOwnershipEpoch('ownership');
const turnOwner = {
  agentOwnershipEpoch: ownershipEpoch,
  commandType: 'agent-run' as const,
  clientRequestId: 'owner-request',
  turnId: 'turn',
};
const ownerOperation: AgentTurnOwnerOperationIdentityV4 = {
  ...turnOwner,
  clientMessageId: 'owner-message',
  turnOwner,
};
const chat: AgentChatReferenceV4 = {
  chatId: 'chat',
  agentId: 'test',
  agentSessionId: 'session',
  projectPath: '/tmp',
  model: 'model',
  nativeSession: null,
  carryOverRevision: '',
  nativeSeedReceipt: null,
  settings: { ownerId: 'test', schemaVersion: 1, values: {} },
  agentOwnershipEpoch: ownershipEpoch,
};

function timestamp(): string {
  return '2026-01-01T00:00:00.000Z';
}

function admission() {
  return {
    signal: new AbortController().signal,
    async markStarted() {},
    markAbortable() {},
  };
}

function host(directory: string): AgentHost {
  return {
    agentId: 'test',
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    storage: {
      rootDirectory: directory,
      directory: async () => directory,
      claimLegacyWorkspaceDirectory: async () => ({ moved: 0, skipped: 0 }),
    },
    environment: { get: () => undefined },
    apiProviders: { resolveCredential: async () => null },
  };
}

function emptyNativeEvidence(): AgentNativeEvidenceSource {
  return {
    async resolveNativeSession() { return null; },
    async load() { return { messages: [] }; },
    async describeSource() { return null; },
    async release() {},
  };
}
