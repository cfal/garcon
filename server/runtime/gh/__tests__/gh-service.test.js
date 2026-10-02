import { afterEach, beforeEach, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGhOperations } from '../gh-service.js';

let root;
let originalPath;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-gh-pages-'));
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  await fs.copyFile(new URL('../../../remote/__tests__/fixtures/fake-gh.js', import.meta.url), path.join(bin, 'gh'));
  await fs.chmod(path.join(bin, 'gh'), 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
});
afterEach(async () => {
  process.env.PATH = originalPath;
  await fs.rm(root, { recursive: true, force: true });
});

const first = { id: 1, path: 'example.txt', line: 1, side: 'RIGHT', body: 'first page' };
const second = { id: 2, path: 'example.txt', line: 2, side: 'RIGHT', body: 'second page' };
for (const [label, commentPages, bodies] of [
  ['no pages', [], []],
  ['empty page', [[]], []],
  ['single page', [[first]], ['first page']],
  ['multiple pages', [[first], [second]], ['first page', 'second page']],
]) {
  it(`retains review comments with ${label}`, async () => {
    await fs.writeFile(path.join(root, 'gh-fixture.json'), JSON.stringify({ label: 'synthetic', commentPages }));
    const detail = await createGhOperations(root).getPullRequest({ projectPath: root, number: 1 });
    expect(detail.threads.flatMap(thread => thread.comments.map(comment => comment.body))).toEqual(bodies);
  });
}
