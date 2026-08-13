import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ChatRegistry } from '../../chats/store.ts';
import { TranscriptLedgerService } from '../../ledger/service.ts';
import { TranscriptLedgerStore } from '../../ledger/store.ts';
import { AgentRegistry } from '../registry.ts';

const CHAT_ID = '1783725900000200';

describe('AgentRegistry session cache', () => {
  let root;
  let chats;
  let ledger;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'garcon-agent-registry-'));
    chats = new ChatRegistry(root);
    await chats.init();
    chats.addChat({
      id: CHAT_ID,
      agentId: 'test',
      model: 'model-a',
      projectPath: '/repo',
      agentSettingsById: {
        test: { ownerId: 'test', schemaVersion: 1, values: {} },
      },
    });
    ledger = new TranscriptLedgerService(
      new TranscriptLedgerStore(path.join(root, 'transcript-ledgers')),
    );
    ledger.initializeChat(CHAT_ID);
  });

  afterEach(async () => {
    ledger?.close();
    await chats?.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  it('updates the execution cache before an accepted session publish returns', () => {
    const integrations = {
      has: () => false,
      get: () => null,
      require: () => { throw new Error('unused'); },
      list: () => [],
    };
    const endpointResolver = {};
    const adoption = { ensure: () => Promise.reject(new Error('unused')) };
    const registry = new AgentRegistry({
      registry: chats,
      integrations,
      endpointResolver,
      getCarryOverRevision: () => 'carry-1',
      ledger,
      adoption,
    });
    expect(registry).toBeDefined();

    registry.publishSessionFact(CHAT_ID, {
      agentSessionId: 'native-1',
      nativeSession: {
        ownerId: 'test',
        schemaVersion: 1,
        value: { path: '/tmp/native.jsonl' },
      },
      nativeSeedReceipt: null,
    });

    expect(chats.getChat(CHAT_ID)).toMatchObject({
      agentSessionId: 'native-1',
      nativeSession: {
        ownerId: 'test',
        value: { path: '/tmp/native.jsonl' },
      },
    });
    expect(chats.getChatByAgentSessionId('native-1')?.[0]).toBe(CHAT_ID);
  });
});
