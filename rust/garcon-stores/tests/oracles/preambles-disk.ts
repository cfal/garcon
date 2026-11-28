import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BUNDLED_PREAMBLES } from '../../../../server/controller/preambles/bundled.ts';
import { PreambleStore } from '../../../../server/controller/preambles/store.ts';

const [operation, directory] = Bun.argv.slice(2);
if (operation === 'bundles') {
  console.log(JSON.stringify(BUNDLED_PREAMBLES, null, 2));
} else {
  if (!directory) throw new Error('A workspace directory is required');
  const path = join(directory, 'preambles.json');
  const store = new PreambleStore(directory);
  if (operation === 'open-error') {
    let error: unknown;
    try { await store.init(); } catch (cause) { error = cause; }
    if (!(error instanceof Error)) throw new Error('Expected the original to refuse the disk file');
    console.log(JSON.stringify({ message: error.message }));
    process.exit(0);
  }
  await store.init();
  switch (operation) {
    case 'write': {
      const now = new Date('2026-11-28T09:10:11.123Z');
      await store.installBundledPreambles(BUNDLED_PREAMBLES, now);
      const id = 'd36d22a1-49e9-4de3-b7ab-80668e845559';
      await store.create({
        id,
        enabled: true,
        title: 'Bun authored',
        snippetShortName: 'interop',
        content: 'Synthetic preamble',
        scope: { type: 'project-paths', rules: [
          { projectPath: 'C:/work/project', includeNested: true, executorId: null },
          { projectPath: '/srv/work', includeNested: false, executorId: '11111111-1111-4111-8111-111111111111' },
        ] },
        agentIds: [],
        tagFilter: { mode: 'any', tags: [] },
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      }, store.snapshot().revision);
      break;
    }
    case 'read':
      break;
    default:
      throw new Error(`Invalid oracle operation: ${operation}`);
  }
  console.log(JSON.stringify({
    snapshot: store.snapshot(),
    lifetimeIdCount: store.lifetimeIdCount(),
    file: await readFile(path, 'utf8'),
  }));
}
