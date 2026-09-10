import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import GarconMark from '../GarconMark.svelte';

describe('GarconMark', () => {
	it('renders the Fork Tail geometry with caller-provided sizing classes', () => {
		const { container } = render(GarconMark, { props: { class: 'size-8' } });
		const svg = container.querySelector('svg');

		expect(svg?.getAttribute('class')).toContain('size-8');
		expect(svg?.getAttribute('viewBox')).toBe('0 0 256 256');
		expect(svg?.querySelectorAll('path')).toHaveLength(2);
		expect(svg?.querySelectorAll('circle')).toHaveLength(3);
	});
});
