import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import type { Preamble, PreamblesSnapshot } from '$shared/preambles';
import PreamblesSectionTestHost from './PreamblesSectionTestHost.svelte';

function preamble(id: string, title: string, content: string): Preamble {
	return {
		id,
		title,
		content,
		scope: id === 'path'
			? {
					type: 'project-paths',
					rules: [{ projectPath: '/workspace/project', includeNested: true }],
				}
			: { type: 'global' },
		createdAt: '2029-01-01T00:00:00.000Z',
		updatedAt: '2029-01-01T00:00:00.000Z',
	};
}

describe('PreamblesSection', () => {
	it('filters by body and path and disables reordering while filtered', async () => {
		const snapshot: PreamblesSnapshot = {
			revision: 1,
			preambles: [
				preamble('global', 'Global conventions', 'Use the shared defaults.'),
				preamble('path', 'Project conventions', 'Run project checks.'),
			],
		};
		render(PreamblesSectionTestHost, { snapshot });
		const filter = screen.getByRole('searchbox', { name: 'Filter preambles' });

		await fireEvent.input(filter, { target: { value: 'project checks' } });
		expect(screen.queryByText('Global conventions')).toBeNull();
		expect(screen.getByText('Project conventions')).toBeTruthy();
		expect(
			(screen.getByRole('button', { name: 'Move preamble up' }) as HTMLButtonElement).disabled,
		).toBe(true);

		await fireEvent.input(filter, { target: { value: '/WORKSPACE/PROJECT' } });
		expect(screen.getByText('Project conventions')).toBeTruthy();
		await fireEvent.input(filter, { target: { value: 'missing' } });
		expect(screen.getByText('No matching preambles')).toBeTruthy();
	});
});
