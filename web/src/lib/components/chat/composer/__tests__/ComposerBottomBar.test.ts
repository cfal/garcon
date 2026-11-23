import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick, type ComponentProps } from 'svelte';
import { buildPermissionOptions, buildThinkingOptions } from '$lib/chat/composer/composer-controls';
import { ExecutorsStore } from '$lib/executors/executors-store.svelte';
import { localExecutor, remoteExecutor } from '$lib/executors/__tests__/fixtures';
import {
	installResizeObserverHarness,
	ResizeObserverHarness,
} from '../../../shared/__tests__/resize-observer-harness';
import ComposerBottomBar from '../ComposerBottomBar.svelte';

function controls() {
	return {
		image: { supported: true, unavailableReason: '', onSelect: vi.fn() },
		onOpenSnippetPalette: vi.fn(),
		onOpenExpandedEditor: vi.fn(),
		onRefinePrompt: vi.fn(),
		canRefinePrompt: true,
		permission: {
			options: buildPermissionOptions(['default', 'bypassPermissions']),
			selected: 'default',
			onSelect: vi.fn(),
		},
		effort: {
			options: buildThinkingOptions(['none', 'high']),
			selected: 'high',
			onSelect: vi.fn(),
		},
		send: { enabled: true, title: 'Send', onSend: vi.fn() },
	} satisfies ComponentProps<typeof ComposerBottomBar>;
}

async function resize(container: HTMLElement, width: number) {
	const toolbar = container.querySelector<HTMLElement>('[data-composer-toolbar]')!;
	ResizeObserverHarness.emit(toolbar, width);
	await tick();
	return toolbar;
}

describe('ComposerBottomBar', () => {
	let restoreObserver: () => void;
	beforeEach(() => {
		restoreObserver = installResizeObserverHarness();
	});
	afterEach(() => {
		cleanup();
		restoreObserver();
	});

	it('promotes image and snippet out of Add, then returns focus when a shortcut folds', async () => {
		const props = controls();
		const { container } = render(ComposerBottomBar, props);
		await resize(container, 800);
		expect(
			[
				...container.querySelectorAll<HTMLElement>(
					'[data-composer-group="prompt"] button:not([hidden])',
				),
			].map((button) => button.dataset.composerControl),
		).toEqual(['snippet', 'image', 'refine', 'expand']);
		const image = screen.getByRole('button', { name: 'Add image' });
		await fireEvent.click(image);
		expect(props.image.onSelect).toHaveBeenCalledOnce();
		expect(screen.queryByRole('button', { name: 'Add to prompt' })).toBeNull();
		image.focus();
		await resize(container, 122);
		const plus = screen.getByRole('button', { name: 'More composer actions' });
		expect(document.activeElement).toBe(plus);
		await fireEvent.click(plus);
		expect(screen.getAllByRole('menuitem').map((item) => item.dataset.composerControl)).toEqual([
			'snippet',
			'image',
			'refine',
			'expand',
		]);
		await fireEvent.click(screen.getByRole('menuitem', { name: /Snippets/ }));
		expect(props.onOpenSnippetPalette).toHaveBeenCalledOnce();
	});

	it('keeps both group orders and Send last when the local preference changes', async () => {
		const { container, rerender } = render(ComposerBottomBar, controls());
		const row = await resize(container, 800);
		const groups = () =>
			[...row.querySelectorAll<HTMLElement>('[data-composer-group]')].map(
				(g) => g.dataset.composerGroup,
			);
		const send = screen.getByRole('button', { name: 'Send' });
		expect(groups()).toEqual(['prompt', 'settings']);
		await rerender({ modelControlsLeft: true });
		expect(groups()).toEqual(['settings', 'prompt']);
		expect(row.lastElementChild).toBe(send);
	});

	it('returns focus to a promoted action even when other actions still overflow', async () => {
		const { container } = render(ComposerBottomBar, controls());
		await resize(container, 115);
		await fireEvent.click(screen.getByRole('button', { name: 'More composer actions' }));
		screen.getByRole('menuitem', { name: 'Open expanded composer' }).focus();
		await resize(container, 200);
		await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
		expect(document.activeElement).toBe(
			screen.getByRole('button', { name: 'Open expanded composer' }),
		);
	});

	it.each([
		['More composer actions', 'Snippets'],
		['More model settings', 'Thinking effort: High'],
	])(
		'keeps focus in the group when %s disappears without a highlighted item',
		async (name, first) => {
			const { container } = render(ComposerBottomBar, controls());
			await resize(container, 115);
			await fireEvent.click(screen.getByRole('button', { name }));
			screen.getByRole('menu').focus();
			await resize(container, 800);
			await waitFor(() =>
				expect(document.activeElement).toBe(screen.getByRole('button', { name: first })),
			);
		},
	);

	it('uses the same live executor choices in overflow and never refreshes on resize', async () => {
		const offline = { ...remoteExecutor, availability: 'offline' as const };
		const read = vi.fn(async () => [localExecutor, offline]);
		const executors = new ExecutorsStore(read);
		executors.applySnapshot([localExecutor, offline]);
		const onSelect = vi.fn();
		const { container } = render(ComposerBottomBar, {
			...controls(),
			executor: { executors, executorId: offline.id, onSelect },
		});
		await resize(container, 800);
		screen.getByRole('button', { name: 'Thinking effort: High' }).focus();
		await resize(container, 160);
		expect(screen.getByRole('button', { name: 'Executor: Worker' })).toBeTruthy();
		expect(document.activeElement).toBe(
			screen.getByRole('button', { name: 'More model settings' }),
		);
		await resize(container, 115);
		await fireEvent.click(screen.getByRole('button', { name: 'More model settings' }));
		const host = screen.getByRole('menuitem', { name: 'Executor: Worker' });
		expect(host.textContent).toContain('Worker');
		expect(read).not.toHaveBeenCalled();
		await fireEvent.keyDown(host, { key: 'ArrowRight' });
		const selected = await screen.findByRole('menuitemradio', { name: /Worker/ });
		expect(selected.getAttribute('aria-checked')).toBe('true');
		expect(selected.getAttribute('aria-disabled')).toBe('true');
		await fireEvent.click(screen.getByRole('menuitemradio', { name: 'Local' }));
		expect(read).toHaveBeenCalledOnce();
		expect(onSelect).toHaveBeenCalledExactlyOnceWith('local');
	});

	it('exposes hidden bypass and allows cancellation even when other prompt actions are blocked', async () => {
		const props = controls();
		const { container } = render(ComposerBottomBar, {
			...props,
			permission: { ...props.permission, selected: 'bypassPermissions' },
			isPromptRefinementPending: true,
			isPromptTransformPending: true,
			editingDisabled: true,
		});
		await resize(container, 115);
		await fireEvent.click(
			screen.getByRole('button', { name: 'More model settings: Bypass Permissions' }),
		);
		expect(
			screen.getByRole('menuitem', { name: 'Permission mode: Bypass Permissions' }),
		).toBeTruthy();
		await fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
		await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
		await fireEvent.click(screen.getByRole('button', { name: 'More composer actions' }));
		await fireEvent.click(screen.getByRole('menuitem', { name: /Cancel/ }));
		expect(props.onRefinePrompt).toHaveBeenCalledOnce();
		expect(props.send.onSend).not.toHaveBeenCalled();
	});

	it('hides controls the agent cannot configure', () => {
		render(ComposerBottomBar, {
			permission: {
				options: buildPermissionOptions(['bypassPermissions']),
				selected: 'bypassPermissions',
				onSelect: vi.fn(),
			},
			effort: { options: buildThinkingOptions(['none']), selected: 'none', onSelect: vi.fn() },
		});

		expect(
			screen.queryByRole('button', { name: 'Permission mode: Bypass Permissions' }),
		).toBeNull();
		expect(screen.queryByRole('button', { name: /Thinking effort/ })).toBeNull();
	});
});
