import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  AssistantMessage,
  BashToolUseMessage,
  UserMessage,
} from '../../../common/chat-types.ts';
import { ChatRegistry } from '../../chats/store.ts';
import { TranscriptLedgerService } from '../../ledger/service.ts';
import { TranscriptLedgerStore } from '../../ledger/store.ts';
import { AgentRegistry } from '../registry.ts';

const CHAT_ID = '1783725900000200';
const AT = '2026-08-15T00:00:00.000Z';

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

  function createRegistry(adoption = {
    ensure: () => Promise.reject(new Error('unused')),
  }) {
    return new AgentRegistry({
      registry: chats,
      integrations: {
        has: () => false,
        get: () => null,
        require: () => { throw new Error('unused'); },
        list: () => [],
      },
      endpointResolver: {},
      getCarryOverRevision: () => 'carry-1',
      ledger,
      adoption,
      hasPendingOwnershipTransfer: () => false,
    });
  }

  it('updates the execution cache before an accepted session publish returns', () => {
    const registry = createRegistry();
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

  it('caches a session fact that arrives after interruption for future resume', async () => {
    const producer = ledger.openProducer(CHAT_ID, 'test');
    ledger.beginRun(CHAT_ID, 'run-1');
    expect(ledger.interruptRun(CHAT_ID)).toMatchObject({ outcome: 'interrupted' });
    await Promise.resolve();
    const registry = createRegistry();
    expect(registry).toBeDefined();

    producer.sink.publish({
      type: 'session',
      session: {
        agentSessionId: 'native-late',
        nativeSession: {
          ownerId: 'test',
          schemaVersion: 1,
          value: { path: '/tmp/native-late.jsonl' },
        },
        nativeSeedReceipt: null,
      },
    });

    expect(ledger.currentRows(CHAT_ID).map((row) => row.kind)).toEqual([
      'run-ended',
      'session',
    ]);
    expect(chats.getChat(CHAT_ID)).toMatchObject({
      agentSessionId: 'native-late',
      nativeSession: {
        ownerId: 'test',
        value: { path: '/tmp/native-late.jsonl' },
      },
    });
    expect(chats.getChatByAgentSessionId('native-late')?.[0]).toBe(CHAT_ID);
  });

  it('selects preview text only from the conversational ledger fold', async () => {
    const viewId = ledger.currentView(CHAT_ID).viewId;
    ledger.appendInputAndCompose({
      chatId: CHAT_ID,
      viewId,
      message: new UserMessage(AT, 'preview-first-user'),
      attachments: [],
      clientMessageId: 'preview-message-1',
      steer: false,
    });
    const producer = ledger.openProducer(CHAT_ID, 'test');
    producer.sink.publish({
      type: 'session',
      session: { agentSessionId: 'native-preview', nativeSession: null, nativeSeedReceipt: null },
    });
    producer.sink.publish({
      type: 'rows',
      rows: [{ message: new AssistantMessage(AT, 'preview-initial-answer') }],
    });
    ledger.beginRun(CHAT_ID, 'preview-run');
    producer.sink.publish({
      type: 'permission',
      runId: 'preview-run',
      lifecycle: {
        kind: 'requested',
        permissionOccurrenceId: 'preview-incarnation',
        requestedTool: new BashToolUseMessage(AT, 'preview-tool', 'pwd'),
        options: [],
      },
      decision: {
        permissionOccurrenceId: 'preview-incarnation',
        respond: async () => {},
      },
    });
    producer.sink.publish({
      type: 'run-ended',
      runId: 'preview-run',
      outcome: 'finished',
    });
    producer.sink.publish({
      type: 'rows',
      rows: [{ message: new AssistantMessage(AT, 'preview-late-answer') }],
    });
    producer.sink.publish({
      type: 'permission',
      runId: 'preview-run',
      lifecycle: {
        kind: 'cancelled',
        permissionOccurrenceId: 'preview-incarnation',
        reason: 'already ended',
      },
    });
    ledger.appendNotice({
      chatId: CHAT_ID,
      viewId,
      message: 'preview-notice',
      detail: { action: 'reload-native-history' },
    });
    await Promise.resolve();
    const registry = createRegistry({
      ensure: async () => ledger.currentView(CHAT_ID),
    });

    await expect(registry.getPreview(chats.getChat(CHAT_ID), CHAT_ID)).resolves.toEqual({
      preview: {
        firstMessage: 'preview-first-user',
        lastMessage: 'preview-late-answer',
        createdAt: AT,
        lastActivity: AT,
      },
    });
  });
});
