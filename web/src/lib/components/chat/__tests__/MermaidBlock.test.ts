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

	it('opens an expanded viewer with translated zoom and reset controls', async () => {
		render(MermaidBlock, { text: 'flowchart LR\nA --> B' });

		const fullscreenButton = await screen.findByRole('button', { name: 'Fullscreen' });
		await waitFor(() => expect((fullscreenButton as HTMLButtonElement).disabled).toBe(false));
		await fireEvent.click(fullscreenButton);

		const dialog = screen.getByRole('dialog');
		expect(dialog).toBeTruthy();
		expect(dialog.className).toContain('sm:max-w-none');
		const heading = screen.getByRole('heading', { name: 'Mermaid diagram' });
		expect(heading.className).toContain('min-w-0');
		expect(heading.parentElement?.className).toContain('min-w-0');
		const closeButton = screen.getByRole('button', { name: 'Close (Escape)' });
		expect(closeButton.parentElement?.className).toContain('shrink-0');
		const viewport = screen.getByRole('region', {
			name: 'Mermaid diagram viewport; drag to pan',
		});
		expect(viewport.getAttribute('tabindex')).toBe('0');
		expect(viewport.className).toContain('focus-visible:ring-2');
		expect(screen.getByText('100%')).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: 'Zoom in (+)' }));
		expect(screen.getByText('125%')).toBeTruthy();

		await fireEvent.keyDown(screen.getByRole('dialog'), { key: '-' });
		expect(screen.getByText('100%')).toBeTruthy();

		await fireEvent.keyDown(screen.getByRole('dialog'), { key: '+' });
		await fireEvent.click(screen.getByRole('button', { name: 'Reset view (0)' }));
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

	it('isolates drag ownership and releases it after capture loss and close', async () => {
		render(MermaidBlock, { text: 'flowchart LR\nA --> B' });

		const fullscreenButton = await screen.findByRole('button', { name: 'Fullscreen' });
		await waitFor(() => expect((fullscreenButton as HTMLButtonElement).disabled).toBe(false));
		await fireEvent.click(fullscreenButton);

		let viewport = screen.getByRole('region', {
			name: 'Mermaid diagram viewport; drag to pan',
		});
		const capturedPointers = new Set<number>();
		viewport.setPointerCapture = vi.fn((pointerId: number) => capturedPointers.add(pointerId));
		viewport.hasPointerCapture = vi.fn((pointerId: number) => capturedPointers.has(pointerId));
		viewport.releasePointerCapture = vi.fn((pointerId: number) =>
			capturedPointers.delete(pointerId),
		);
		viewport.scrollLeft = 100;
		viewport.scrollTop = 80;

		await fireEvent.pointerDown(viewport, {
			button: 0,
			clientX: 20,
			clientY: 20,
			isPrimary: true,
			pointerId: 1,
		});
		await fireEvent.pointerMove(viewport, { clientX: 40, clientY: 40, pointerId: 2 });
		expect(viewport.scrollLeft).toBe(100);
		expect(viewport.scrollTop).toBe(80);
		await fireEvent.pointerUp(viewport, { pointerId: 2 });
		expect(viewport.className).toContain('cursor-grabbing');

		await fireEvent(viewport, new PointerEvent('lostpointercapture', { pointerId: 1 }));
		expect(viewport.className).not.toContain('cursor-grabbing');
		await fireEvent.pointerDown(viewport, {
			button: 0,
			clientX: 20,
			clientY: 20,
			isPrimary: true,
			pointerId: 3,
		});
		expect(viewport.className).toContain('cursor-grabbing');

		await fireEvent.click(screen.getByRole('button', { name: 'Close (Escape)' }));
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect(viewport.releasePointerCapture).toHaveBeenCalledWith(3);

		await fireEvent.click(fullscreenButton);
		viewport = screen.getByRole('region', {
			name: 'Mermaid diagram viewport; drag to pan',
		});
		viewport.setPointerCapture = vi.fn();
		await fireEvent.pointerDown(viewport, {
			button: 0,
			clientX: 20,
			clientY: 20,
			isPrimary: true,
			pointerId: 4,
		});
		expect(viewport.setPointerCapture).toHaveBeenCalledWith(4);
		expect(viewport.className).toContain('cursor-grabbing');
	});
});
