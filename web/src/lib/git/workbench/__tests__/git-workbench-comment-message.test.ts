import { describe, expect, it } from 'vitest';
import { buildGitWorkbenchCommentMessage } from '../git-workbench-comment-message.js';

describe('buildGitWorkbenchCommentMessage', () => {
	it('labels staged and unstaged line context explicitly', () => {
		const message = buildGitWorkbenchCommentMessage({
			filePath: 'src/app.ts',
			tab: 'unstaged',
			side: 'after',
			line: 12,
			contextLines: ['@@ -11,2 +11,2 @@', '+const next = true;'],
			body: 'Please cover this branch.',
			severity: 'warning',
		});

		expect(message).toContain('Comparison: current unstaged changes');
		expect(message).toContain('Location: `src/app.ts`:12 (new line)');
		expect(message).toContain('```diff\n@@ -11,2 +11,2 @@\n+const next = true;\n```');
		expect(message).toContain('Please cover this branch.');
	});
});
