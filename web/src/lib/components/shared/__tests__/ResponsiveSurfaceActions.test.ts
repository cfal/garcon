import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installResizeObserverHarness, ResizeObserverHarness } from './resize-observer-harness.js';
import ResponsiveSurfaceActionsTestHost from './ResponsiveSurfaceActionsTestHost.svelte';
import ResponsiveSurfaceActions from '../ResponsiveSurfaceActions.svelte';
import Save from '@lucide/svelte/icons/save';

describe('ResponsiveSurfaceActions', () => {
	let restoreResizeObserver: () => void;

	beforeEach(() => {
		restoreResizeObserver = installResizeObserverHarness();
	});

	afterEach(() => {
		cleanup();
		restoreResizeObserver();
	});

	it.each([true, false])(
		'keeps shared primary roles and compact padding (label: %s)',
		(showLabel) => {
			render(ResponsiveSurfaceActions, {
				menuLabel: 'File actions',
				actions: [
					{
						id: 'save',
						label: 'Save',
						icon: Save,
						onclick: () => {},
						variant: 'primary',
						showLabel,
					},
				],
			});
			const button = screen.getByRole('button', { name: 'Save' });
			for (const className of [
				'bg-primary',
				'text-primary-foreground',
				'rounded-(--control-radius)',
				'focus-visible:ring-ring',
			]) {
				expect(button.classList).toContain(className);
			}
			expect(button.classList).not.toContain('bg-interactive-accent');
			expect(button.classList).not.toContain('has-[>svg]:px-2.5');
			expect(button.classList).toContain(showLabel ? 'has-[>svg]:px-2' : 'has-[>svg]:px-0');
			expect(button.classList).toContain(showLabel ? 'px-2' : 'px-0');
		},
	);

	it('keeps one persistent menu and moves lower-priority actions into it', async () => {
		const { container } = render(ResponsiveSurfaceActionsTestHost);
		await Promise.resolve();
		const root = container.querySelector<HTMLElement>('[data-responsive-surface-actions]');
		if (!root) throw new Error('Expected responsive action root');
		let availableWidth = 270;
		Object.defineProperty(root, 'clientWidth', { get: () => availableWidth });
		for (const element of container.querySelectorAll<HTMLElement>(
			'[data-surface-action-measure]',
		)) {
			const width =
				element.dataset.surfaceActionMeasure === 'filter'
					? 80
					: element.dataset.surfaceActionMeasure === 'project'
						? 100
						: 32;
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
		expect(screen.getByRole('button', { name: 'Refresh files' })).toBeTruthy();
		expect(screen.getAllByRole('button', { name: 'File browser actions' })).toHaveLength(1);

		availableWidth = 240;
		ResizeObserverHarness.emit(root, availableWidth);
		await Promise.resolve();
		expect(screen.getByRole('button', { name: 'Filter files' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Go to chat project' })).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Refresh files' })).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: 'File browser actions' }));
		expect(document.querySelector('[data-overflow-action="refresh"]')).toBeTruthy();
		expect(screen.getByText('Preferences')).toBeTruthy();
	});

	it('places leading menu content before a separator and overflow actions', async () => {
		const { container } = render(ResponsiveSurfaceActionsTestHost, {
			props: { leadingContent: true },
		});
		await Promise.resolve();
		const root = container.querySelector<HTMLElement>('[data-responsive-surface-actions]');
		if (!root) throw new Error('Expected responsive action root');
		Object.defineProperty(root, 'clientWidth', { get: () => 240 });
		for (const element of container.querySelectorAll<HTMLElement>(
			'[data-surface-action-measure]',
		)) {
			const width =
				element.dataset.surfaceActionMeasure === 'filter'
					? 80
					: element.dataset.surfaceActionMeasure === 'project'
						? 100
						: 32;
			element.getBoundingClientRect = () => ({ width }) as DOMRect;
		}
		const menuMeasure = container.querySelector<HTMLElement>(
			'[data-surface-action-overflow-measure]',
		);
		if (!menuMeasure) throw new Error('Expected menu measurement control');
		menuMeasure.getBoundingClientRect = () => ({ width: 32 }) as DOMRect;

		ResizeObserverHarness.emit(root, 240);
		await Promise.resolve();
		expect(screen.getAllByRole('button', { name: 'File browser actions' })).toHaveLength(1);
		expect(screen.queryByRole('button', { name: 'Refresh files' })).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: 'File browser actions' }));
		const leading = document.querySelector<HTMLElement>('[data-leading-menu-content]');
		const separator = document.querySelector<HTMLElement>('[data-slot="dropdown-menu-separator"]');
		const overflowAction = screen.getByRole('menuitem', { name: 'Refresh files' });
		if (!leading || !separator) throw new Error('Expected ordered menu content');
		expect(leading.compareDocumentPosition(separator) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
			0,
		);
		expect(
			separator.compareDocumentPosition(overflowAction) & Node.DOCUMENT_POSITION_FOLLOWING,
		).not.toBe(0);
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
