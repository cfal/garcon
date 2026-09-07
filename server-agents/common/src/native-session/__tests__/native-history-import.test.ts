import { describe, expect, it } from 'bun:test';
import { AssistantMessage } from '@garcon/common/chat-types';
import { attachNativeMessageSource } from '@garcon/server-agent-interface';
import { createNativeHistoryImport } from '../native-history-import.js';

describe('createNativeHistoryImport', () => {
  it('translates native evidence into import batches with provider metadata', async () => {
    const message = new AssistantMessage('2026-08-12T00:00:00.000Z', 'answer');
    attachNativeMessageSource(message, { entryId: 'native-1' });
    const importer = createNativeHistoryImport({
      async load() { return { messages: [message] }; },
    });
    const rows = [];
    for await (const batch of importer.load({
      chat: {
        chatId: 'chat-1',
        agentId: 'test',
        agentSessionId: 'session-1',
        projectPath: '/tmp/project',
        model: 'model',
        nativeSession: null,
        carryOverRevision: 'revision',
        nativeSeedReceipt: null,
        settings: { ownerId: 'test', schemaVersion: 1, values: {} },
      },
      signal: new AbortController().signal,
    })) rows.push(...batch);

    expect(rows).toEqual([{
      message,
      providerMeta: { entryId: 'native-1' },
    }]);
  });

  it('[TLV5-ADOPT.08-NATIVE-WRAPPER-UNIT-01] preserves valid empty and selected-source failure outcomes', async () => {
    const unavailable = new Error('selected native session is unavailable');
    const importer = createNativeHistoryImport({
      async load({ chat }) {
        if (chat.agentSessionId === 'missing-session') throw unavailable;
        return { messages: [] };
      },
    });

    await expect(importRows(importer, 'empty-session')).resolves.toEqual([]);
    await expect(importRows(importer, 'missing-session')).rejects.toBe(unavailable);
  });
});

async function importRows(
  importer: ReturnType<typeof createNativeHistoryImport>,
  agentSessionId: string,
) {
  const rows = [];
  for await (const batch of importer.load({
    chat: {
      chatId: 'chat-1',
      agentId: 'test',
      agentSessionId,
      projectPath: '/tmp/project',
      model: 'model',
      nativeSession: {
        ownerId: 'test',
        schemaVersion: 1,
        value: { agentSessionId },
      },
      carryOverRevision: 'revision',
      nativeSeedReceipt: null,
      settings: { ownerId: 'test', schemaVersion: 1, values: {} },
    },
    signal: new AbortController().signal,
  })) rows.push(...batch);
  return rows;
}
