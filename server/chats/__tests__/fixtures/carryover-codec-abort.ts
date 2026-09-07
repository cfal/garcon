import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants as zlibConstants } from 'node:zlib';
import { UserMessage } from '../../../../common/chat-types.js';
import { decodeCarryOverPage } from '../../carryover-page-codec.ts';

const compress = promisify(brotliCompress);
const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-codec-abort-'));
const filePath = path.join(workspaceDir, 'page.json.br');

try {
  const content = crypto.randomBytes(12 * 1024 * 1024).toString('base64');
  const uncompressed = Buffer.from(JSON.stringify([
    new UserMessage('2026-01-01T00:00:00.000Z', content),
  ]));
  const compressed = await compress(uncompressed, {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 0 },
  });
  await fs.writeFile(filePath, compressed);
  const descriptor = {
    file: 'page.json.br',
    firstSequence: 0,
    messageCount: 1,
    uncompressedBytes: uncompressed.byteLength,
    compressedBytes: compressed.byteLength,
    sha256: crypto.createHash('sha256').update(uncompressed).digest('hex'),
  };

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const controller = new AbortController();
    const decoding = decodeCarryOverPage(filePath, descriptor, controller.signal);
    setTimeout(() => controller.abort(), 2);
    try {
      await decoding;
      throw new Error('Carryover decode completed before cancellation');
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'AbortError') throw error;
    }
  }
} finally {
  await fs.rm(workspaceDir, { recursive: true, force: true });
}
