import { expect, test } from 'bun:test';
import { NodeDeadline } from '../../../execution-nodes/deadline.js';
import { NodeWorkerAuthority } from '../authority.js';
import { startNodeSessionRuntime } from '../session-runtime.js';
import { configuration, session } from './lifecycle-fixture.js';

test('impossible history allocation fails before environment inspection, writer use, or worker spawn', async () => {
  const input = configuration();
  const first = input.instances[0]!;
  const authority = new NodeWorkerAuthority({ session, signal: new AbortController().signal, poll: () => 0 });
  const connection = authority.attach(1);
  try {
    await expect(startNodeSessionRuntime({ configuration: { ...input, historyTransportMemoryBytes: 1,
      instances: [first, { ...first, id: 'synthetic-second', homeDirectory: '/synthetic/second' }] },
    connectionId: 1, connection, authority, startup: new NodeDeadline(60_000) }, {
      submit() { throw new Error('Unexpected writer use'); },
      async waitForRelease() { throw new Error('Unexpected writer wait'); },
    })).rejects.toThrow('History transport budget cannot cover configured instances');
  } finally { authority.retire(); }
});
