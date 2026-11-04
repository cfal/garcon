import type { GitReviewFilePatchBody, GitReviewFileSummary } from '../../src/lib/api/git.js';

export function fixture(count: number, lines: number, lineLength = 0) {
	const files: GitReviewFileSummary[] = [];
	const bodies: GitReviewFilePatchBody[] = [];
	for (let file = 0; file < count; file += 1) {
		const path = `synthetic/file-${file}.ts`;
		const patch = `@@ -0,0 +1,${lines} @@\n${Array.from(
			{ length: lines },
			(_, i) => `+const value${i} = "synthetic ${i} ${'x'.repeat(lineLength)}";`,
		).join('\n')}\n`;
		files.push({
			path,
			bodyFingerprint: path,
			category: 'normal',
			isGenerated: false,
			isBinary: false,
			isTooLarge: false,
			estimatedRows: lines + 1,
			bodyState: 'unloaded',
			indexStatus: 'M',
			workTreeStatus: ' ',
			additions: lines,
			deletions: 0,
		});
		bodies.push({
			path,
			bodyFingerprint: path,
			category: 'normal',
			isBinary: false,
			isTooLarge: false,
			bodyState: 'loaded',
			patch,
			patchBytes: patch.length,
			renderedRowCount: lines + 1,
		});
	}
	return { files, bodies };
}
