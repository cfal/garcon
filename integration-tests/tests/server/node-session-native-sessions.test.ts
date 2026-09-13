import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { ChatRegistry } from '../../../server/chats/store.js';
import { AgentOwnershipJournal } from '../../../server/chats/agent-ownership-journal.js';
import type { AgentInstanceDirectory } from '../../../server/agents/instance-directory.js';
import type { TranscriptLedgerService } from '../../../server/ledger/service.js';
import { ExecutionNodesStore } from '../../../server/execution-nodes/store.js';
import { resolveNativeSessionCleanup } from '../../../server/execution-nodes/native-session-cleanup.js';
import { DomainError } from '../../../server/lib/domain-error.js';
import { DirectSessionStore } from '../../../server-agents/common/src/direct/session-store.js';
import type { NodeWorkerApplicationFrame } from '../../../server/execution-node/worker/application-protocol.js';
import { NODE_WORKER_SERVICE_LIMITS } from '../../../server/execution-node/worker/limits.js';
import type { NodeProviderNativeCommand } from '../../../server/execution-nodes/transport/provider-native-wire.js';
import type { ProviderNativeSessionRequest } from '../../../server/execution-nodes/provider-native-sessions.js';
import { RemoteProviderNativeSessionService } from '../../../server/execution-nodes/remote-provider-native-sessions.js';
import { createNodeSessionFixture, nodeSessionSystemdAvailable, type ControllerFixtureConnection } from '../../support/node-session-handshake-fixture.js';
import { TlsCertificates, type TestCertificate } from '../../support/tls-certificates.js';

let certificates: TlsCertificates;
let certificate: TestCertificate;
beforeAll(async () => { certificates = await TlsCertificates.create(); certificate = await certificates.selfSigned('native-sessions'); });
afterAll(async () => certificates?.dispose());

const agentId = 'direct-anthropic-compatible';
const sessionId = '00000000-0000-4000-8000-000000000001';
const chatId = '1000000000000000';

describe.skipIf(!nodeSessionSystemdAvailable)('native session services through production workers and WSS', () => {
  test('pending native requests preserve provider status and recovery over WSS', async () => {
    const f = await createNodeSessionFixture(certificate);
    try {
      const controller = await f.controller(await f.connect().ready); await recover(controller);
      const record = await nativeRecord(f, controller, 'synthetic-instance');
      const { projectPath: _projectPath, ...chat } = record.request.chat;
      const allowance = NODE_WORKER_SERVICE_LIMITS.maxProviderRequests - NODE_WORKER_SERVICE_LIMITS.reservedProviderStatusRequests;
      for (const operation of ['resolve', 'describe', 'release'] as const) {
        const native: NodeProviderNativeCommand = { method: 'provider-native-sessions', instanceId: 'synthetic-instance',
          workspaceId: 'synthetic-workspace', chat,
          ...(operation === 'release' ? { operation, reason: 'deleted' } : { operation }) };
        const caller = new AbortController(); const submitted = Promise.withResolvers<void>();
        const budgets: number[] = [];
        const intercept = (frame: NodeWorkerApplicationFrame): boolean => {
          if (frame.type !== 'node-worker-service-request' || frame.command.method !== 'provider-native-sessions') return true;
          budgets.push(frame.timeoutMs); if (budgets.length === allowance) submitted.resolve(); return false;
        };
        f.nodeFrames.add(intercept);
        const pending = Array.from({ length: allowance }, () => controller.client.service.call(native, caller.signal));
        try {
          await submitted.promise;
          expect(budgets.every((budget) => budget > 10_000 && budget <= 60_000)).toBe(true);
          expect(await controller.client.service.call(native, controller.signal)).toEqual({ kind: 'rejected', code: 'NODE_CAPACITY' });
          expect(await controller.client.service.call({ method: 'provider-auth', instanceId: 'synthetic-instance', operation: 'status' },
            controller.signal)).toMatchObject({ kind: 'provider-auth-status' });
          await recover(controller);
          expect(controller.signal.aborted).toBe(false);
        } finally { f.nodeFrames.delete(intercept); caller.abort(); await Promise.all(pending); }
      }
      expect(await record.service.resolve(record.request, controller.signal)).toEqual(chat.nativeSession);
    } finally { await f.dispose(); }
  }, 20_000);

  test('colliding native sessions stay on their owning nodes and lost release replies remain safe to retry exactly', async () => {
    const fixtures = await Promise.all([createNodeSessionFixture(certificate), createNodeSessionFixture(certificate)]);
    try {
      const records = await Promise.all(fixtures.map(async (f) => {
        const connection = await f.connect().ready;
        const controller = await f.controller(connection);
        await recover(controller);
        return nativeRecord(f, controller, 'synthetic-instance');
      }));
      const first = records[0]!;
      const second = records[1]!;
      const deadline = new AbortController();
      const observed = Promise.withResolvers<void>();
      const intercept = (frame: NodeWorkerApplicationFrame): boolean => {
        if (frame.type === 'node-worker-service-result' && frame.result.kind === 'provider-native-result' && frame.result.operation === 'release') {
          observed.resolve(); return false;
        }
        return true;
      };
      first.f.controllerFrames.add(intercept);
      try {
        const result = first.service.release({ ...first.request, reason: 'deleted' }, deadline.signal).catch((error) => error);
        await observed.promise;
        expect(existsSync(path.join(first.rootDirectory, 'direct-sessions-v1', `${sessionId}.jsonl`))).toBe(false);
        expect(await second.service.resolve(second.request, second.controller.signal)).toEqual(second.request.chat.nativeSession);
        deadline.abort(new Error('Synthetic lost cleanup reply'));
        expect(await result).toBe(deadline.signal.reason);
      } finally { first.f.controllerFrames.delete(intercept); }
      await first.service.release({ ...first.request, reason: 'deleted' }, first.controller.signal);
      expect(await second.service.resolve(second.request, second.controller.signal)).toEqual(second.request.chat.nativeSession);
      await expect(first.service.resolve(first.request, first.controller.signal)).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
      const { projectPath: _projectPath, ...chat } = second.request.chat;
      expect(await second.controller.client.service.call({ method: 'provider-native-sessions', operation: 'release',
        instanceId: 'foreign-instance', workspaceId: 'synthetic-workspace',
        chat, reason: 'deleted' }, second.controller.signal)).toMatchObject({ kind: 'rejected' });
    } finally { await Promise.all(fixtures.map((f) => f.dispose())); }
  }, 30_000);

  test('same-node profiles remain isolated while persisted offline deletion is recovered by a new journal', async () => {
    const root = await mkdtemp(path.join(homedir(), 'garcon-native-journal-'));
    const profiles = ['first', 'second'].map((name) => ({ id: `synthetic-${name}`, agentId, label: name,
      homeDirectory: path.join(root, name), environment: {}, workspaceIds: ['synthetic-workspace'], maxOperations: 1 }));
    const f = await createNodeSessionFixture(certificate, certificate.trust, { instances: profiles });
    try {
      const link = f.connect();
      const initial = await link.ready;
      const controller = await f.controller(initial);
      await recover(controller);
      const records = await Promise.all(profiles.map((profile) => nativeRecord(f, controller, profile.id)));
      const selected = records[0]!;
      const sibling = records[1]!;
      const workspaceDir = path.join(root, 'controller');
      await mkdir(workspaceDir);
      await writeFile(path.join(workspaceDir, 'execution-nodes.json'), JSON.stringify({ version: 1,
        localNodeId: 'synthetic-local', nodes: [
          { id: 'synthetic-local', kind: 'local', label: 'Local', removedAt: null },
          { id: f.pairing.nodeId, kind: 'remote', label: 'Node', removedAt: null }],
        instances: profiles.map((profile) => ({ id: profile.id, nodeId: f.pairing.nodeId, agentId,
          label: profile.label, storageNamespace: `instances/${profile.id}`, default: false, removedAt: null })),
        workspaces: [{ id: 'synthetic-workspace', nodeId: f.pairing.nodeId, projectPath: f.storage, removedAt: null }],
      }));
      const nodes = new ExecutionNodesStore(workspaceDir); await nodes.init();
      const location = { nodeId: f.pairing.nodeId, instanceId: profiles[0]!.id, workspaceId: 'synthetic-workspace' };
      const registry = new ChatRegistry(workspaceDir); await registry.init();
      registry.addChat({ id: chatId, agentId, executionLocation: location, projectPath: f.storage, model: 'synthetic-model',
        agentSessionId: sessionId, nativeSession: selected.request.chat.nativeSession,
        agentSettingsById: {}, parentChat: null, preambleSelection: { revision: 0, orderedPreambleIds: [] } });
      await registry.flush();
      let services = new Map(records.map((record, index) => [profiles[index]!.id, record.service]));
      const instances = { nativeSessionsFor(owner) {
        const service = owner.executionLocation.nodeId === f.pairing.nodeId && owner.agentId === agentId
          ? services.get(owner.executionLocation.instanceId) : null;
        if (!service) throw new DomainError('NODE_UNAVAILABLE', 'Synthetic owner offline', 503);
        return service;
      } } satisfies Pick<AgentInstanceDirectory, 'nativeSessionsFor'>;
      const ledger = { deleteChat: mock((_chatId: string) => {}) } satisfies Pick<TranscriptLedgerService, 'deleteChat'>;
      const journal = new AgentOwnershipJournal({ workspaceDir, registry, ledger,
        resolveNativeSessions: (reference) => resolveNativeSessionCleanup(reference, nodes, instances) });
      await journal.initialize();
      link.stop(); await link.closed; services.clear();
      expect(await journal.delete(chatId)).toEqual({ kind: 'ledger-removed' });
      await journal.waitForProviderCleanup();
      expect(registry.getChat(chatId)).toBeNull();
      expect(journal.hasPending(chatId)).toBe(true);
      expect(ledger.deleteChat).toHaveBeenCalledTimes(1);
      expect(existsSync(selected.filePath)).toBe(true);
      const restartedRegistry = new ChatRegistry(workspaceDir); await restartedRegistry.init();
      const restarted = new AgentOwnershipJournal({ workspaceDir, registry: restartedRegistry, ledger,
        resolveNativeSessions: (reference) => resolveNativeSessionCleanup(reference, nodes, instances) });
      await restarted.initialize(); await restarted.waitForProviderCleanup();
      expect(restartedRegistry.getChat(chatId)).toBeNull();
      expect(restarted.hasPending(chatId)).toBe(true);
      f.restartController();
      const current = await f.controller(await f.connect().ready);
      await recover(current);
      services = new Map(profiles.map((profile) => [profile.id, remoteService(f, current, profile.id)]));
      expect(await services.get(profiles[1]!.id)!.resolve(sibling.request, current.signal)).toEqual(sibling.request.chat.nativeSession);
      const pending = restarted.nativeCleanupSnapshot().entries[0]!;
      expect(await restarted.retryNativeCleanup({ chatId, operationId: pending.operationId })).toEqual({ kind: 'scheduled' });
      await restarted.waitForProviderCleanup();
      expect(restarted.hasPending(chatId)).toBe(false);
      expect(existsSync(selected.filePath)).toBe(false);
      expect(existsSync(sibling.filePath)).toBe(true);
      expect(await services.get(profiles[1]!.id)!.resolve(sibling.request, current.signal)).toEqual(sibling.request.chat.nativeSession);
      expect(JSON.parse(await readFile(path.join(workspaceDir, 'agent-ownership-journal.json'), 'utf8')).ownershipIntents).toEqual([]);
      expect(restartedRegistry.getChat(chatId)).toBeNull();
    } finally { await f.dispose(); await rm(root, { recursive: true, force: true }); }
  }, 30_000);

});

async function recover(controller: ControllerFixtureConnection): Promise<void> {
  const recovery = await controller.client.service.call({ method: 'begin-output-recovery' }, controller.signal);
  if (recovery.kind !== 'output-recovery') throw new Error('Synthetic native recovery did not begin');
  await controller.client.service.call({ method: 'replay-output', generation: recovery.generation, cursors: [] }, controller.signal);
  expect(await controller.client.service.call({ method: 'resume-output', generation: recovery.generation }, controller.signal))
    .toEqual({ kind: 'output-live', live: true });
}


type NativeFixture = Awaited<ReturnType<typeof createNodeSessionFixture>>;

function remoteService(f: NativeFixture, controller: ControllerFixtureConnection, instanceId: string) {
  return new RemoteProviderNativeSessionService(controller.client.service,
    { nodeId: f.pairing.nodeId, instanceId }, (projectPath) => projectPath === f.storage
      ? { nodeId: f.pairing.nodeId, workspaceId: 'synthetic-workspace' } : null);
}

async function nativeRecord(f: NativeFixture, controller: ControllerFixtureConnection, instanceId: string) {
  const rootDirectory = path.join(f.storage, 'agent-data', 'instances', instanceId);
  const store = new DirectSessionStore({ host: { agentId, storage: {
    rootDirectory,
    async directory(namespace) {
      const directory = path.join(rootDirectory, namespace);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      return directory;
    },
    async claimLegacyWorkspaceDirectory() { return { moved: 0, skipped: 0 }; },
  } } });
  await store.create({ sessionId, runId: 'synthetic-run', content: 'synthetic native input', attachments: [] });
  const request: ProviderNativeSessionRequest = { chat: { chatId, agentId, agentSessionId: sessionId,
    projectPath: f.storage, model: '', nativeSession: store.nativeReference(sessionId), carryOverRevision: '',
    nativeSeedReceipt: null, settings: null } };
  const service = remoteService(f, controller, instanceId);
  const filePath = path.join(rootDirectory, 'direct-sessions-v1', `${sessionId}.jsonl`);
  expect(await service.resolve(request, controller.signal)).toEqual(request.chat.nativeSession);
  expect(await service.describe(request, controller.signal)).toEqual({ kind: 'filesystem-path', value: filePath });
  return { f, store, controller, request, service, rootDirectory, filePath };
}
