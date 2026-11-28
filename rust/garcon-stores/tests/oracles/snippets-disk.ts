import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SnippetStore } from '../../../../server/controller/snippets/store.ts';

const [operation, directory] = Bun.argv.slice(2);
if (!directory) throw new Error('A workspace directory is required');
const store = new SnippetStore(directory);
await store.init();
if (operation === 'write') {
  for (const number of [10, 2]) {
    await store.create({
      id: `original-${number}`,
      shortName: `example${number}`,
      template: 'Synthetic {{arguments}}',
      defaultArguments: `argument-${number}`,
      createdAt: '2026-11-28T10:20:30.000Z',
      updatedAt: '2026-11-28T10:20:30.000Z',
    }, store.snapshot().revision);
  }
} else if (operation !== 'read') {
  throw new Error(`Invalid oracle operation: ${operation}`);
}
console.log(JSON.stringify({
  snapshot: store.snapshot(),
  disk: await readFile(join(directory, 'snippets.json'), 'utf8'),
}));
