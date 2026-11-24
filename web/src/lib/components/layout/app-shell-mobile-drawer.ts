import {
	getAppShell,
	getTransientLayers,
	getWorkspaceCoordinator,
	getWorkspaceShortcuts,
} from '$lib/context';
import type { DrawerComposerSelection } from '$lib/stores/app-shell.svelte.js';
import { transientLayerAttachment } from '$lib/workspace/transient-layer-action.js';
import { allocateTransientLayerId } from '$lib/workspace/transient-layer-id.js';

export function createAppShellMobileDrawer(
	onSelectChat: (chatId: string, selection?: DrawerComposerSelection) => void,
) {
	const appShell = getAppShell();
	const workspace = getWorkspaceCoordinator();
	const shortcuts = getWorkspaceShortcuts();
	const transientLayers = getTransientLayers();
	let returnTarget: HTMLElement | null = null;
	let mouseGeneration: number | null = null;

	function close(): void {
		mouseGeneration = null;
		appShell.setSidebarOpen(false);
	}

	function restoreFocus(): void {
		const target = returnTarget;
		returnTarget = null;
		if (target?.isConnected) target.focus({ preventScroll: true });
	}

	return {
		layer: transientLayerAttachment({
			registry: transientLayers,
			id: allocateTransientLayerId('mobile-sidebar'),
			kind: 'sidebar-overlay',
			modality: 'main-inert',
			onEscape: () => {
				close();
				return true;
			},
			restoreFocus,
		}),
		close,
		toggle(): void {
			if (appShell.sidebarOpen) close();
			else transientLayers.open('main-inert', () => appShell.setSidebarOpen(true));
		},
		captureReturnTarget(): void {
			returnTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		},
		onCloseAutoFocus(event: Event): void {
			event.preventDefault();
			restoreFocus();
		},
		onPointerDown(event: PointerEvent): void {
			workspace.noteChatListFocus();
			mouseGeneration = event.pointerType === 'mouse' ? shortcuts.userInteractionGeneration : null;
		},
		selectChat(chatId: string): void {
			const generation = shortcuts.userInteractionGeneration;
			const selection = mouseGeneration === generation
				? { chatId, userInteractionGeneration: generation }
				: undefined;
			onSelectChat(chatId, selection);
			close();
		},
	};
}
