import { describe, it, expect } from 'bun:test';
import { parseMultiFileDiffPatches } from '../diff-engine.js';

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
