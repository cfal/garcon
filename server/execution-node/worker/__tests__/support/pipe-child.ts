import { readNodeWorkerFrames } from '../../framing.js';
import { NodeWorkerLifeline } from '../../lifeline.js';
import { reserveNodeWorkerStdout } from '../../pipes.js';
import { NodeWorkerWriter } from '../../writer.js';

const port = reserveNodeWorkerStdout();
const lifeline = new NodeWorkerLifeline({ retired(error) { process.exit(error.code === 'NODE_WORKER_CLOSED' ? 0 : 1); } });
const writer = new NodeWorkerWriter(port, { signal: lifeline.signal, maxFrameBytes: 1024,
  maxQueuedBytes: 8192, maxQueuedFrames: 8, reservedControlBytes: 2048, reservedControlFrames: 2,
  writeTimeoutMs: 1000, failed(error) { process.exit(error.code === 'NODE_WORKER_CLOSED' ? 0 : 1); } });
await import('./pipe-output.js');
await writer.send('synthetic hello', 'control', 'lifecycle');
if (process.argv[2] === 'hold') {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
try {
  for await (const text of readNodeWorkerFrames(Bun.stdin.stream(), 1024, lifeline.signal)) {
    lifeline.poll();
    await writer.send(text, 'data', 'data');
  }
  lifeline.close();
} catch { process.exit(1); }
