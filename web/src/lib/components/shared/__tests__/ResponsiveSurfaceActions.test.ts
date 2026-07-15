import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installResizeObserverHarness, ResizeObserverHarness } from './resize-observer-harness.js';
import ResponsiveSurfaceActionsTestHost from './ResponsiveSurfaceActionsTestHost.svelte';

describe('ResponsiveSurfaceActions', () => {
	let restoreResizeObserver: () => void;

	beforeEach(() => {
		restoreResizeObserver = installResizeObserverHarness();
	});

	afterEach(() => {
		cleanup();
		restoreResizeObserver();
	});

	it('keeps one persistent menu and moves lower-priority actions into it', async () => {
		const { container } = render(ResponsiveSurfaceActionsTestHost);
		await Promise.resolve();
		const root = container.querySelector<HTMLElement>('[data-responsive-surface-actions]');
		if (!root) throw new Error('Expected responsive action root');
		let availableWidth = 240;
		Object.defineProperty(root, 'clientWidth', { get: () => availableWidth });
		for (const element of container.querySelectorAll<HTMLElement>(
			'[data-surface-action-measure]',
		)) {
			const width = element.dataset.surfaceActionMeasure === 'filter' ? 80 : 100;
			element.getBoundingClientRect = () => ({ width }) as DOMRect;
		}
		const menuMeasure = container.querySelector<HTMLElement>(
			'[data-surface-action-overflow-measure]',
		);
		if (!menuMeasure) throw new Error('Expected menu measurement control');
		menuMeasure.getBoundingClientRect = () => ({ width: 32 }) as DOMRect;

		ResizeObserverHarness.emit(root, availableWidth);
		await Promise.resolve();
		expect(screen.getByRole('button', { name: 'Filter files' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Go to chat project' })).toBeTruthy();
		expect(screen.getAllByRole('button', { name: 'File browser actions' })).toHaveLength(1);

		availableWidth = 200;
		ResizeObserverHarness.emit(root, availableWidth);
		await Promise.resolve();
		expect(screen.getByRole('button', { name: 'Filter files' })).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Go to chat project' })).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: 'File browser actions' }));
		expect(document.querySelector('[data-overflow-action="project"]')).toBeTruthy();
		expect(screen.getByText('Preferences')).toBeTruthy();
	});

	it('disconnects every observer on destroy', async () => {
		const rendered = render(ResponsiveSurfaceActionsTestHost);
		await Promise.resolve();
		expect(ResizeObserverHarness.instances.some((observer) => observer.observed.size > 0)).toBe(
			true,
		);

		rendered.unmount();
		expect(ResizeObserverHarness.instances.every((observer) => observer.observed.size === 0)).toBe(
			true,
		);
	});
});
