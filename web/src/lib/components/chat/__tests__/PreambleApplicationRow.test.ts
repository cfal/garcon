import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import PreambleApplicationRow from '../rows/PreambleApplicationRow.svelte';

describe('PreambleApplicationRow', () => {
	it('renders immutable title snapshots as wrapping pills without catalog content', () => {
		const { container } = render(PreambleApplicationRow, {
			detail: {
				type: 'preamble-application',
				preambles: [
					{ id: 'preamble-a', title: 'Repository conventions' },
					{ id: 'preamble-b', title: 'Security constraints' },
				],
			},
		});

		expect(screen.getByText('Preambles applied')).toBeTruthy();
		expect(screen.getByText('Repository conventions')).toBeTruthy();
		expect(screen.getByText('Security constraints')).toBeTruthy();
		expect(container.textContent).not.toContain('private body');
		expect(container.querySelector('.flex-wrap')).toBeTruthy();
	});
});
