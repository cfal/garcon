import { Console } from 'node:console';
import type { FileSink } from 'bun';
import { NodeWorkerTransportError } from './framing.js';
import type { NodeWorkerWritePort } from './writer.js';

export function nodeWorkerPipePort(sink: Pick<FileSink, 'write' | 'flush' | 'end'>): NodeWorkerWritePort {
  let closed = false;
  return {
    async write(bytes) {
      if (closed) throw new NodeWorkerTransportError('NODE_WORKER_CLOSED');
      await sink.write(bytes);
      await sink.flush();
    },
    close() {
      if (closed) return;
      closed = true;
      void Promise.resolve(sink.end()).catch(() => {});
    },
  };
}

/** Runs before provider imports so their module initialization cannot write into the protocol stream. */
export function reserveNodeWorkerStdout(): NodeWorkerWritePort {
  const port = nodeWorkerPipePort(Bun.stdout.writer());
  process.stdout.write = process.stderr.write.bind(process.stderr);
  globalThis.console = Object.assign(new Console({ stdout: process.stderr, stderr: process.stderr, colorMode: false }), {
    write(...data: (string | ArrayBufferView | ArrayBuffer)[]): number {
      let length = 0;
      for (const chunk of data) {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : ArrayBuffer.isView(chunk)
          ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength) : Buffer.from(chunk);
        process.stderr.write(bytes);
        length += bytes.byteLength;
      }
      return length;
    },
  });
  return port;
}
