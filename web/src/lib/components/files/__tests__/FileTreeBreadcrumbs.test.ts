import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	installResizeObserverHarness,
	ResizeObserverHarness,
} from '../../shared/__tests__/resize-observer-harness.js';
import FileTreeBreadcrumbs from '../FileTreeBreadcrumbs.svelte';

const breadcrumbs = [
	{ name: 'workspace', path: '/workspace' },
	{ name: 'team', path: '/workspace/team' },
	{ name: 'project', path: '/workspace/team/project' },
	{ name: 'src', path: '/workspace/team/project/src' },
];

describe('FileTreeBreadcrumbs', () => {
	let restoreResizeObserver: () => void;

	beforeEach(() => {
		restoreResizeObserver = installResizeObserverHarness();
	});

	afterEach(() => {
		cleanup();
		restoreResizeObserver();
	});

	it('moves middle segments into one overflow menu when space contracts', async () => {
		const onNavigate = vi.fn();
		const { container } = render(FileTreeBreadcrumbs, { breadcrumbs, onNavigate });
		await tick();
		const root = container.querySelector<HTMLElement>('[data-file-tree-breadcrumbs] > div');
		if (!root) throw new Error('Expected breadcrumb layout root');
		let availableWidth = 400;
		Object.defineProperty(root, 'clientWidth', { get: () => availableWidth });
		for (const element of container.querySelectorAll<HTMLElement>('[data-breadcrumb-measure]')) {
			element.getBoundingClientRect = () => ({ width: 60 }) as DOMRect;
		}
		const separator = container.querySelector<HTMLElement>('[data-breadcrumb-separator-measure]');
		const overflow = container.querySelector<HTMLElement>('[data-breadcrumb-overflow-measure]');
		if (!separator || !overflow) throw new Error('Expected breadcrumb measurement controls');
		separator.getBoundingClientRect = () => ({ width: 12 }) as DOMRect;
		overflow.getBoundingClientRect = () => ({ width: 24 }) as DOMRect;

		ResizeObserverHarness.emit(root, availableWidth);
		await tick();
		expect(screen.getByRole('button', { name: '/workspace/team' })).toBeTruthy();

		availableWidth = 190;
		ResizeObserverHarness.emit(root, availableWidth);
		await tick();
		expect(screen.queryByRole('button', { name: '/workspace/team' })).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: 'File location' }));
		expect(screen.getByRole('menuitem', { name: '/workspace/team' })).toBeTruthy();
		expect(screen.getByRole('menuitem', { name: '/workspace/team/project' })).toBeTruthy();

		await fireEvent.click(screen.getByRole('menuitem', { name: '/workspace/team' }));
		expect(onNavigate).toHaveBeenCalledWith(1);
	});

	it('disconnects its measurement observer on destroy', async () => {
		const rendered = render(FileTreeBreadcrumbs, {
			breadcrumbs,
			onNavigate: vi.fn(),
		});
		await tick();
		expect(ResizeObserverHarness.instances.some((observer) => observer.observed.size > 0)).toBe(
			true,
		);

		rendered.unmount();
		expect(ResizeObserverHarness.instances.every((observer) => observer.observed.size === 0)).toBe(
			true,
		);
	});
});
