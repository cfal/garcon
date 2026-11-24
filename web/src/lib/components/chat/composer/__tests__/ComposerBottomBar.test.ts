import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
	beforeAll(() => {
		restoreObserver = installResizeObserverHarness();
	});
	afterAll(() => restoreObserver());
	afterEach(cleanup);

	it('fits fractional rem measurements and retains the last visible ruler width', async () => {
		const props = controls();
		const { container } = render(ComposerBottomBar, {
			image: props.image,
			onOpenSnippetPalette: props.onOpenSnippetPalette,
			send: props.send,
			permission: { ...props.permission, options: [] },
			effort: { ...props.effort, options: [] },
		});
		const row = await resize(container, 150);
		const ruler = row.previousElementSibling!;
		const snippet = () => screen.queryByRole('button', { name: 'Snippets' });
		const rem = 20.125;
		ResizeObserverHarness.emit(ruler, rem);
		await tick();
		expect(snippet()).toBeNull();
		ResizeObserverHarness.emit(ruler, 0);
		await tick();
		expect(snippet()).toBeNull();
		await resize(container, 7.5 * rem);
		expect(snippet()).toBeTruthy();
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

	it('keeps the image explanation reachable when every actionable button fits', async () => {
		const props = controls();
		const { container, rerender } = render(ComposerBottomBar, {
			...props,
			image: { ...props.image, supported: false, unavailableReason: 'Attachments are unavailable.' },
		});
		await resize(container, 800);
		expect(screen.queryByRole('button', { name: 'Add image' })).toBeNull();
		const add = screen.getByRole('button', { name: 'Add to prompt' });
		await fireEvent.keyDown(add, { key: 'Enter' });
		const image = await screen.findByRole('menuitem', { name: /Add image.*Attachments are unavailable/ });
		expect(image.getAttribute('aria-disabled')).toBe('true');
		expect(screen.getAllByRole('menuitem')).toEqual([image]);
		await fireEvent.click(image);
		expect(props.image.onSelect).not.toHaveBeenCalled();

		await rerender({ image: props.image });
		await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
		expect(screen.getByRole('button', { name: 'Add image' })).toBeTruthy();
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
		const { container, rerender } = render(ComposerBottomBar, {
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
		const local = screen.getByRole('menuitemradio', { name: 'Local' });
		await rerender({ settingsDisabled: true });
		expect(local.getAttribute('aria-disabled')).toBe('true');
		await fireEvent.click(local);
		expect(onSelect).not.toHaveBeenCalled();
		await rerender({ settingsDisabled: false });
		await fireEvent.click(local);
		expect(read).toHaveBeenCalledOnce();
		expect(onSelect).toHaveBeenCalledExactlyOnceWith('local');
	});

	it('restores keyboard focus when the last remote disappears from the open Executor submenu', async () => {
		const snapshot = [localExecutor, remoteExecutor];
		const executors = new ExecutorsStore(async () => snapshot);
		executors.applySnapshot(snapshot);
		const { container } = render(ComposerBottomBar, {
			...controls(),
			executor: { executors, executorId: 'local', onSelect: vi.fn() },
		});
		await resize(container, 115);
		const more = screen.getByRole('button', { name: 'More model settings' });
		await fireEvent.click(more);
		const host = screen.getByRole('menuitem', { name: 'Executor: Local' });
		await fireEvent.keyDown(host, { key: 'ArrowRight' });
		(await screen.findByRole('menuitemradio', { name: 'Local' })).focus();
		executors.applySnapshot([localExecutor]);
		await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
		expect(document.activeElement).toBe(more);
	});

	it('enables agent settings only when the group is unlocked and changes can be applied', async () => {
		const defaults = { ownerId: 'sample-agent', schemaVersion: 1, values: { review: false } };
		const agentSettings = {
			descriptors: [{ key: 'review', type: 'boolean', label: 'Review changes' }],
			envelope: defaults,
			defaults,
		} as const;
		const { rerender } = render(ComposerBottomBar, { ...controls(), agentSettings });
		const trigger = screen.getByRole('button', { name: 'Review changes: Off' });
		expect(trigger).toHaveProperty('disabled', true);
		await rerender({ agentSettings: { ...agentSettings, onChange: vi.fn() } });
		expect(trigger).toHaveProperty('disabled', false);
		await rerender({ settingsDisabled: true });
		expect(trigger).toHaveProperty('disabled', true);
	});

	it.each(['inline', 'overflow'])('locks an open %s permission menu during admission', async (placement) => {
		const props = controls();
		const { container, rerender } = render(ComposerBottomBar, props);
		await resize(container, placement === 'inline' ? 800 : 115);
		if (placement === 'inline') {
			await fireEvent.click(screen.getByRole('button', { name: /^Permission mode:/ }));
		} else {
			await fireEvent.click(screen.getByRole('button', { name: 'More model settings' }));
			await fireEvent.keyDown(screen.getByRole('menuitem', { name: /^Permission mode:/ }), { key: 'ArrowRight' });
		}
		const choice = await screen.findByRole('menuitemradio', { name: /Bypass Permissions/ });
		await rerender({ settingsDisabled: true });
		expect(choice.getAttribute('aria-disabled')).toBe('true');
		await fireEvent.click(choice);
		expect(props.permission.onSelect).not.toHaveBeenCalled();
		await rerender({ settingsDisabled: false });
		await fireEvent.click(choice);
		expect(props.permission.onSelect).toHaveBeenCalledExactlyOnceWith('bypassPermissions');
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
