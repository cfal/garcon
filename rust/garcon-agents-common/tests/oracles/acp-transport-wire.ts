import { AcpTransport } from '../../../../server-agents/common/src/acp/transport.ts';

const frames: string[] = [];
const stderr: string[] = [];
const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
const writer = writable.getWriter();
const exit = Promise.withResolvers<number>();
const transport = new AcpTransport({
  spawn: () => ({
    stdin: {
      write(frame) {
        frames.push(typeof frame === 'string' ? frame : new TextDecoder().decode(frame));
      },
    },
    stdout: readable,
    exited: exit.promise,
    kill: () => exit.resolve(143),
  }),
});
transport.onStderr(line => stderr.push(line));
await transport.connect({ command: 'agent', args: [], cwd: '.', env: {} });
const request = transport.request('echo', { z: 1, '2': 'second', a: null, '1': 'first' });
transport.notify('session/cancel', { sessionId: 'session-1' });
transport.respond('permission-1', { outcome: 'selected', optionId: 'deny' });
transport.respondError(42, -32601, 'Method not found');
await writer.write(new TextEncoder().encode('not json\n{"id":1,"result":{"ok":true}}\n'));
const reply = await request;
transport.close();
await writer.close();
console.log(JSON.stringify({ frames, reply, stderr }));
