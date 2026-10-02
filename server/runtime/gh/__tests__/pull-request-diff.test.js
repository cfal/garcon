import { describe, it, expect } from 'bun:test';
import { parseMultiFileDiffPatches } from '../pull-request-diff.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initRepoWithCommit, runGitCommand } from '../../git/__tests__/repository-fixture.js';

const SAMPLE_DIFF = `diff --git a/src/added.ts b/src/added.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/src/added.ts
@@ -0,0 +1,2 @@
+export const a = 1;
+export const b = 2;
diff --git a/src/modified.ts b/src/modified.ts
index 1111111..2222222 100644
--- a/src/modified.ts
+++ b/src/modified.ts
@@ -1,3 +1,3 @@
 context line
-old line
+new line
 tail line
diff --git a/src/removed.ts b/src/removed.ts
deleted file mode 100644
index 3333333..0000000
--- a/src/removed.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-gone one
-gone two
`;

describe('parseMultiFileDiffPatches', () => {
  it('never interprets modified hunk content as path metadata', () => {
    const [file] = parseMultiFileDiffPatches('diff --git a/src/counter.ts b/src/counter.ts\n--- a/src/counter.ts\n+++ b/src/counter.ts\n@@ -1 +1 @@\n--- i;\n+++ i;\n');
    expect(file.path).toBe('src/counter.ts');
    expect(file.body.path).toBe('src/counter.ts');
    expect(file.body.patch).toContain('+++ i;');
    expect(file.additions).toBe(1);
    expect(file.deletions).toBe(1);
  });

  it('decodes real Git text, binary, rename and mode-only paths', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-gh-paths-'));
    try {
      await initRepoWithCommit(root);
      const names = ['a b.txt', 'a\tb.txt', 'caf\u00e9.txt', 'a"b.txt', 'a\\b.txt', 'space b/inside.txt'];
      for (const name of names) {
        await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
        await fs.writeFile(path.join(root, name), 'old\n');
        await fs.writeFile(path.join(root, `${name}.bin`), Buffer.from([0, 1]));
        await fs.writeFile(path.join(root, `${name}.rename`), 'rename\n');
        await fs.writeFile(path.join(root, `${name}.mode`), 'mode\n');
      }
      await runGitCommand(root, ['add', '.']);
      await runGitCommand(root, ['commit', '-m', 'synthetic path fixtures']);
      for (const name of names) {
        await fs.writeFile(path.join(root, name), 'new\n');
        await fs.writeFile(path.join(root, `${name}.bin`), Buffer.from([0, 2]));
        await fs.rename(path.join(root, `${name}.rename`), path.join(root, `${name}.renamed`));
        await fs.chmod(path.join(root, `${name}.mode`), 0o755);
      }
      await runGitCommand(root, ['add', '.']);
      for (const quotePath of ['true', 'false']) {
        const { stdout } = await runGitCommand(root, ['-c', `core.quotePath=${quotePath}`, 'diff', '--cached']);
        const files = parseMultiFileDiffPatches(stdout);
        expect(files).toHaveLength(names.length * 4);
        for (const name of names) {
          expect(files.find(file => file.path === name)).toMatchObject({ status: 'M', body: { path: name, bodyState: 'loaded' } });
          expect(files.find(file => file.path === `${name}.bin`)).toMatchObject({ isBinary: true });
          expect(files.find(file => file.path === `${name}.renamed`)).toMatchObject({ status: 'R', originalPath: `${name}.rename` });
          expect(files.find(file => file.path === `${name}.mode`)).toMatchObject({ status: 'M' });
        }
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('splits a multi-file diff into compact per-file bodies', () => {
    const files = parseMultiFileDiffPatches(SAMPLE_DIFF);
    expect(files.map((file) => file.path)).toEqual([
      'src/added.ts',
      'src/modified.ts',
      'src/removed.ts',
    ]);
  });

  it('derives add/modify/delete status and line counts', () => {
    const [added, modified, removed] = parseMultiFileDiffPatches(SAMPLE_DIFF);

    expect(added.status).toBe('A');
    expect(added.changeKind).toBe('added');
    expect(added.additions).toBe(2);
    expect(added.deletions).toBe(0);

    expect(modified.status).toBe('M');
    expect(modified.additions).toBe(1);
    expect(modified.deletions).toBe(1);

    expect(removed.status).toBe('D');
    expect(removed.changeKind).toBe('deleted');
    expect(removed.additions).toBe(0);
    expect(removed.deletions).toBe(2);
  });

  it('keeps patch text without allocating rendered row objects', () => {
    const [added] = parseMultiFileDiffPatches(SAMPLE_DIFF);
    expect(added.body.bodyState).toBe('loaded');
    expect(added.body.renderedRowCount).toBe(3);
    expect(added.body.patch).toContain('+export const a = 1;');
    expect(added.body).not.toHaveProperty('rows');
  });

  it('detects renames via rename headers', () => {
    const renameDiff = `diff --git a/old/name.ts b/new/name.ts
similarity index 90%
rename from old/name.ts
rename to new/name.ts
index 1111111..2222222 100644
--- a/old/name.ts
+++ b/new/name.ts
@@ -1,1 +1,1 @@
-const value = 1;
+const value = 2;
`;
    const [file] = parseMultiFileDiffPatches(renameDiff);
    expect(file.status).toBe('R');
    expect(file.path).toBe('new/name.ts');
    expect(file.originalPath).toBe('old/name.ts');
  });

  it('returns an empty list for empty input', () => {
    expect(parseMultiFileDiffPatches('')).toEqual([]);
    expect(parseMultiFileDiffPatches('   \n')).toEqual([]);
  });
});
