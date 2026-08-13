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
});
