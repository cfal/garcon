import { describe, expect, it } from 'vitest';
import {
	candidateUnavailableReason,
	projectDraftSelection,
} from '$lib/preambles/selection-projection';
import type { Preamble, PreambleId } from '$shared/preambles';

const ID_A: PreambleId = '3502b645-222b-49d2-ac39-1c91f9fb1174';
const ID_B: PreambleId = '80becfa6-c9c7-4b31-9190-fd23c0bedf9c';
const ID_MISSING: PreambleId = '936903ad-8b98-43eb-a7d4-c17ce0dc18d8';

function preamble(id: PreambleId, overrides: Partial<Preamble> = {}): Preamble {
	return {
		id,
		enabled: true,
		title: `Title ${id}`,
		content: `Body ${id}`,
		scope: { type: 'global' },
		createdAt: '2029-01-01T00:00:00.000Z',
		updatedAt: '2029-01-01T00:00:00.000Z',
		...overrides,
	};
}

describe('projectDraftSelection', () => {
	it('keeps missing IDs in order and labels each unavailable reason', () => {
		const projected = projectDraftSelection({
			draftIds: [ID_MISSING, ID_A, ID_B],
			savedProjection: null,
			catalog: {
				preambles: [
					preamble(ID_A),
					preamble(ID_B, { enabled: false }),
				],
			},
			canonicalProjectPath: '/repo',
		});
		expect(projected.rows.map((row) => [row.id, row.reason])).toEqual([
			[ID_MISSING, 'missing'],
			[ID_A, null],
			[ID_B, 'disabled'],
		]);
		expect(projected.eligibleCount).toBe(1);
	});

	it('reports out-of-scope rows for non-matching project paths', () => {
		const scoped = preamble(ID_A, {
			scope: {
				type: 'project-paths',
				rules: [{ projectPath: '/work/project', includeNested: true }],
			},
		});
		const projected = projectDraftSelection({
			draftIds: [ID_A],
			savedProjection: null,
			catalog: { preambles: [scoped] },
			canonicalProjectPath: '/work/other',
		});
		expect(projected.rows[0]!.reason).toBe('out-of-scope');
		expect(projected.eligibleCount).toBe(0);
	});

	it('matches exact and nested scopes without sibling-prefix confusion', () => {
		const exact = preamble(ID_A, {
			scope: {
				type: 'project-paths',
				rules: [{ projectPath: '/work/project', includeNested: false }],
			},
		});
		const nested = preamble(ID_B, {
			scope: {
				type: 'project-paths',
				rules: [{ projectPath: '/work/project', includeNested: true }],
			},
		});
		const inside = projectDraftSelection({
			draftIds: [ID_A, ID_B],
			savedProjection: null,
			catalog: { preambles: [exact, nested] },
			canonicalProjectPath: '/work/project/child',
		});
		expect(inside.rows.map((row) => row.reason)).toEqual(['out-of-scope', null]);

		const sibling = projectDraftSelection({
			draftIds: [ID_A, ID_B],
			savedProjection: null,
			catalog: { preambles: [exact, nested] },
			canonicalProjectPath: '/work/project-other',
		});
		expect(sibling.rows.map((row) => row.reason)).toEqual(['out-of-scope', 'out-of-scope']);
	});

	it('matches normalized Windows paths without crossing drives or sibling prefixes', () => {
		const scoped = preamble(ID_A, {
			scope: {
				type: 'project-paths',
				rules: [{ projectPath: 'C:\\work\\project\\', includeNested: true }],
			},
		});
		for (const [projectPath, reason] of [
			['c:/work/project', null],
			['C:\\work\\project\\child', null],
			['c:/work/project-other', 'out-of-scope'],
			['d:/work/project/child', 'out-of-scope'],
		] as const) {
			const projected = projectDraftSelection({
				draftIds: [ID_A],
				savedProjection: null,
				catalog: { preambles: [scoped] },
				canonicalProjectPath: projectPath,
			});
			expect(projected.rows[0]!.reason).toBe(reason);
		}
	});

	it('prefers the current catalog title after an eligible preamble is renamed', () => {
		const projected = projectDraftSelection({
			draftIds: [ID_A],
			savedProjection: {
				catalogRevision: 3,
				eligiblePreambles: [{ id: ID_A, title: 'Saved title' }],
				unavailable: [],
			},
			catalog: { preambles: [preamble(ID_A)] },
			canonicalProjectPath: '/repo',
		});
		expect(projected.rows[0]!.title).toBe(`Title ${ID_A}`);
	});
});

describe('candidateUnavailableReason', () => {
	it('distinguishes disabled and out-of-scope candidates', () => {
		const scoped = preamble(ID_A, {
			scope: {
				type: 'project-paths',
				rules: [{ projectPath: '/repo', includeNested: true }],
			},
		});
		expect(candidateUnavailableReason(scoped, '/repo/child')).toBeNull();
		expect(candidateUnavailableReason(scoped, '/other')).toBe('out-of-scope');
		expect(
			candidateUnavailableReason(preamble(ID_B, { enabled: false }), '/repo'),
		).toBe('disabled');
	});
});
