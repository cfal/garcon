import { describe, expect, it } from 'vitest';
import { filterPreambles, matchesPreambleFilter } from '../preamble-filter';
import type { Preamble } from '$shared/preambles';

function preamble(overrides: Partial<Preamble> = {}): Preamble {
	return {
		id: 'preamble-a',
		title: 'Repository conventions',
		content: 'Run focused checks first.',
		scope: {
			type: 'project-paths',
			rules: [{ projectPath: '/workspace/project', includeNested: true }],
		},
		createdAt: '2029-01-01T00:00:00.000Z',
		updatedAt: '2029-01-01T00:00:00.000Z',
		...overrides,
	};
}

describe('preamble filter', () => {
	it('matches title, body, and project path case-insensitively', () => {
		const item = preamble();
		expect(matchesPreambleFilter(item, 'repository')).toBe(true);
		expect(matchesPreambleFilter(item, 'FOCUSED CHECKS')).toBe(true);
		expect(matchesPreambleFilter(item, '/WORKSPACE/PROJECT')).toBe(true);
		expect(matchesPreambleFilter(item, 'unrelated')).toBe(false);
	});

	it('preserves catalog order and treats whitespace as no filter', () => {
		const items = [
			preamble({ id: 'first', title: 'Shared title' }),
			preamble({ id: 'second', title: 'Shared title' }),
		];
		expect(filterPreambles(items, 'shared').map((item) => item.id)).toEqual(['first', 'second']);
		expect(filterPreambles(items, '   ')).toEqual(items);
	});
});
