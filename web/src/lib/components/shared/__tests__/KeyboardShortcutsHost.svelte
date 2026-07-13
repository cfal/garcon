<script lang="ts">
	import KeyboardShortcuts from '../KeyboardShortcuts.svelte';
	import {
		setAppShell,
		setNavigation,
		setWorkspaceShortcuts,
	} from '$lib/context';
	import { WorkspaceShortcutDispatcher } from '$lib/workspace/workspace-shortcuts';
	import { ChatInteractionGate } from '$lib/workspace/chat-interaction-gate.svelte';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte';

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
		focusOwner?: 'chat-list' | 'chat';
	}

	let {
		appShell,
		navigation,
		onToggleCommandMenu,
		focusOwner = 'chat-list',
	}: KeyboardShortcutsHostProps = $props();

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
		get focusOwner() {
			return focusOwner === 'chat-list'
				? { kind: 'chat-list' as const }
				: { kind: 'surface' as const, surfaceId: 'singleton:chat' };
		},
		layout: {
			surface: () => ({ id: 'singleton:chat', type: 'singleton', kind: 'chat' }),
		},
	} as never;
	setWorkspaceShortcuts(new WorkspaceShortcutDispatcher({
		workspace,
		transients: new TransientLayerRegistry(new ChatInteractionGate()),
		appShell: appShellPort,
		navigation: navigationPort,
		files: {} as never,
	}));
</script>

<KeyboardShortcuts {onToggleCommandMenu} />
