import { describe, expect, it } from 'bun:test';
import {
  parseUnifiedPatchToRenderedRows,
  selectFilePatchFromRawDiff,
} from '../rendered-diff.js';

describe('parseUnifiedPatchToRenderedRows', () => {
  it('does not mix a second file into a single-file body', () => {
    const patch = `diff --git a/bin/tool b/bin/tool
deleted file mode 100644
--- a/bin/tool
+++ /dev/null
@@ -1 +0,0 @@
-old
diff --git a/bin/tool/main.sh b/bin/tool/main.sh
new file mode 100644
--- /dev/null
+++ b/bin/tool/main.sh
@@ -0,0 +1 @@
+new
`;

    const parsed = parseUnifiedPatchToRenderedRows(patch);

    expect(parsed.rows).toContainEqual(expect.objectContaining({ kind: 'del', text: 'old' }));
    expect(parsed.rows).not.toContainEqual(expect.objectContaining({ kind: 'add', text: 'new' }));
    expect(parsed.rows.some((row) => row.text.startsWith('++') || row.text.startsWith('--'))).toBe(false);
  });
});

describe('selectFilePatchFromRawDiff', () => {
  it('selects the requested destination using NUL-delimited raw metadata', () => {
    const rawPatch = [
      ':000000 100644 0000000 1111111 A\0bin/tool/aaa.sh\0',
      ':100644 100644 2222222 3333333 R087\0bin/tool\0bin/tool/main.sh\0',
      ':000000 100644 0000000 4444444 A\0bin/tool/zzz.bin\0',
      '\0',
      'diff --git a/bin/tool/aaa.sh b/bin/tool/aaa.sh\n@@ -0,0 +1 @@\n+sibling\n',
      'diff --git a/bin/tool b/bin/tool/main.sh\nrename from bin/tool\nrename to bin/tool/main.sh\n@@ -1 +1 @@\n-old\n+new\n',
      'diff --git a/bin/tool/zzz.bin b/bin/tool/zzz.bin\nBinary files /dev/null and b/bin/tool/zzz.bin differ\n',
    ].join('');

    const selected = selectFilePatchFromRawDiff(rawPatch, 'bin/tool/main.sh');

    expect(selected).toContain('rename to bin/tool/main.sh');
    expect(selected).toContain('+new');
    expect(selected).not.toContain('sibling');
    expect(selected).not.toContain('Binary files');
  });
});
