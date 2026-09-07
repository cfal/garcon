import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import PreambleApplicationRow from '../rows/PreambleApplicationRow.svelte';

const PREAMBLE_A = '3502b645-222b-49d2-ac39-1c91f9fb1174';
const PREAMBLE_B = '80becfa6-c9c7-4b31-9190-fd23c0bedf9c';

describe('PreambleApplicationRow', () => {
	it('renders immutable title snapshots as wrapping pills without catalog content', () => {
		const { container } = render(PreambleApplicationRow, {
			detail: {
				type: 'preamble-application',
				preambles: [
					{ id: PREAMBLE_A, title: 'Repository conventions' },
					{ id: PREAMBLE_B, title: 'Security constraints' },
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
