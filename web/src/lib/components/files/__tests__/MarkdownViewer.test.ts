import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { FileSession } from '../file-session.svelte.js';
import MarkdownViewerTestHost from './MarkdownViewerTestHost.svelte';

describe('MarkdownViewer', () => {
	it('exposes its scrollable content as the primary focus target', () => {
		const session = new FileSession(
			{
				canonicalFileRootPath: '/workspace/project',
				normalizedRelativePath: 'README.md',
			},
			'/workspace/project:README.md',
		);
		session.content = '# Read me';

		render(MarkdownViewerTestHost, { session });

		const content = screen.getByRole('region', { name: 'README.md' });
		expect(content.getAttribute('tabindex')).toBe('-1');
		expect(content.hasAttribute('data-surface-primary')).toBe(true);
		content.focus();
		expect(document.activeElement).toBe(content);
	});
});
