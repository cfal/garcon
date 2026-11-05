import { expect, it, vi } from 'vitest';
import { loadCodeMirrorLanguageForFile } from '$lib/highlighting/codemirror-language-registry.js';
import { highlightGitDiffSyntheticSide } from '../git-diff-syntax-highlighter.js';
import type { GitDiffSyntheticSide } from '../git-diff-syntax.js';

// Keeps the real parser/projector boundary independent of machine speed on a large input.
vi.mock('../git-diff-syntax.js', async (importOriginal) => {
	const original = await importOriginal<typeof import('../git-diff-syntax.js')>();
	return {
		...original,
		GIT_DIFF_SYNTAX_LIMITS: { ...original.GIT_DIFF_SYNTAX_LIMITS, maxSegmentsPerSide: 1 },
	};
});

function side(lines: string[]): GitDiffSyntheticSide {
	const text = lines.join('\n');
	return {
		text,
		characterCount: text.length,
		lines: lines.map((text, diffLineIndex) => ({ text, diffLineIndex })),
	};
}

it('accepts the segment budget boundary and discards partial projection when it is exceeded', async () => {
	const loaded = await loadCodeMirrorLanguageForFile('synthetic.ts');
	if (!loaded) throw new Error('Expected TypeScript language');
	expect(highlightGitDiffSyntheticSide(side(['1']), 'synthetic.ts', loaded)).toMatchObject({
		status: 'highlighted',
		result: { segmentCount: 1 },
	});
	expect(highlightGitDiffSyntheticSide(side(['1', '2']), 'synthetic.ts', loaded)).toEqual({
		status: 'plain',
		reason: 'segment-limit',
	});
});
