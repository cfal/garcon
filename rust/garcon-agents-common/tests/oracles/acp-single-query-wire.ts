import { fileURLToPath } from 'node:url';
import { garconInitializeParams } from '../../../../server-agents/common/src/acp/protocol.ts';
import { runAcpSingleQuery } from '../../../../server-agents/common/src/acp/single-query.ts';

const [mode, capture] = process.argv.slice(2);
if (!mode || !capture) throw new Error('expected mode and capture path');
const peer = fileURLToPath(new URL('../fixtures/acp-single-query-peer.ts', import.meta.url));
try {
  const text = await runAcpSingleQuery({
    spawn: { command: process.execPath, args: [peer, mode, capture], cwd: process.cwd(), env: {} },
    initialize: garconInitializeParams(),
    prompt: '  request  ',
    signal: new AbortController().signal,
    requestTimeoutMs: mode === 'timeout' ? 750 : 5000,
    async configure(client, created) {
      await client.setSessionModel({ sessionId: created.sessionId, modelId: 'sample-model' });
    },
    respondToRequest: method => method === 'sample/version' ? { version: 1 } : null,
    splitFailure: chunk => chunk.startsWith('\nFAIL: ')
      ? { text: '', failure: chunk.slice(7) }
      : { text: chunk, failure: null },
  });
  console.log(JSON.stringify({ text }));
} catch (error) {
  const failure = error as Error & { code?: string; retryable?: boolean };
  console.log(JSON.stringify({ message: failure.message, code: failure.code, retryable: failure.retryable }));
}
