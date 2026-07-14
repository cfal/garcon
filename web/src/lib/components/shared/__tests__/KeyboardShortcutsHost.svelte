<script lang="ts">
	import { untrack } from 'svelte';
	import KeyboardShortcuts from '../KeyboardShortcuts.svelte';
	import { setAppShell, setNavigation, setWorkspaceShortcuts } from '$lib/context';
	import { WorkspaceShortcutDispatcher } from '$lib/workspace/workspace-shortcuts';
	import { ChatInteractionGate } from '$lib/workspace/chat-interaction-gate.svelte';
	import {
		TransientLayerRegistry,
		type TransientLayerKind,
	} from '$lib/workspace/transient-layers.svelte';

	interface KeyboardShortcutsHostProps {
		appShell: {
			openSidebarSearch: () => void;
			requestNewChat: () => void;
			requestRenameSelectedChat: () => void;
			requestDeleteSelectedChat: () => void;
			openSettings: () => void;
		};
		navigation: {
			requestNavigateChatAbove: () => void;
			requestNavigateChatBelow: () => void;
		};
		onToggleCommandMenu?: () => void;
		focusOwner?: 'chat-list' | 'chat' | 'file';
		transientKind?: TransientLayerKind | null;
		transientSurface?: boolean;
		onFileSave?: () => void;
		onFocusPreviousTab?: () => boolean;
		onFocusNextTab?: () => boolean;
	}

	let {
		appShell,
		navigation,
		onToggleCommandMenu,
		focusOwner = 'chat-list',
		transientKind = null,
		transientSurface = false,
		onFileSave = () => undefined,
		onFocusPreviousTab = () => true,
		onFocusNextTab = () => true,
	}: KeyboardShortcutsHostProps = $props();
	let transientElement = $state<HTMLElement | null>(null);

	const appShellPort = {
		get openSidebarSearch() {
			return appShell.openSidebarSearch;
		},
		get requestNewChat() {
			return appShell.requestNewChat;
		},
		get requestRenameSelectedChat() {
			return appShell.requestRenameSelectedChat;
		},
		get requestDeleteSelectedChat() {
			return appShell.requestDeleteSelectedChat;
		},
		get openSettings() {
			return appShell.openSettings;
		},
	} as never;
	setAppShell(appShellPort);

	const navigationPort = {
		get requestNavigateChatAbove() {
			return navigation.requestNavigateChatAbove;
		},
		get requestNavigateChatBelow() {
			return navigation.requestNavigateChatBelow;
		},
	} as never;
	setNavigation(navigationPort);

	const workspace = {
		isSurfacePresented: () => true,
		focusPreviousTabInFocusedHost: (owner: { kind: string }) =>
			owner.kind === 'chat-list' ? false : onFocusPreviousTab(),
		focusNextTabInFocusedHost: (owner: { kind: string }) =>
			owner.kind === 'chat-list' ? false : onFocusNextTab(),
		get focusOwner() {
			return focusOwner === 'chat-list'
				? { kind: 'chat-list' as const }
				: {
						kind: 'surface' as const,
						surfaceId: focusOwner === 'file' ? 'file:file-session' : 'singleton:chat',
					};
		},
		layout: {
			surface: (surfaceId: string) =>
				surfaceId === 'file:file-session'
					? { id: surfaceId, type: 'file', fileSessionId: 'file-session' }
					: { id: 'singleton:chat', type: 'singleton', kind: 'chat' },
		},
	} as never;
	const transients = new TransientLayerRegistry(new ChatInteractionGate());
	const initialTransientKind = untrack(() => transientKind);
	if (initialTransientKind) {
		transients.register({
			id: `test-${initialTransientKind}`,
			kind: initialTransientKind,
			modality:
				initialTransientKind === 'menu' || initialTransientKind === 'popover'
					? 'nonmodal'
					: 'main-inert',
			element: () => transientElement,
			onEscape: () => true,
			restoreFocus: () => undefined,
		});
	}
	setWorkspaceShortcuts(
		new WorkspaceShortcutDispatcher({
			workspace,
			transients,
			appShell: appShellPort,
			navigation: navigationPort,
			files: { save: () => onFileSave() } as never,
		}),
	);
</script>

<KeyboardShortcuts {onToggleCommandMenu} />

{#if transientKind}
	<div
		bind:this={transientElement}
		data-workspace-surface-id={transientSurface ? 'file:file-session' : undefined}
		role={transientKind === 'menu' ? 'menu' : transientKind === 'popover' ? 'region' : 'dialog'}
	>
		<input aria-label="Transient input" />
	</div>
{/if}
