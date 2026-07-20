import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MermaidBlock from '../MermaidBlock.svelte';
import { renderMermaid } from '../mermaid-loader';

vi.mock('../mermaid-loader', () => ({
	renderMermaid: vi.fn(),
}));

const mockedRenderMermaid = vi.mocked(renderMermaid);

describe('MermaidBlock', () => {
	beforeEach(() => {
		vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
		vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
		mockedRenderMermaid.mockResolvedValue(
			'<svg viewBox="0 0 200 100" aria-label="Rendered diagram"><rect width="200" height="100" /></svg>',
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('opens an expanded viewer with translated zoom and fit controls', async () => {
		render(MermaidBlock, { text: 'flowchart LR\nA --> B' });

		const expandButton = await screen.findByRole('button', { name: 'Expand diagram' });
		await waitFor(() => expect((expandButton as HTMLButtonElement).disabled).toBe(false));
		await fireEvent.click(expandButton);

		const dialog = screen.getByRole('dialog');
		expect(dialog).toBeTruthy();
		expect(dialog.className).toContain('sm:max-w-none');
		const heading = screen.getByRole('heading', { name: 'Mermaid diagram' });
		expect(heading.className).toContain('min-w-0');
		expect(heading.parentElement?.className).toContain('min-w-0');
		const closeButton = screen.getByRole('button', { name: 'Close (Escape)' });
		expect(closeButton.parentElement?.className).toContain('shrink-0');
		const viewport = screen.getByRole('region', {
			name: 'Mermaid diagram viewport; drag to pan, pinch or Control- or Command-wheel to zoom',
		});
		expect(viewport.getAttribute('tabindex')).toBe('0');
		expect(viewport.className).toContain('focus-visible:ring-2');
		expect(screen.getByText('100%')).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: 'Zoom in (+)' }));
		expect(screen.getByText('125%')).toBeTruthy();

		await fireEvent.keyDown(screen.getByRole('dialog'), { key: '-' });
		expect(screen.getByText('100%')).toBeTruthy();

		await fireEvent.keyDown(screen.getByRole('dialog'), { key: '+' });
		await fireEvent.click(screen.getByRole('button', { name: 'Fit to window (0)' }));
		expect(screen.getByText('100%')).toBeTruthy();
	});

	it('closes the expanded viewer and fits the next open', async () => {
		render(MermaidBlock, { text: 'flowchart LR\nA --> B' });

		const expandButton = await screen.findByRole('button', { name: 'Expand diagram' });
		await waitFor(() => expect((expandButton as HTMLButtonElement).disabled).toBe(false));
		await fireEvent.click(expandButton);
		await fireEvent.click(screen.getByRole('button', { name: 'Zoom in (+)' }));
		expect(screen.getByText('125%')).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: 'Close (Escape)' }));
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

		await fireEvent.click(expandButton);
		expect(screen.getByText('100%')).toBeTruthy();
	});

	it('isolates drag ownership and releases it after capture loss and close', async () => {
		render(MermaidBlock, { text: 'flowchart LR\nA --> B' });

		const expandButton = await screen.findByRole('button', { name: 'Expand diagram' });
		await waitFor(() => expect((expandButton as HTMLButtonElement).disabled).toBe(false));
		await fireEvent.click(expandButton);

		let viewport = screen.getByRole('region', {
			name: 'Mermaid diagram viewport; drag to pan, pinch or Control- or Command-wheel to zoom',
		});
		const capturedPointers = new Set<number>();
		viewport.setPointerCapture = vi.fn((pointerId: number) => capturedPointers.add(pointerId));
		viewport.hasPointerCapture = vi.fn((pointerId: number) => capturedPointers.has(pointerId));
		viewport.releasePointerCapture = vi.fn((pointerId: number) =>
			capturedPointers.delete(pointerId),
		);
		Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 100 });
		Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 80 });
		await fireEvent.click(screen.getByRole('button', { name: 'Fit to window (0)' }));
		for (let zoomStep = 0; zoomStep < 4; zoomStep += 1) {
			await fireEvent.click(screen.getByRole('button', { name: 'Zoom in (+)' }));
		}
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

		await fireEvent.click(expandButton);
		viewport = screen.getByRole('region', {
			name: 'Mermaid diagram viewport; drag to pan, pinch or Control- or Command-wheel to zoom',
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

	it('zooms around a two-pointer pinch gesture', async () => {
		render(MermaidBlock, { text: 'flowchart LR\nA --> B' });

		const expandButton = await screen.findByRole('button', { name: 'Expand diagram' });
		await waitFor(() => expect((expandButton as HTMLButtonElement).disabled).toBe(false));
		await fireEvent.click(expandButton);
		const viewport = screen.getByRole('region', {
			name: 'Mermaid diagram viewport; drag to pan, pinch or Control- or Command-wheel to zoom',
		});
		const capturedPointers = new Set<number>();
		viewport.setPointerCapture = vi.fn((pointerId: number) => capturedPointers.add(pointerId));
		viewport.hasPointerCapture = vi.fn((pointerId: number) => capturedPointers.has(pointerId));
		viewport.releasePointerCapture = vi.fn((pointerId: number) =>
			capturedPointers.delete(pointerId),
		);

		await fireEvent.pointerDown(viewport, {
			button: 0,
			clientX: 100,
			clientY: 100,
			pointerId: 1,
			pointerType: 'touch',
		});
		await fireEvent.pointerDown(viewport, {
			button: 0,
			clientX: 200,
			clientY: 100,
			pointerId: 2,
			pointerType: 'touch',
		});
		await fireEvent.pointerMove(viewport, {
			clientX: 300,
			clientY: 100,
			pointerId: 2,
			pointerType: 'touch',
		});

		expect(screen.getByText('200%')).toBeTruthy();
		expect(viewport.className).toContain('cursor-grabbing');

		await fireEvent.pointerDown(viewport, {
			button: 0,
			clientX: 250,
			clientY: 100,
			pointerId: 3,
			pointerType: 'touch',
		});
		await fireEvent.pointerUp(viewport, { pointerId: 2, pointerType: 'touch' });
		await fireEvent.pointerMove(viewport, {
			clientX: 400,
			clientY: 100,
			pointerId: 3,
			pointerType: 'touch',
		});
		expect(screen.getByText('400%')).toBeTruthy();
		await fireEvent.pointerUp(viewport, { pointerId: 3, pointerType: 'touch' });
		const settledScrollLeft = viewport.scrollLeft;
		await fireEvent.pointerMove(viewport, {
			clientX: 80,
			clientY: 100,
			pointerId: 1,
			pointerType: 'touch',
		});
		expect(viewport.scrollLeft).toBe(settledScrollLeft + 20);
		expect(viewport.className).toContain('cursor-grabbing');
	});

	it('preserves one cursor focal point across a rapid wheel burst', async () => {
		render(MermaidBlock, { text: 'flowchart LR\nA --> B' });

		const expandButton = await screen.findByRole('button', { name: 'Expand diagram' });
		await waitFor(() => expect((expandButton as HTMLButtonElement).disabled).toBe(false));
		await fireEvent.click(expandButton);
		const viewport = screen.getByRole('region', {
			name: 'Mermaid diagram viewport; drag to pan, pinch or Control- or Command-wheel to zoom',
		});
		const stage = viewport.querySelector<HTMLElement>('.mermaid-zoom-stage');
		expect(stage).toBeTruthy();
		Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 100 });
		Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 80 });
		viewport.getBoundingClientRect = () => new DOMRect(0, 0, 100, 80);
		stage!.getBoundingClientRect = () =>
			new DOMRect(
				Number.parseFloat(stage!.style.left) - viewport.scrollLeft,
				Number.parseFloat(stage!.style.top) - viewport.scrollTop,
				Number.parseFloat(stage!.style.width),
				Number.parseFloat(stage!.style.height),
			);
		await fireEvent.click(screen.getByRole('button', { name: 'Fit to window (0)' }));
		await waitFor(() => expect(screen.getByText('26%')).toBeTruthy());

		for (let eventIndex = 0; eventIndex < 2; eventIndex += 1) {
			const wheelEvent = new Event('wheel', { bubbles: true, cancelable: true });
			Object.defineProperties(wheelEvent, {
				ctrlKey: { value: true },
				metaKey: { value: false },
				clientX: { value: 50 },
				clientY: { value: 40 },
				deltaY: { value: -500 },
			});
			await fireEvent(viewport, wheelEvent);
			await tick();
		}
		expect(screen.queryByText('26%')).toBeNull();
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
		);

		const stageRect = stage!.getBoundingClientRect();
		expect((50 - stageRect.left) / stageRect.width).toBeCloseTo(0.5, 3);
		expect((40 - stageRect.top) / stageRect.height).toBeCloseTo(0.5, 3);
	});

	it('allows touch panning when only the padded canvas overflows', async () => {
		mockedRenderMermaid.mockResolvedValue(
			'<svg viewBox="0 0 630 100" aria-label="Nearly full-width diagram"></svg>',
		);
		render(MermaidBlock, { text: 'flowchart LR\nA --> B' });

		const expandButton = await screen.findByRole('button', { name: 'Expand diagram' });
		await waitFor(() => expect((expandButton as HTMLButtonElement).disabled).toBe(false));
		await fireEvent.click(expandButton);
		const viewport = screen.getByRole('region', {
			name: 'Mermaid diagram viewport; drag to pan, pinch or Control- or Command-wheel to zoom',
		});
		const stage = viewport.querySelector<HTMLElement>('.mermaid-zoom-stage');
		const canvas = viewport.querySelector<HTMLElement>('.mermaid-canvas');
		expect(stage).toBeTruthy();
		expect(canvas).toBeTruthy();
		await waitFor(() => expect(Number.parseFloat(stage!.style.width)).toBe(630));

		await fireEvent.click(screen.getByRole('button', { name: 'Zoom in (+)' }));
		expect(Number.parseFloat(stage!.style.width)).toBeLessThan(viewport.clientWidth);
		expect(Number.parseFloat(canvas!.style.width)).toBeGreaterThan(viewport.clientWidth);
		expect(viewport.className).toContain('cursor-grab');

		viewport.setPointerCapture = vi.fn();
		viewport.hasPointerCapture = vi.fn().mockReturnValue(false);
		const initialScrollLeft = viewport.scrollLeft;
		await fireEvent.pointerDown(viewport, {
			button: 0,
			clientX: 100,
			clientY: 100,
			pointerId: 1,
			pointerType: 'touch',
		});
		await fireEvent.pointerMove(viewport, {
			clientX: 80,
			clientY: 100,
			pointerId: 1,
			pointerType: 'touch',
		});
		expect(viewport.scrollLeft).toBe(initialScrollLeft + 20);
	});

	it('keeps outward zoom at an extreme fitted scale and labels it below one percent', async () => {
		mockedRenderMermaid.mockResolvedValue(
			'<svg viewBox="0 0 1000000 100" aria-label="Wide diagram"></svg>',
		);
		render(MermaidBlock, { text: 'flowchart LR\nA --> B' });

		const expandButton = await screen.findByRole('button', { name: 'Expand diagram' });
		await waitFor(() => expect((expandButton as HTMLButtonElement).disabled).toBe(false));
		await fireEvent.click(expandButton);
		await waitFor(() => expect(screen.getByText('<1%')).toBeTruthy());
		const viewport = screen.getByRole('region', {
			name: 'Mermaid diagram viewport; drag to pan, pinch or Control- or Command-wheel to zoom',
		});
		const stage = viewport.querySelector<HTMLElement>('.mermaid-zoom-stage');
		const fittedWidth = stage!.style.width;

		const zoomOutButton = screen.getByRole('button', { name: 'Zoom out (-)' });
		expect((zoomOutButton as HTMLButtonElement).disabled).toBe(true);
		const inwardWheelEvent = new Event('wheel', { bubbles: true, cancelable: true });
		Object.defineProperties(inwardWheelEvent, {
			ctrlKey: { value: true },
			metaKey: { value: false },
			deltaY: { value: -1500 },
			clientX: { value: 400 },
			clientY: { value: 300 },
		});
		await fireEvent(viewport, inwardWheelEvent);
		await tick();
		expect(screen.getByText('2%')).toBeTruthy();
		expect((zoomOutButton as HTMLButtonElement).disabled).toBe(false);

		await fireEvent.click(zoomOutButton);
		expect(screen.getByText('<1%')).toBeTruthy();
		expect((zoomOutButton as HTMLButtonElement).disabled).toBe(true);
		const wheelEvent = new Event('wheel', { bubbles: true, cancelable: true });
		Object.defineProperties(wheelEvent, {
			ctrlKey: { value: true },
			metaKey: { value: false },
			deltaY: { value: 100 },
			clientX: { value: 400 },
			clientY: { value: 300 },
		});
		await fireEvent(viewport, wheelEvent);
		await tick();

		expect(screen.getByText('<1%')).toBeTruthy();
		expect(stage!.style.width).toBe(fittedWidth);
	});
});
