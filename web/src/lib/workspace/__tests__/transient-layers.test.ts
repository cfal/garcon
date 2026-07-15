import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import { ChatInteractionGate } from '../chat-interaction-gate.svelte';
import { TransientLayerRegistry } from '../transient-layers.svelte';
import TransientLayerRegistrationHost from './TransientLayerRegistrationHost.svelte';

afterEach(() => {
	vi.useRealTimers();
});

function keyboardEscape(): KeyboardEvent {
	return new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
}

describe('TransientLayerRegistry', () => {
	it('does not subscribe a registering effect to internal layer mutations', async () => {
		const onRun = vi.fn();
		render(TransientLayerRegistrationHost, {
			layers: new TransientLayerRegistry(new ChatInteractionGate()),
			onRun,
		});
		await Promise.resolve();

		expect(onRun).toHaveBeenCalledOnce();
	});

	it('makes the main view inert before open state mutates and through registration', () => {
		vi.useFakeTimers();
		const gate = new ChatInteractionGate();
		const cancel = vi.fn();
		gate.register({ cancelApplicationDrag: cancel });
		const layers = new TransientLayerRegistry(gate);
		let inertDuringMutation = false;

		layers.open('main-inert', () => {
			inertDuringMutation = layers.makesMainInert;
			expect(gate.isChatDropEligible).toBe(false);
		});
		expect(cancel).toHaveBeenCalledOnce();
		expect(inertDuringMutation).toBe(true);
		expect(layers.makesMainInert).toBe(true);

		const element = document.createElement('div');
		document.body.append(element);
		const unregister = layers.register({
			id: 'dialog',
			kind: 'application-dialog',
			modality: 'main-inert',
			element: () => element,
			onEscape: () => true,
			restoreFocus: () => undefined,
		});
		vi.runAllTimers();
		expect(layers.hasPendingMainInert).toBe(false);
		expect(layers.makesMainInert).toBe(true);

		unregister();
		element.remove();
		expect(layers.makesMainInert).toBe(false);
		expect(gate.isChatDropEligible).toBe(true);
	});

	it('releases a failed-to-mount pending layer on the next task', () => {
		vi.useFakeTimers();
		const layers = new TransientLayerRegistry(new ChatInteractionGate());
		layers.open('main-inert', () => undefined);
		expect(layers.makesMainInert).toBe(true);
		vi.runAllTimers();
		expect(layers.makesMainInert).toBe(false);
	});

	it('dispatches Escape to the top priority visible layer only', async () => {
		const layers = new TransientLayerRegistry(new ChatInteractionGate());
		const dialog = document.createElement('div');
		const menu = document.createElement('div');
		document.body.append(dialog, menu);
		const closeDialog = vi.fn(() => true);
		const closeMenu = vi.fn(() => true);
		const restoreMenu = vi.fn();
		layers.register({
			id: 'dialog',
			kind: 'application-dialog',
			modality: 'main-inert',
			element: () => dialog,
			onEscape: closeDialog,
			restoreFocus: () => undefined,
		});
		layers.register({
			id: 'menu',
			kind: 'menu',
			modality: 'nonmodal',
			element: () => menu,
			onEscape: closeMenu,
			restoreFocus: restoreMenu,
		});
		const event = keyboardEscape();

		expect(layers.handleEscape(event)).toBe(true);
		expect(event.defaultPrevented).toBe(true);
		expect(closeMenu).toHaveBeenCalledOnce();
		expect(closeDialog).not.toHaveBeenCalled();
		await Promise.resolve();
		expect(restoreMenu).toHaveBeenCalledOnce();
		dialog.remove();
		menu.remove();
	});

	it('stacks a prompt transform above its dialog and below a menu', () => {
		const layers = new TransientLayerRegistry(new ChatInteractionGate());
		const dialog = document.createElement('div');
		const transform = document.createElement('div');
		const menu = document.createElement('div');
		document.body.append(dialog, transform, menu);
		const closeDialog = vi.fn(() => true);
		const cancelTransform = vi.fn(() => true);
		const closeMenu = vi.fn(() => true);
		layers.register({
			id: 'dialog',
			kind: 'application-dialog',
			modality: 'main-inert',
			element: () => dialog,
			onEscape: closeDialog,
			restoreFocus: () => undefined,
		});
		layers.register({
			id: 'transform',
			kind: 'prompt-transform',
			modality: 'nonmodal',
			element: () => transform,
			onEscape: cancelTransform,
			restoreFocus: () => undefined,
		});
		const unregisterMenu = layers.register({
			id: 'menu',
			kind: 'menu',
			modality: 'nonmodal',
			element: () => menu,
			onEscape: closeMenu,
			restoreFocus: () => undefined,
		});

		expect(layers.handleEscape(keyboardEscape())).toBe(true);
		expect(closeMenu).toHaveBeenCalledOnce();
		expect(cancelTransform).not.toHaveBeenCalled();
		unregisterMenu();
		expect(layers.handleEscape(keyboardEscape())).toBe(true);
		expect(cancelTransform).toHaveBeenCalledOnce();
		expect(closeDialog).not.toHaveBeenCalled();

		dialog.remove();
		transform.remove();
		menu.remove();
	});

	it('recognizes targets only within the top visible modal layer', () => {
		const layers = new TransientLayerRegistry(new ChatInteractionGate());
		const dialog = document.createElement('div');
		const dialogInput = document.createElement('input');
		const confirmation = document.createElement('div');
		const confirmationInput = document.createElement('input');
		const menu = document.createElement('div');
		dialog.append(dialogInput);
		confirmation.append(confirmationInput);
		document.body.append(dialog, confirmation, menu);
		for (const [id, kind, modality, element] of [
			['dialog', 'application-dialog', 'main-inert', dialog],
			['confirmation', 'confirmation', 'main-inert', confirmation],
			['menu', 'menu', 'nonmodal', menu],
		] as const) {
			layers.register({
				id,
				kind,
				modality,
				element: () => element,
				onEscape: () => true,
				restoreFocus: () => undefined,
			});
		}

		expect(layers.ownsTopModalTarget(dialogInput)).toBe(false);
		expect(layers.ownsTopModalTarget(confirmationInput)).toBe(true);
		expect(layers.ownsTopModalTarget(menu)).toBe(false);

		dialog.remove();
		confirmation.remove();
		menu.remove();
	});
});
