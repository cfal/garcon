import { describe, it, expect } from 'bun:test';
import { renderMultiFileDiff } from '../diff-engine.js';

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

describe('renderMultiFileDiff', () => {
  it('splits a multi-file diff into per-file rendered bodies', () => {
    const files = renderMultiFileDiff(SAMPLE_DIFF);
    expect(files.map((file) => file.path)).toEqual([
      'src/added.ts',
      'src/modified.ts',
      'src/removed.ts',
    ]);
  });

  it('derives add/modify/delete status and line counts', () => {
    const [added, modified, removed] = renderMultiFileDiff(SAMPLE_DIFF);

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

  it('produces rendered rows reusing the workbench diff parser', () => {
    const [added] = renderMultiFileDiff(SAMPLE_DIFF);
    expect(added.body.bodyState).toBe('loaded');
    // one hunk row plus two added rows
    expect(added.body.rows).toHaveLength(3);
    expect(added.body.rows[0].kind).toBe('hunk');
    expect(added.body.rows[1].kind).toBe('add');
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
    const [file] = renderMultiFileDiff(renameDiff);
    expect(file.status).toBe('R');
    expect(file.path).toBe('new/name.ts');
    expect(file.originalPath).toBe('old/name.ts');
  });

  it('returns an empty list for empty input', () => {
    expect(renderMultiFileDiff('')).toEqual([]);
    expect(renderMultiFileDiff('   \n')).toEqual([]);
  });
});
