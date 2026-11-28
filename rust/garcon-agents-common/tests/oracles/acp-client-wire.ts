import { AcpClient } from '../../../../server-agents/common/src/acp/client.ts';
import { garconInitializeParams } from '../../../../server-agents/common/src/acp/protocol.ts';
import { reconnectAcpSession } from '../../../../server-agents/common/src/acp/reconnect-policy.ts';
import { AcpTransport } from '../../../../server-agents/common/src/acp/transport.ts';

const frames: string[] = [];
const encoder = new TextEncoder();
const exit = Promise.withResolvers<number>();
let output!: ReadableStreamDefaultController<Uint8Array>;
const stdout = new ReadableStream<Uint8Array>({ start(controller) { output = controller; } });
const results: Record<string, unknown> = {
  initialize: {
    protocolVersion: 1,
    authMethods: [{ id: 'oauth-personal' }],
    agentCapabilities: { loadSession: true, sessionCapabilities: { resume: null } },
  },
  authenticate: {},
  'session/new': { sessionId: 'created' },
  'session/load': { sessionId: 'wrong', models: { currentModelId: 'model' } },
  'session/prompt': { stopReason: 'end_turn' },
};
const transport = new AcpTransport({
  spawn: () => ({
    stdout,
    exited: exit.promise,
    kill() {
      output.close();
      exit.resolve(143);
    },
    stdin: {
      write(frame) {
        if (typeof frame !== 'string') throw new Error('expected a JSON-RPC text frame');
        frames.push(frame);
        const { id, method } = JSON.parse(frame);
        if (id === undefined) return;
        const response = method === 'session/resume'
          ? { id, error: { code: -32601, message: 'Method not found' } }
          : { id, result: results[method] };
        output.enqueue(encoder.encode(JSON.stringify(response) + '\n'));
      },
    },
  }),
});

const client = new AcpClient(transport, {
  initialize: garconInitializeParams(),
  authenticateMethodId: 'oauth-personal',
});
try {
  const connection = await client.connect({ command: 'agent', args: ['acp'], cwd: '/work', env: {} });
  const opened = await client.newSession({ cwd: '/work', mcpServers: undefined });
  const loaded = await reconnectAcpSession(client, { cwd: '/work', mcpServers: undefined, sessionId: 'original' });
  const reply = await client.promptSession({ sessionId: 'original', prompt: [{ type: 'text', text: 'hello' }] }, { timeoutMs: 500 });
  client.cancelSession({ sessionId: 'original' });
  console.log(JSON.stringify({ connection, opened, loaded, reply, frames }));
} finally {
  client.close();
}
