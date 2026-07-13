import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatInteractionGate } from '../chat-interaction-gate.svelte';
import { TransientLayerRegistry } from '../transient-layers.svelte';

afterEach(() => {
	vi.useRealTimers();
});

function keyboardEscape(): KeyboardEvent {
	return new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
}

describe('TransientLayerRegistry', () => {
	it('makes the main view inert before open state mutates and through registration', () => {
		vi.useFakeTimers();
		const gate = new ChatInteractionGate();
		const cancel = vi.fn();
		gate.register({ cancelApplicationDrag: cancel });
		const layers = new TransientLayerRegistry(gate);
		let inertDuringMutation = false;

		layers.open('main-inert', () => {
			inertDuringMutation = layers.makesMainInert;
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
});
