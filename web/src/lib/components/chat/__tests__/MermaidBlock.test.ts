import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MermaidBlock from '../MermaidBlock.svelte';
import { renderMermaid } from '../mermaid-loader';

vi.mock('../mermaid-loader', () => ({
	renderMermaid: vi.fn(),
}));

const mockedRenderMermaid = vi.mocked(renderMermaid);

describe('MermaidBlock', () => {
	beforeEach(() => {
		mockedRenderMermaid.mockResolvedValue(
			'<svg viewBox="0 0 200 100" aria-label="Rendered diagram"><rect width="200" height="100" /></svg>',
		);
	});

	it('opens an expanded viewer with zoom and reset controls', async () => {
		render(MermaidBlock, { text: 'flowchart LR\nA --> B' });

		const fullscreenButton = await screen.findByRole('button', { name: 'Fullscreen' });
		await waitFor(() => expect((fullscreenButton as HTMLButtonElement).disabled).toBe(false));
		await fireEvent.click(fullscreenButton);

		const dialog = screen.getByRole('dialog');
		expect(dialog).toBeTruthy();
		expect(dialog.className).toContain('sm:max-w-none');
		expect(screen.getByText('100%')).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: 'Zoom in (+)' }));
		expect(screen.getByText('125%')).toBeTruthy();

		await fireEvent.keyDown(screen.getByRole('dialog'), { key: '-' });
		expect(screen.getByText('100%')).toBeTruthy();

		await fireEvent.keyDown(screen.getByRole('dialog'), { key: '+' });
		await fireEvent.click(screen.getByRole('button', { name: 'Fit to window (0)' }));
		expect(screen.getByText('100%')).toBeTruthy();
	});

	it('closes the expanded viewer and resets zoom for the next open', async () => {
		render(MermaidBlock, { text: 'flowchart LR\nA --> B' });

		const fullscreenButton = await screen.findByRole('button', { name: 'Fullscreen' });
		await waitFor(() => expect((fullscreenButton as HTMLButtonElement).disabled).toBe(false));
		await fireEvent.click(fullscreenButton);
		await fireEvent.click(screen.getByRole('button', { name: 'Zoom in (+)' }));
		expect(screen.getByText('125%')).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: 'Close (Escape)' }));
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

		await fireEvent.click(fullscreenButton);
		expect(screen.getByText('100%')).toBeTruthy();
	});
});
