import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import ImageViewer from '../ImageViewer.svelte';
import { FileSession } from '$lib/files/sessions/file-session.svelte.js';

describe('ImageViewer', () => {
	it('keeps manual zoom state on the file session across presentation remounts', async () => {
		const session = new FileSession(
			{
				canonicalFileRootPath: '/workspace/project',
				normalizedRelativePath: 'image.png',
			},
			'/workspace/project\0image.png',
		);
		const first = render(ImageViewer, { session });

		await fireEvent.click(screen.getByRole('button', { name: /Zoom in/ }));
		expect(session.image.mode).toBe('manual');
		expect(session.image.scale).toBe(1.25);
		expect(screen.getByText('125%')).toBeTruthy();

		first.unmount();
		render(ImageViewer, { session });
		expect(screen.getByText('125%')).toBeTruthy();
	});
});
