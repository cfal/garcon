import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	installResizeObserverHarness,
	ResizeObserverHarness,
} from '../../shared/__tests__/resize-observer-harness.js';
import { CollapsibleBodyLayoutHarness } from './collapsible-body-layout-harness.js';
import CollapsibleBodyTestHost from './CollapsibleBodyTestHost.svelte';

describe('CollapsibleBody', () => {
	let layout: CollapsibleBodyLayoutHarness;
	let restoreResizeObserver: () => void;

	beforeAll(() => {
		restoreResizeObserver = installResizeObserverHarness();
	});

	beforeEach(() => {
		layout = new CollapsibleBodyLayoutHarness();
		layout.install();
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	afterAll(() => restoreResizeObserver());

	it('omits the disclosure when the collapsed body already shows all content', async () => {
		layout.contentHeight = 80;
		const { container } = render(CollapsibleBodyTestHost, { content: 'Short content' });

		await waitFor(() => {
			expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
			expect(screen.queryByRole('button', { name: 'Show less' })).toBeNull();
			expect(
				container.querySelector('[data-slot="collapsible-body"]')?.classList,
			).not.toContain('collapsible-body-truncated');
		});
	});

	it('does not fade content that fits within the collapsed height', async () => {
		layout.contentHeight = 136;
		const { container } = render(CollapsibleBodyTestHost, { content: 'Medium content' });

		await waitFor(() => {
			expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
			const body = container.querySelector<HTMLElement>('[data-slot="collapsible-body"]')!;
			expect(body.classList).toContain('collapsible-body-collapsed');
			expect(body.classList).not.toContain('collapsible-body-truncated');
		});
	});

	it('shows more content when the tall preview height is requested', async () => {
		layout.contentHeight = 220;
		const { container } = render(CollapsibleBodyTestHost, {
			content: 'Taller preview content',
			previewHeight: 'tall',
		});

		await waitFor(() => {
			expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
			expect(container.querySelector('[data-slot="collapsible-body"]')?.classList).toContain(
				'collapsible-body-tall',
			);
		});
	});

	it('normalizes restored expansion when the body now fits without clipping', async () => {
		layout.contentHeight = 80;
		const onExpandedChange = vi.fn();
		render(CollapsibleBodyTestHost, {
			content: 'Short restored content',
			expanded: true,
			onExpandedChange,
		});

		await waitFor(() => {
			expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
			expect(screen.queryByRole('button', { name: 'Show less' })).toBeNull();
			expect(onExpandedChange).toHaveBeenCalledWith(false);
		});
	});

	it('shows the disclosure only while the body exceeds the collapsed height', async () => {
		layout.contentHeight = 260;
		render(CollapsibleBodyTestHost, { content: 'Long content' });

		const showMore = await screen.findByRole('button', { name: 'Show more' });
		expect(showMore.getAttribute('aria-expanded')).toBe('false');
		expect(
			document.getElementById(showMore.getAttribute('aria-controls')!)?.classList,
		).not.toContain('collapsible-body-tall');
		expect(document.getElementById(showMore.getAttribute('aria-controls')!)?.classList).toContain(
			'collapsible-body-collapsed',
		);
		expect(document.getElementById(showMore.getAttribute('aria-controls')!)?.classList).toContain(
			'collapsible-body-truncated',
		);

		await fireEvent.click(showMore);
		expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe(
			'true',
		);
		expect(document.getElementById(showMore.getAttribute('aria-controls')!)?.classList).not.toContain(
			'collapsible-body-truncated',
		);
	});

	it('contains child margins consistently across the collapse threshold', async () => {
		layout.contentHeight = 159;
		layout.childMarginHeight = 4;
		render(CollapsibleBodyTestHost, { content: 'Threshold content', margined: true });

		await fireEvent.click(await screen.findByRole('button', { name: 'Show more' }));
		await waitFor(() => {
			expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe(
				'true',
			);
		});
	});

	it('remeasures after width and content reflow', async () => {
		layout.contentHeight = 260;
		const { container } = render(CollapsibleBodyTestHost, { content: 'Responsive content' });
		await screen.findByRole('button', { name: 'Show more' });

		const body = container.querySelector<HTMLElement>('[data-slot="collapsible-body"]')!;
		const content = container.querySelector<HTMLElement>('[data-slot="collapsible-body-content"]')!;
		layout.width = 900;
		layout.contentHeight = 80;
		ResizeObserverHarness.emit(body, layout.width, layout.contentHeight);
		ResizeObserverHarness.emit(content, layout.width, layout.contentHeight);
		await waitFor(() => expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull());

		layout.contentHeight = 260;
		ResizeObserverHarness.emit(content, layout.width, layout.contentHeight);
		await screen.findByRole('button', { name: 'Show more' });
	});

	it('returns an expanded body to its collapsed presentation when reflow removes overflow', async () => {
		layout.contentHeight = 260;
		const { container } = render(CollapsibleBodyTestHost, { content: 'Responsive content' });
		await fireEvent.click(await screen.findByRole('button', { name: 'Show more' }));

		const body = container.querySelector<HTMLElement>('[data-slot="collapsible-body"]')!;
		const content = container.querySelector<HTMLElement>('[data-slot="collapsible-body-content"]')!;
		layout.contentHeight = 80;
		ResizeObserverHarness.emit(content, layout.width, layout.contentHeight);

		await waitFor(() => {
			expect(screen.queryByRole('button', { name: 'Show less' })).toBeNull();
			expect(body.classList).toContain('collapsible-body-collapsed');
		});
	});

	it('expands overflowing interactive content before focus remains inside it', async () => {
		layout.contentHeight = 260;
		render(CollapsibleBodyTestHost, { content: 'Interactive content', focusable: true });
		await screen.findByRole('button', { name: 'Show more' });

		await fireEvent.focusIn(screen.getByRole('link', { name: 'Focusable content' }));
		expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy();
	});
});
