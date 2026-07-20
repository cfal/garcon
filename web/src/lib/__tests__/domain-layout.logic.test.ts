import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const expectedConcerns = {
	chat: [
		'actions',
		'composer',
		'conversation',
		'file-links',
		'new-chat',
		'project-paths',
		'sessions',
		'split',
		'tools',
		'transcript',
	],
	git: ['commit', 'history', 'pull-requests', 'review', 'surface', 'targets', 'workbench'],
	files: ['editor', 'sessions', 'tree'],
	terminal: ['runtime', 'sessions'],
	sidebar: ['projects', 'search'],
} as const;

describe('domain layout', () => {
	for (const [domain, concerns] of Object.entries(expectedConcerns)) {
		it(`keeps ${domain} modules in approved concerns`, () => {
			const entries = readdirSync(join(process.cwd(), 'src/lib', domain), {
				withFileTypes: true,
			});
			const allowed = new Set<string>([...concerns, '__tests__']);
			const expected = new Set<string>(concerns);
			const unexpected = entries
				.filter((entry) => !allowed.has(entry.name) || !entry.isDirectory())
				.map((entry) => entry.name)
				.sort();
			const actualConcerns = entries
				.filter((entry) => entry.isDirectory() && expected.has(entry.name))
				.map((entry) => entry.name)
				.sort();

			expect(unexpected, `${domain} has unexpected top-level entries`).toEqual([]);
			expect(actualConcerns, `${domain} is missing an approved concern`).toEqual(
				[...concerns].sort(),
			);
		});
	}
});
