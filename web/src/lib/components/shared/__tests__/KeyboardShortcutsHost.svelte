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
	import type { GlobalShortcutOverrides } from '$lib/workspace/global-shortcuts.js';
	import type { LocalSettingsStore } from '$lib/stores/local-settings.svelte.js';
	import type { Attachment } from 'svelte/attachments';
	import {
		managedWorkspaceScrollRegion,
		type WorkspaceHalfPageDirection,
	} from '$lib/workspace/workspace-scroll-region.js';

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
		transientSurfaceId?: string;
		onFileSave?: () => void;
		onFocusPreviousTab?: () => boolean;
		onFocusNextTab?: () => boolean;
		onToggleMainSidebarFocus?: () => void;
		onTransientEscape?: () => void;
		onSurfaceEscape?: () => void;
		onPrimaryScroll?: (direction: WorkspaceHalfPageDirection) => void;
		onContextualScroll?: (direction: WorkspaceHalfPageDirection) => void;
		onTransientScroll?: (direction: WorkspaceHalfPageDirection) => void;
		localShortcutOwner?: (event: KeyboardEvent) => boolean;
		onLocalKeydown?: (event: KeyboardEvent) => void;
		globalShortcuts?: GlobalShortcutOverrides;
	}

	let {
		appShell,
		navigation,
		onToggleCommandMenu,
		focusOwner = 'chat-list',
		transientKind = null,
		transientSurface = false,
		transientSurfaceId,
		onFileSave = () => undefined,
		onFocusPreviousTab = () => true,
		onFocusNextTab = () => true,
		onToggleMainSidebarFocus = () => undefined,
		onTransientEscape = () => undefined,
		onSurfaceEscape = () => undefined,
		onPrimaryScroll,
		onContextualScroll,
		onTransientScroll,
		localShortcutOwner,
		onLocalKeydown = () => undefined,
		globalShortcuts = {},
	}: KeyboardShortcutsHostProps = $props();
	let transientElement = $state<HTMLElement | null>(null);
	const primaryScrollRegion = managedWorkspaceScrollRegion('primary', (_element, direction) =>
		onPrimaryScroll?.(direction),
	);
	const contextualScrollRegion = managedWorkspaceScrollRegion(
		'contextual',
		(_element, direction) => onContextualScroll?.(direction),
	);
	const transientScrollRegion = managedWorkspaceScrollRegion('primary', (_element, direction) =>
		onTransientScroll?.(direction),
	);

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
		localSettings: {
			get globalShortcuts() {
				return globalShortcuts;
			},
		} satisfies Pick<LocalSettingsStore, 'globalShortcuts'>,
	});
	const localShortcutBoundary: Attachment<HTMLElement> = (element) =>
		localShortcutOwner
			? shortcuts.registerLocalShortcutOwner(element, (event) => localShortcutOwner(event))
			: undefined;
	shortcuts.registerSurface('singleton:chat', (event) => {
		if (event.key !== 'Escape') return false;
		onSurfaceEscape();
		return true;
	});
	setWorkspaceShortcuts(shortcuts);
</script>

<KeyboardShortcuts {onToggleCommandMenu} />

{#if localShortcutOwner && !transientKind}
	<div data-workspace-surface-id="singleton:chat" {@attach localShortcutBoundary}>
		<button type="button" aria-label="Local shortcut target" onkeydown={onLocalKeydown}
			>Local</button
		>
	</div>
{/if}

{#if onPrimaryScroll || onContextualScroll}
	<div
		data-workspace-chat-list={focusOwner === 'chat-list' ? '' : undefined}
		data-workspace-surface-id={focusOwner === 'chat'
			? 'singleton:chat'
			: focusOwner === 'file'
				? 'file:file-session'
				: undefined}
	>
		<button type="button" aria-label="Surface toolbar">Toolbar</button>
		{#if onPrimaryScroll}
			<div {@attach primaryScrollRegion}>
				<button type="button" aria-label="Primary scroll region">Primary</button>
				{#if focusOwner === 'file'}
					<textarea aria-label="File editor input"></textarea>
				{/if}
			</div>
		{/if}
		{#if onContextualScroll}
			<div {@attach contextualScrollRegion}>
				<button type="button" aria-label="Contextual scroll region">Contextual</button>
				<span data-testid="contextual-content">Content</span>
			</div>
		{/if}
	</div>
{/if}

{#if focusOwner === 'terminal'}
	<div data-workspace-surface-id="terminal:one">
		<input aria-label="Terminal input" />
	</div>
{/if}

{#if transientKind}
	<div
		bind:this={transientElement}
		{@attach localShortcutOwner && localShortcutBoundary}
		data-workspace-surface-id={transientSurfaceId ??
			(transientSurface ? 'file:file-session' : undefined)}
		role={transientKind === 'menu' ? 'menu' : transientKind === 'popover' ? 'region' : 'dialog'}
	>
		<button type="button" aria-label="Transient toolbar">Toolbar</button>
		<input aria-label="Transient input" onkeydown={onLocalKeydown} />
		{#if onTransientScroll}
			<div aria-label="Transient scroll region" {@attach transientScrollRegion}>Transient</div>
		{/if}
	</div>
{/if}
