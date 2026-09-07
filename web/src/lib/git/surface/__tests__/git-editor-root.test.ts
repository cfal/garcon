import { describe, expect, it } from 'vitest';
import { resolveGitEditorRoot } from '../git-editor-root.js';

describe('resolveGitEditorRoot', () => {
	it('opens repository-relative comparison paths from the comparison root', () => {
		expect(
			resolveGitEditorRoot({
				activeProjectPath: '/repo/nested',
				targetRepoRoot: '/repo',
				reviewRepoRoot: '/comparison-root',
			}),
		).toBe('/comparison-root');
	});

	it('falls back to the selected project when target metadata is unavailable', () => {
		expect(
			resolveGitEditorRoot({
				activeProjectPath: '/repo/nested',
			}),
		).toBe('/repo/nested');
	});
});
