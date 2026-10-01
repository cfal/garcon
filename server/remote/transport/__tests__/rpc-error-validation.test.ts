import { expect, test } from 'bun:test';
import { AGENT_INTEGRATION_ERROR_CODES, isAgentIntegrationErrorCode } from '@garcon/server-agent-interface';
import { ExecutorRpc } from '../rpc.js';
import { SessionTransport } from '../session-transport.js';

function fixture() {
  const sent: { id: string }[] = [];
  const transport = new SessionTransport('synthetic-session', 'synthetic-worker', () => {});
  const connection = transport.attach({ send: body => { sent.push(JSON.parse(body)); }, close() {} });
  return { transport, connection, sent, rpc: new ExecutorRpc(transport) };
}

test.each(AGENT_INTEGRATION_ERROR_CODES)('accepts provider error code %s with and without delivery outcome', async code => {
  const f = fixture();
  try {
    expect(isAgentIntegrationErrorCode(code)).toBe(true);
    for (const outcome of [undefined, 'rejected'] as const) {
      const pending = f.rpc.call('test', 'execution.runningSessions', null);
      f.connection.receive(JSON.stringify({ type: 'error', id: f.sent.at(-1)!.id,
        error: { code, message: 'Synthetic failure', retryable: false, outcome } }));
      await expect(pending).rejects.toMatchObject({ code, message: 'Synthetic failure' });
      expect(f.transport.connected).toBe(true);
    }
  } finally { f.transport.close(); }
});

test.each([
  { code: 'NOT_A_PROVIDER_CODE' }, { code: 123 }, { code: 'toString' },
  { code: 'PROVIDER_FAILURE', domain: 'unknown' }, { code: 'PROVIDER_FAILURE', domain: null },
])('rejects malformed provider error %j and settles the caller', async fields => {
  const f = fixture();
  try {
    const pending = f.rpc.call('test', 'execution.runningSessions', null);
    f.connection.receive(JSON.stringify({ type: 'error', id: f.sent[0]!.id,
      error: { message: 'Synthetic failure', retryable: false, ...fields } }));
    await expect(pending).rejects.toMatchObject({ outcome: 'unknown' });
    expect(f.transport.connected).toBe(false);
  } finally { f.transport.close(); }
});
