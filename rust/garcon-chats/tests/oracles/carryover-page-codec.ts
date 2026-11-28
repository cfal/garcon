import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import { AssistantMessage, UnknownToolUseMessage, UserMessage } from '../../../../common/chat-types.js';
import {
  decodeCarryOverPage, encodeCarryOverPages, writeEncodedCarryOverPage,
} from '../../../../server/controller/chats/carryover/page-codec.ts';
import type { CarryOverPageDescriptor } from '../../../../server/controller/chats/carryover/segment-types.ts';

if (Bun.version !== '1.4.3') throw new Error(`Expected Bun 1.4.3, got ${Bun.version}`);
const [mode, root] = process.argv.slice(2);
const timestamp = '2026-01-01T00:00:00.000Z';
const messages = Array.from({ length: 255 }, (_, i) => new UserMessage(timestamp, `Synthetic input ${i}`));
const corpus = [
  ...messages,
  new UnknownToolUseMessage(timestamp, 'synthetic-tool', 'custom', {
    b: 1.0, '10': 9_007_199_254_740_993, '2': 1e21, a: -0,
  }),
  new AssistantMessage(timestamp, '\u00e9'.repeat(1024 * 512)),
  new UserMessage(timestamp, 'Synthetic follow-up \u{1f642}'),
];
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const path = (file: string) => join(root, file);
const pages = await encodeCarryOverPages(corpus);
const descriptors = pages.map(({ descriptor }) => descriptor);
assert.deepEqual(descriptors.map((page) => [page.firstSequence, page.messageCount]), [
  [0, 256], [256, 1], [257, 1],
]);

if (mode === 'write') {
  await mkdir(path('pages'));
  for (const page of pages) {
    await writeEncodedCarryOverPage(path(page.descriptor.file), page);
  }
  await writeFile(path('descriptors.json'), JSON.stringify(descriptors));
  await writeFile(path('messages.json'), JSON.stringify(corpus));

  const bad: Array<{ descriptor: CarryOverPageDescriptor; message: string }> = [];
  for (const [name, payload, message] of [
    ['bad-json', Buffer.from('[no json]'), 'Carryover page payload is invalid'],
    ['filtered-row', Buffer.from('[{"type":"unrecognizable"}]'), 'Carryover page message count differs from its manifest'],
    ['invalid-brotli', Buffer.from([0xff, 0xff]), 'Carryover page cannot be decompressed'],
  ] as const) {
    const file = `${name}.br`;
    const contents = name === 'invalid-brotli' ? payload : brotliCompressSync(payload);
    await writeFile(path(file), contents);
    const descriptor = {
      file, firstSequence: 0, messageCount: 1,
      uncompressedBytes: payload.length, compressedBytes: contents.length, sha256: sha256(payload),
    };
    await assert.rejects(decodeCarryOverPage(path(file), descriptor), { name: 'CarryOverPageIntegrityError', message });
    bad.push({ descriptor, message });
  }
  await writeFile(path('bad.json'), JSON.stringify(bad));
} else if (mode === 'check') {
  const actual: CarryOverPageDescriptor[] = JSON.parse(await readFile(path('descriptors.json'), 'utf8'));
  assert.equal(actual.length, descriptors.length);
  for (const [i, descriptor] of actual.entries()) {
    const expected = descriptors[i];
    const page = corpus.slice(expected.firstSequence, expected.firstSequence + expected.messageCount);
    const compressed = await readFile(path(descriptor.file));
    const canonical = Buffer.from(JSON.stringify(page));
    assert.deepEqual(descriptor, { ...expected, compressedBytes: compressed.length });
    assert.deepEqual(brotliDecompressSync(compressed), canonical);
    assert.equal(JSON.stringify(await decodeCarryOverPage(path(descriptor.file), descriptor)), canonical.toString());
  }
} else {
  throw new Error(`Unknown mode ${mode}`);
}
