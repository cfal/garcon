import { expect, test } from 'bun:test';
import { RPC_V1 } from '@garcon/common/executor-contracts';
import { CLI_OPERATIONS } from '@garcon/common/cli-contracts';
import { ExecutorRpc } from '../rpc.js';
import { WorkerSessionTransport } from '../../__tests__/test-session-transport.js';

test.each(['result', 'error', 'cancel'] as const)('settled %s calls release CLI bodies while their session stays alive', async kind => {
  const transport = new WorkerSessionTransport('synthetic-bulk', 'synthetic-controller', () => {}, {}, 'local', 'bulk');
  const rpc = new ExecutorRpc(transport);
  let id = '';
  const socket = transport.attach({ send(payload) {
    const frame = JSON.parse(payload);
    if (frame.type === 'request') id = frame.id;
  }, close() {} });
  async function call(): Promise<WeakRef<object>> {
    const body = { executorId: 'local', command: 'x'.repeat(900_000) };
    const reference = new WeakRef(body);
    const abort = new AbortController();
    id = '';
    const pending = rpc.call('', RPC_V1['controllerCli.request'], {
      contract: { name: CLI_OPERATIONS['POST /api/v1/chats/start'][1].name, version: 1 }, expectedServerInstanceId: 'synthetic-controller',
      http: { operation: 'POST /api/v1/chats/start', query: [], body },
    }, { signal: abort.signal }).catch(error => error);
    expect(id).not.toBe('');
    if (kind === 'cancel') abort.abort();
    else socket.receive(JSON.stringify(kind === 'result' ? { type: 'result', id, value: { status: 200, body: {} } }
      : { type: 'error', id, error: { code: 'PROVIDER_FAILURE', message: 'Synthetic failure', retryable: false } }));
    expect(await pending).toMatchObject(kind === 'result' ? { status: 200 } : kind === 'cancel'
      ? { outcome: 'unknown' } : { code: 'PROVIDER_FAILURE' });
    return reference;
  }
  try {
    const references = [await call(), await call(), await call()];
    await new Promise<void>(resolve => setImmediate(resolve));
    Bun.gc(true);
    expect(references.map(reference => reference.deref())).toEqual([undefined, undefined, undefined]);
    expect(transport.connected).toBe(true);
  } finally { transport.close(); }
});
