import { describe, expect, it } from 'bun:test';
import { parseUnifiedPatchToRenderedRows } from '../rendered-diff.js';

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
