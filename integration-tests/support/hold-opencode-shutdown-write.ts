import { mock } from 'bun:test';
import * as fs from 'node:fs/promises';

const original = { ...fs };
mock.module('node:fs/promises', () => ({
  ...original,
  async writeFile(path: Parameters<typeof fs.writeFile>[0], data: string, options?: Parameters<typeof fs.writeFile>[2]) {
    if (data.includes('"status": "stopping"') || data.includes('"status": "stopped"')) {
      await original.writeFile(process.env.GARCON_TEST_OPENCODE_WRITE_HELD!, 'held');
      await new Promise<void>(() => undefined);
    }
    return original.writeFile(path, data, options);
  },
}));
