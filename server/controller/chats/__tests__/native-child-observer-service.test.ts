import { afterEach, describe, expect, it, mock } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AssistantMessage, UserMessage } from '../../../../common/chat-types.js';
import type { AgentNativeChildDescriptor } from '@garcon/server-agent-interface';
import { integrationFixture } from '../../../remote/__tests__/integration-fixture.js';
import { TranscriptLedgerService } from '../../ledger/service.js';
import { TranscriptLedgerStore } from '../../ledger/store.js';
import { TranscriptAdoptionService } from '../../ledger/adoption.js';
import { ChatRegistry } from '../store.js';
import { ChatIdAllocator } from '../chat-id-allocator.js';
import { NativeChildObserverService } from '../native-child-observer-service.js';
import { AgentOwnershipJournal } from '../agent-ownership-journal.js';

const ROOT = '1783725900000100';
const AT = '2026-11-23T00:00:00.000Z';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function child(key = 'child', parentKey: string | null = null): AgentNativeChildDescriptor {
  return { ref: { ownerId: 'test', schemaVersion: 1, key, value: { root: 'synthetic-root' } }, parentKey, label: 'Synthetic child', model: null };
}

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'garcon-child-observer-'));
  const ledgerRoot = path.join(directory, 'ledgers');
  const registry = new ChatRegistry(directory);
  await registry.init();
  registry.addChat({ id: ROOT, agentId: 'test', model: 'model', projectPath: '/synthetic',
    agentSessionId: 'synthetic-root', agentOwnershipEpoch: 'source-epoch',
    parentChatId: null, lineage: null, preambleSelection: { revision: 0, orderedPreambleIds: [] } });
  const ledger = new TranscriptLedgerService(new TranscriptLedgerStore(ledgerRoot));
  ledger.initializeChat(ROOT);
  const lease = ledger.openProducer(ROOT, 'test');
  const native = integrationFixture('/synthetic', 'local');
  native.integration.nativeChildObservation = { async *loadHistory() { throw new Error('Unexpected native read'); } };
  const settings = {
    setSessionName: mock(async (_chatId: string, name: string) => ({ title: name, changed: true })),
    ensureInNormal: mock(async (_chatId: string) => {}),
    emitListChanged: mock((_reason: string, _chatId: string) => {}),
  };
  const onError = mock((_message: string, _chatId: string) => {});
  const options = { registry, ledger, settings, onError, chatIds: new ChatIdAllocator(registry) };
  const observers = new NativeChildObserverService(options);
  observers.registerSource(ROOT, lease, registry.getChat(ROOT)!);
  cleanups.push(async () => { ledger.close(); await registry.flush(); await native.executor.dispose(); await rm(directory, { recursive: true, force: true }); });
  const publish = (event: import('@garcon/server-agent-interface').AgentNativeChildEvent) => observers.accept(ROOT, lease, native.integration, event);
  const create = (descriptor = child()) => publish({ type: 'native-child-created', child: descriptor });
  const ids = () => registry.listChatIds().filter(id => id !== ROOT);
  return { directory, ledgerRoot, registry, ledger, lease, native, observers, settings, onError, options, create, publish, ids };
}

describe('native child capture admission', () => {
  it('journals observer deletion without consulting or releasing native sessions', async () => {
    const f = await fixture();
    f.create();
    const id = f.ids()[0]!;
    const get = mock(() => { throw new Error('Observer deletion must not consult providers'); });
    const ownership = new AgentOwnershipJournal({ workspaceDir: f.directory, registry: f.registry,
      ledger: f.ledger, integrations: { get, require: get }, isExecutorConfigured: () => true });
    await ownership.initialize();
    await ownership.delete(id);
    await ownership.waitForProviderCleanup();
    f.create();
    f.publish({ type: 'native-child-rows', childKey: 'child', rows: [{ message: new AssistantMessage(AT, 'Late') }] });
    expect(get).not.toHaveBeenCalled();
    expect(f.ids()).toEqual([]);
    expect(existsSync(path.join(f.ledgerRoot, id))).toBe(false);
  });

  it('registers one inert ledger synchronously and captures independently of parent settlement', async () => {
    const f = await fixture();
    f.ledger.beginRun(ROOT, 'root-run');
    f.create();
    f.create();
    expect(f.ids()).toHaveLength(1);
    const id = f.ids()[0]!;
    expect(f.registry.getChat(id)).toMatchObject({ agentSessionId: null, nativeSession: null, parentChatId: ROOT,
      nativeObservation: { sourceChatId: ROOT, sourceOwnershipEpoch: 'source-epoch', child: { key: 'child' } } });
    f.lease.sink.publish({ type: 'run-ended', runId: 'root-run', outcome: 'finished' });
    f.publish({ type: 'native-child-rows', childKey: 'child', rows: [
      { message: new UserMessage(AT, 'Task') }, { message: new AssistantMessage(AT, '<garcon-get-chat-id />') },
    ] });
    expect(f.ledger.currentRows(id)).toHaveLength(2);
    expect(f.ledger.currentRows(ROOT).map(row => row.kind)).toEqual(['run-ended']);
    expect(f.observers.projection(id)).toEqual({ kind: 'native-child', captureStatus: 'attached', isWorking: true });
    f.publish({ type: 'native-child-status', childKey: 'child', status: 'completed' });
    expect(f.observers.projection(id)?.isWorking).toBe(false);
    f.publish({ type: 'native-child-status', childKey: 'child', status: 'running' });
    expect(f.observers.projection(id)?.isWorking).toBe(true);
    f.lease.close();
    expect(f.observers.projection(id)?.isWorking).toBe(false);
    expect(f.settings.setSessionName).toHaveBeenCalledWith(id, 'Synthetic child');
    expect(f.settings.ensureInNormal).toHaveBeenCalledWith(id);
  });

  it('refuses unknown rows, stale sources, and descriptors from another provider', async () => {
    const f = await fixture();
    f.publish({ type: 'native-child-rows', childKey: 'unknown', rows: [{ message: new AssistantMessage(AT, 'Unknown') }] });
    f.create({ ...child(), ref: { ...child().ref, ownerId: 'wrong' } });
    expect(f.ids()).toEqual([]);
    f.registry.updateChat(ROOT, { agentOwnershipEpoch: 'replacement' });
    f.create();
    expect(f.ids()).toEqual([]);
    expect(f.onError).toHaveBeenCalledTimes(1);
  });

  it('keeps suppression until the parent lease closes and never recreates deleted storage', async () => {
    const f = await fixture();
    f.create();
    const id = f.ids()[0]!;
    f.observers.retireChat(id);
    f.registry.removeChat(id);
    f.ledger.deleteChat(id);
    f.create();
    f.publish({ type: 'native-child-rows', childKey: 'child', rows: [{ message: new AssistantMessage(AT, 'Late') }] });
    expect(f.ids()).toEqual([]);
    expect(existsSync(path.join(f.ledgerRoot, id))).toBe(false);
    expect(f.native.calls.abort).toBe(0);
    f.lease.close();
    f.create(child('another'));
    expect(f.ids()).toEqual([]);
  });

  it('places descendants under existing verified ancestors without recreating missing observers', async () => {
    const f = await fixture();
    f.create(child('a'));
    const a = f.ids()[0]!;
    f.create(child('b', 'a'));
    const b = f.ids()[1]!;
    f.observers.retireChat(a);
    f.create(child('c', 'a'));
    expect(f.registry.getChat(f.ids()[2]!)!.parentChatId).toBe(a);
    f.registry.removeChat(b);
    f.ledger.deleteChat(b);
    f.create(child('d', 'b'));
    const d = f.ids().find(id => f.registry.getChat(id)?.nativeObservation?.child.key === 'd')!;
    expect(f.registry.getChat(d)!.parentChatId).toBe(a);
  });

  it('installs detached when registration listeners retire the source and preserves saved history across restart', async () => {
    const f = await fixture();
    f.registry.onChatAdded(() => f.lease.close());
    f.create();
    const id = f.ids()[0]!;
    expect(f.observers.projection(id)?.captureStatus).toBe('detached');
    await f.registry.flush();
    const reopened = new ChatRegistry(f.directory);
    await reopened.init();
    expect(reopened.getChat(id)!.nativeObservation?.child.key).toBe('child');
    expect(f.ledger.currentRows(id)).toEqual([]);
  });

  it('source-wide retention retirement leaves the parent and existing child chats usable', async () => {
    const f = await fixture();
    f.create();
    const id = f.ids()[0]!;
    f.publish({ type: 'native-child-capture-ended', reason: 'retention-limit' });
    f.create(child('second'));
    f.lease.sink.publish({ type: 'rows', rows: [{ message: new AssistantMessage(AT, 'Parent survives') }] });
    expect(f.ids()).toEqual([id]);
    expect(f.observers.projection(id)?.captureStatus).toBe('detached');
    expect(f.ledger.currentRows(id)).toMatchObject([{ kind: 'notice', detail: { type: 'native-child-gap' } }]);
    expect(f.ledger.currentRows(ROOT)).toHaveLength(1);
    expect(f.native.calls.abort).toBe(0);
  });

  it('never adopts an observer from native history or creates missing storage on open', async () => {
    const f = await fixture();
    f.create();
    const id = f.ids()[0]!;
    const requireIntegration = mock(() => f.native.integration);
    const adoption = new TranscriptAdoptionService({ ledger: f.ledger, registry: f.registry,
      integrations: { require: requireIntegration }, getCarryOverRevision: () => '', loadFrozenPrefix: async () => [] });
    await expect(adoption.ensure(id)).resolves.toEqual(f.ledger.currentView(id)!);
    f.ledger.deleteChat(id);
    await expect(adoption.ensure(id)).rejects.toThrow('no current view');
    expect(requireIntegration).not.toHaveBeenCalled();
    expect(existsSync(path.join(f.ledgerRoot, id))).toBe(false);
  });
});
