import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import CliPresentationHeader from '../rows/CliPresentationHeader.svelte';

describe('CliPresentationHeader', () => {
	it('wraps and aligns titled headers on mobile while retaining desktop truncation', () => {
		const title = 'A complete CLI title that remains readable on a narrow mobile viewport';
		const { container } = render(CliPresentationHeader, {
			style: 'notice',
			title,
		});

		const titleElement = screen.getByText(title);
		expect(titleElement.classList.contains('break-words')).toBe(true);
		expect(titleElement.classList.contains('sm:truncate')).toBe(true);
		expect(titleElement.classList.contains('truncate')).toBe(false);
		expect(titleElement.getAttribute('title')).toBe(title);

		const header = titleElement.parentElement;
		expect(header?.classList.contains('items-start')).toBe(true);
		expect(header?.classList.contains('items-center')).toBe(false);
		expect(header?.querySelector('svg')?.classList.contains('mt-px')).toBe(true);
		expect(screen.getByText('CLI notice').classList.contains('sr-only')).toBe(true);
		expect(container.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
	});
});
