import { mkdir, writeFile } from 'node:fs/promises';
import { contractWireShapes } from './wire-shapes.js';
import errors from '../rpc-errors-v1.json';

export async function addMissingFixtures(directory: URL, fixtures: Readonly<Record<string, unknown>>): Promise<void> {
  const missing: { url: URL; content: string }[] = [];
  const changed: string[] = [];
  for (const [name, value] of Object.entries(fixtures)) {
    const url = new URL(`${name}.json`, directory);
    const content = `${JSON.stringify(value, null, 2)}\n`;
    if (!await Bun.file(url).exists()) missing.push({ url, content });
    else if (await Bun.file(url).text() !== content) changed.push(name);
  }
  if (changed.length) throw new Error(`Existing contract fixtures differ; add a new version instead:\n${changed.join('\n')}`);
  for (const { url, content } of missing) {
    await mkdir(new URL('./', url), { recursive: true });
    await writeFile(url, content, { flag: 'wx' });
  }
}

if (import.meta.main) {
  if (process.argv[2] !== '--add-missing') throw new Error('Only missing contract versions may be added (--add-missing)');
  const shapes = contractWireShapes();
  await addMissingFixtures(new URL('./fixtures/', import.meta.url), {
    ...Object.fromEntries(Object.entries(shapes.contracts).map(([name, shape]) => [`contracts/${name}`, shape])),
    'bootstrap-1-shapes': shapes.bootstrap, 'cli-bootstrap-1-shapes': shapes.cliBootstrap, 'rpc-errors-v1': errors,
  });
}
