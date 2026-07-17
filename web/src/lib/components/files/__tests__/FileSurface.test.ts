import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import FileSurfaceTestHost from './FileSurfaceTestHost.svelte';

afterEach(cleanup);

describe('FileSurface', () => {
	it('hides File Sessions from mobile file chrome', () => {
		const { container } = render(FileSurfaceTestHost, { presentation: 'mobile' });

		expect(container.querySelector('[data-surface-action-measure="open-files"]')).toBeNull();
	});

	it('retains File Sessions in desktop file chrome', () => {
		const { container } = render(FileSurfaceTestHost, { presentation: 'main' });

		expect(container.querySelector('[data-surface-action-measure="open-files"]')).not.toBeNull();
	});
});
