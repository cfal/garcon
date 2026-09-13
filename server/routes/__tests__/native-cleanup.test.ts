import { expect, mock, test } from 'bun:test';
import type { NativeCleanupRetryRequest, NativeCleanupRetryResult } from '../../../common/native-cleanup.js';
import type { AgentOwnershipJournal } from '../../chats/agent-ownership-journal.js';
import { DomainError } from '../../lib/domain-error.js';
import { createNativeCleanupRoutes } from '../native-cleanup.js';

test('cleanup HTTP rejects retargeting and reports ownership conflicts without weakening the journal', async () => {
  const retryNativeCleanup = mock(async (_request: NativeCleanupRetryRequest): Promise<NativeCleanupRetryResult> => {
    throw new DomainError('STALE_CHAT_OWNERSHIP', 'Synthetic restored ownership conflict', 409);
  });
  const journal = { nativeCleanupSnapshot: () => ({ entries: [] }), retryNativeCleanup } satisfies
    Pick<AgentOwnershipJournal, 'nativeCleanupSnapshot' | 'retryNativeCleanup'>;
  const handler = createNativeCleanupRoutes(journal)['/api/v1/native-cleanup/retry']!.POST!;
  const url = new URL('http://localhost/api/v1/native-cleanup/retry');
  const request = { chatId: '1000000000000000', operationId: 'synthetic-operation' };
  const invoke = (body: unknown) => handler(new Request(url, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), url);
  expect((await invoke({ ...request, sourceEpoch: 'replacement' })).status).toBe(400);
  expect(retryNativeCleanup).not.toHaveBeenCalled();
  const conflict = await invoke(request);
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ errorCode: 'STALE_CHAT_OWNERSHIP', retryable: false });
  expect(retryNativeCleanup).toHaveBeenCalledWith(request);
});
