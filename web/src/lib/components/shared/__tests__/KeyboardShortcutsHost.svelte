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
		focusOwner?: 'chat-list' | 'chat' | 'file' | 'terminal';
		transientKind?: TransientLayerKind | null;
		transientSurface?: boolean;
		onFileSave?: () => void;
		onFocusPreviousTab?: () => boolean;
		onFocusNextTab?: () => boolean;
		onToggleMainSidebarFocus?: () => void;
		localEscapeOwner?: boolean;
		onTransientEscape?: () => void;
		onSurfaceEscape?: () => void;
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
		onToggleMainSidebarFocus = () => undefined,
		localEscapeOwner = false,
		onTransientEscape = () => undefined,
		onSurfaceEscape = () => undefined,
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
		toggleFocusBetweenMainAndSidebar: () => onToggleMainSidebarFocus(),
		get focusOwner() {
			return focusOwner === 'chat-list'
				? { kind: 'chat-list' as const }
				: {
						kind: 'surface' as const,
						surfaceId:
							focusOwner === 'file'
								? 'file:file-session'
								: focusOwner === 'terminal'
									? 'terminal:one'
									: 'singleton:chat',
					};
		},
		layout: {
			surface: (surfaceId: string) =>
				surfaceId === 'file:file-session'
					? { id: surfaceId, type: 'file', fileSessionId: 'file-session' }
					: surfaceId === 'terminal:one'
						? { id: surfaceId, type: 'terminal', terminalId: 'one' }
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
			onEscape: () => {
				onTransientEscape();
				return true;
			},
			restoreFocus: () => undefined,
		});
	}
	const shortcuts = new WorkspaceShortcutDispatcher({
		workspace,
		transients,
		appShell: appShellPort,
		navigation: navigationPort,
		files: { save: () => onFileSave() } as never,
	});
	shortcuts.registerSurface('singleton:chat', (event) => {
		if (event.key !== 'Escape') return false;
		onSurfaceEscape();
		return true;
	});
	setWorkspaceShortcuts(shortcuts);
</script>

<KeyboardShortcuts {onToggleCommandMenu} />

{#if focusOwner === 'terminal'}
	<div data-workspace-surface-id="terminal:one">
		<input aria-label="Terminal input" />
	</div>
{/if}

{#if transientKind}
	<div
		bind:this={transientElement}
		data-workspace-surface-id={transientSurface ? 'file:file-session' : undefined}
		role={transientKind === 'menu' ? 'menu' : transientKind === 'popover' ? 'region' : 'dialog'}
	>
		<input
			aria-label="Transient input"
			data-local-escape-owner={localEscapeOwner ? '' : undefined}
		/>
	</div>
{:else if localEscapeOwner}
	<input aria-label="Local input" data-local-escape-owner />
{/if}
