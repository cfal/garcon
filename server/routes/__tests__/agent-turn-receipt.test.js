import { describe, expect, it } from 'bun:test';
import { CommandLedger } from '../../commands/command-ledger.js';
import { createAgentTurnReceiptRoutes } from '../agent-turn-receipt.js';

async function getReceipt(ledger, query) {
  const route = createAgentTurnReceiptRoutes(ledger)['/api/v1/chats/turn-receipt'].GET;
  const url = new URL(`http://localhost/api/v1/chats/turn-receipt?${query}`);
  const response = await route(new Request(url), url);
  return { response, body: await response.json() };
}

describe('agent turn receipt route', () => {
  it('returns pending and terminal receipts with no-store caching', async () => {
    const ledger = new CommandLedger();
    const accepted = await ledger.accept({
      commandType: 'agent-run',
      chatId: 'chat-1',
      clientRequestId: 'req-1',
      turnId: 'turn-1',
      payload: { command: 'hello' },
    });
    const pending = await getReceipt(ledger, 'chatId=chat-1&turnId=turn-1');
    expect(pending.response.headers.get('Cache-Control')).toBe('no-store');
    expect(pending.body.state).toBe('pending');

    await ledger.appendAssistantMessages('chat-1', 'turn-1', ['done']);
    await ledger.settleTerminal(accepted.record.key, 'finished');
    await ledger.markPublicTerminal('chat-1', 'turn-1');
    const completed = await getReceipt(ledger, 'chatId=chat-1&turnId=turn-1');
    expect(completed.body).toMatchObject({
      state: 'completed',
      output: { availability: 'available', assistantMessages: ['done'] },
    });
  });

  it('distinguishes missing and expired turn results', async () => {
    const ledger = new CommandLedger(undefined, {
      turnResultByteLimit: 10,
      totalTurnResultByteLimit: 1,
    });
    const missing = await getReceipt(ledger, 'chatId=chat-1&turnId=missing');
    expect(missing.response.status).toBe(404);
    expect(missing.body.errorCode).toBe('TURN_RECEIPT_NOT_FOUND');

    const accepted = await ledger.accept({
      commandType: 'agent-run',
      chatId: 'chat-1',
      clientRequestId: 'req-1',
      turnId: 'turn-1',
      payload: { command: 'hello' },
    });
    await ledger.appendAssistantMessages('chat-1', 'turn-1', ['done']);
    await ledger.settleTerminal(accepted.record.key, 'finished');
    await ledger.markPublicTerminal('chat-1', 'turn-1');
    const expired = await getReceipt(ledger, 'chatId=chat-1&turnId=turn-1');
    expect(expired.response.status).toBe(410);
    expect(expired.body.errorCode).toBe('TURN_RESULT_EXPIRED');
  });
});
