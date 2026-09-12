import { expect, mock, test } from 'bun:test';
import type { NodeOutputPermissionHandles } from '../../output-encoder.js';
import { NodeWorkerOutputAssembler } from '../output-assembler.js';
import { NodeWorkerOutputPort } from '../output-port.js';
import { NODE_WORKER_WRITER_LIMITS } from '../limits.js';
import { NodeWorkerWriter } from '../writer.js';
import { parseNodeWorkerOutputRetirementText } from '../output-retirement.js';
import { session, tick } from './lifecycle-fixture.js';

const stream = { ...session, streamId: 'synthetic-first' };
const sibling = { ...session, streamId: 'synthetic-second' };

test.each(['retirement', 'timeout'] as const)('an instance %s releases its partial assembly before its healthy sibling begins', async (cause) => {
  let now = 0;
  const lifetime = new AbortController(); const cancelled = new AbortController();
  const pipeFailure = mock((_error: unknown) => {});
  const received = mock((_text: string, _sequence: number) => {});
  const siblingFailed = mock((_error: unknown) => {});
  const native = Promise.withResolvers<void>();
  const frames: string[] = [];
  const assembler = new NodeWorkerOutputAssembler({ session, instanceIds: new Set(['synthetic-instance']), signal: lifetime.signal,
    now: () => now, validate() {}, failed: pipeFailure });
  assembler.install('synthetic-instance', stream, lifetime.signal, () => {}, () => {});
  assembler.install('synthetic-instance', sibling, lifetime.signal, received, siblingFailed);
  const writer = new NodeWorkerWriter({ write(bytes) {
    const text = Buffer.from(bytes.subarray(4)).toString(); frames.push(JSON.parse(text).type);
    const retirement = parseNodeWorkerOutputRetirementText(text);
    if (retirement) assembler.receiveRetirement('synthetic-instance', text);
    else assembler.receive('synthetic-instance', text);
    return frames.length === 1 ? native.promise : Promise.resolve();
  }, close() { native.resolve(); } }, { ...NODE_WORKER_WRITER_LIMITS, signal: lifetime.signal, failed: pipeFailure });
  const port = new NodeWorkerOutputPort(writer, { session, instanceId: 'synthetic-instance', signal: lifetime.signal,
    now: () => now, validate() {}, failed: pipeFailure, limits: { retentionMs: 100 } });
  const permissions = { createHandle: () => 'synthetic', register() {}, retire() {} } satisfies NodeOutputPermissionHandles;
  const first = port.install(stream, cancelled.signal, permissions, () => {});
  const second = port.install(sibling, lifetime.signal, permissions, () => {});
  try {
    first.emit({ type: 'notice', runId: 'synthetic-first', content: '界'.repeat(30_000) }); await tick();
    now = 50; second.emit({ type: 'notice', runId: 'synthetic-second', content: 'synthetic sibling' });
    if (cause === 'retirement') cancelled.abort(); else { now = 100; port.prune(); }
    native.resolve(); await tick();
    expect(received).toHaveBeenCalledTimes(1); expect(siblingFailed).not.toHaveBeenCalled();
    expect(frames).toEqual(['node-worker-output', 'node-worker-output-retired', 'node-worker-output']);
    expect(assembler.bufferedBytes).toBe(0); expect(port.bufferedBytes).toBe(0); expect(pipeFailure).not.toHaveBeenCalled();
  } finally { port.close(); writer.close(); assembler.close(); }
});
