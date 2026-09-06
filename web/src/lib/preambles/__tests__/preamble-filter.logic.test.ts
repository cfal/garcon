import { describe, expect, it } from 'vitest';
import { filterPreambles, matchesPreambleFilter } from '../preamble-filter';
import type { Preamble } from '$shared/preambles';

const PREAMBLE_A = '3502b645-222b-49d2-ac39-1c91f9fb1174';
const PREAMBLE_B = '80becfa6-c9c7-4b31-9190-fd23c0bedf9c';

function preamble(overrides: Partial<Preamble> = {}): Preamble {
	return {
		id: PREAMBLE_A,
		enabled: true,
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
			preamble({ id: PREAMBLE_A, title: 'Shared title' }),
			preamble({ id: PREAMBLE_B, title: 'Shared title' }),
		];
		expect(filterPreambles(items, 'shared').map((item) => item.id)).toEqual([
			PREAMBLE_A,
			PREAMBLE_B,
		]);
		expect(filterPreambles(items, '   ')).toEqual(items);
	});

	it('keeps disabled preambles searchable', () => {
		expect(matchesPreambleFilter(preamble({ enabled: false }), 'repository')).toBe(true);
	});
});
