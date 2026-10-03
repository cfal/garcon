import { mock } from 'bun:test';
import * as fs from 'node:fs';

const original = { ...fs };
mock.module('node:fs', () => ({
  ...original,
  writeFileSync(path: fs.PathOrFileDescriptor, data: string, options?: fs.WriteFileOptions) {
    if (String(path).includes('.response.json')) {
      original.writeFileSync(path, '');
      original.writeFileSync(process.env.INTEGRATION_CODEX_WRITE_HELD!, 'held');
      const deadline = Date.now() + 10_000;
      while (!original.existsSync(process.env.INTEGRATION_CODEX_WRITE_RELEASE!)) {
        if (Date.now() >= deadline) throw new Error('Codex response write was never released');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    return original.writeFileSync(path, data, options);
  },
}));
