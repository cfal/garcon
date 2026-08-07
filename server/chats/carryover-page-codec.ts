import crypto from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { promisify } from 'node:util';
import {
  brotliCompress,
  constants as zlibConstants,
  createBrotliDecompress,
} from 'node:zlib';
import type { ChatMessage } from '../../common/chat-types.js';
import { parseChatMessages } from '../../common/chat-types.js';
import type { CarryOverPageDescriptor } from './carryover-node-types.js';

export const CARRYOVER_PAGE_MAX_MESSAGES = 256;
export const CARRYOVER_PAGE_TARGET_BYTES = 1024 * 1024;

const compress = promisify(brotliCompress);

export interface EncodedCarryOverPage {
  readonly descriptor: CarryOverPageDescriptor;
  readonly bytes: Buffer;
}

export async function encodeCarryOverPages(
  messages: readonly ChatMessage[],
  signal?: AbortSignal,
): Promise<readonly EncodedCarryOverPage[]> {
  const groups = partitionMessages(messages);
  const pages: EncodedCarryOverPage[] = [];
  let firstSequence = 0;
  for (const [index, group] of groups.entries()) {
    signal?.throwIfAborted();
    const uncompressed = Buffer.from(`[${group.join(',')}]`, 'utf8');
    const bytes = await compress(uncompressed, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
      },
    });
    signal?.throwIfAborted();
    pages.push({
      descriptor: {
        file: `pages/${String(index).padStart(6, '0')}.json.br`,
        firstSequence,
        messageCount: group.length,
        uncompressedBytes: uncompressed.byteLength,
        compressedBytes: bytes.byteLength,
        sha256: digest(uncompressed),
      },
      bytes,
    });
    firstSequence += group.length;
  }
  return pages;
}

export async function writeEncodedCarryOverPage(
  filePath: string,
  page: EncodedCarryOverPage,
): Promise<void> {
  const handle = await fs.open(filePath, 'wx', 0o600);
  try {
    await handle.writeFile(page.bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function decodeCarryOverPage(
  filePath: string,
  descriptor: CarryOverPageDescriptor,
  signal?: AbortSignal,
): Promise<ChatMessage[]> {
  signal?.throwIfAborted();
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size !== descriptor.compressedBytes) {
    throw new Error('Carryover page compressed size differs from its manifest');
  }

  const source = createReadStream(filePath);
  const decompressor = createBrotliDecompress();
  const abort = () => {
    const error = signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
    source.destroy(error);
    decompressor.destroy(error);
  };
  signal?.addEventListener('abort', abort, { once: true });
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of source.pipe(decompressor)) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > descriptor.uncompressedBytes) {
        throw new Error('Carryover page expands beyond its declared size');
      }
      chunks.push(bytes);
    }
    signal?.throwIfAborted();
  } finally {
    signal?.removeEventListener('abort', abort);
    source.destroy();
    decompressor.destroy();
  }

  if (size !== descriptor.uncompressedBytes) {
    throw new Error('Carryover page uncompressed size differs from its manifest');
  }
  const uncompressed = Buffer.concat(chunks, size);
  if (digest(uncompressed) !== descriptor.sha256) throw new Error('Carryover page checksum mismatch');
  const messages = parseChatMessages(JSON.parse(uncompressed.toString('utf8')));
  if (messages.length !== descriptor.messageCount) {
    throw new Error('Carryover page message count differs from its manifest');
  }
  return messages;
}

function partitionMessages(messages: readonly ChatMessage[]): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let currentBytes = 2;
  for (const message of messages) {
    const encoded = JSON.stringify(message);
    const cost = Buffer.byteLength(encoded, 'utf8') + (current.length > 0 ? 1 : 0);
    if (
      current.length > 0
      && (current.length >= CARRYOVER_PAGE_MAX_MESSAGES || currentBytes + cost > CARRYOVER_PAGE_TARGET_BYTES)
    ) {
      groups.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(encoded);
    currentBytes += Buffer.byteLength(encoded, 'utf8') + (current.length > 1 ? 1 : 0);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function digest(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
