<script lang="ts">
	import Fuse from 'fuse.js';
	import Search from '@lucide/svelte/icons/search';
	import MessageSquarePlus from '@lucide/svelte/icons/message-square-plus';
	import Settings from '@lucide/svelte/icons/settings';
	import FileCode from '@lucide/svelte/icons/file-code';
	import Eye from '@lucide/svelte/icons/eye';
	import {
		getAppShell,
		getFileSessions,
		getGhCapability,
		getLocalSettings,
		getNotifications,
		getTerminalRegistry,
		getTransientLayers,
		getWorkspaceCoordinator,
	} from '$lib/context';
	import { transientLayer } from '$lib/workspace/transient-layer-action.js';
	import * as m from '$lib/paraglide/messages.js';
	import { TERMINAL_SESSION_LIMIT } from '$shared/terminal';

	interface CommandItem {
		id: string;
		label: string;
		description?: string;
		category: string;
		action: () => void;
	}

	const categories = {
		chat: m.command_category_chat(),
		navigation: m.command_category_navigation(),
		accessibility: m.command_category_accessibility(),
		workspace: m.command_category_workspace(),
	} as const;

	const workspace = getWorkspaceCoordinator();
	const terminals = getTerminalRegistry();
	const files = getFileSessions();
	const appShell = getAppShell();
	const localSettings = getLocalSettings();
	const ghCapability = getGhCapability();
	const notifications = getNotifications();
	const transientLayers = getTransientLayers();
	let focusReturnTarget: HTMLElement | null = null;

	let isOpen = $state(false);
	let query = $state('');
	let selectedIndex = $state(0);
	let inputRef = $state<HTMLInputElement | null>(null);
	let paletteRef = $state<HTMLDivElement | null>(null);

	function reportTerminalAction(operation: Promise<unknown>): void {
		void operation.catch((error) => {
			notifications.error(error instanceof Error ? error.message : m.terminal_create_failed());
		});
	}

	let commands = $derived.by<CommandItem[]>(() => {
		return [
			{
				id: 'new-chat',
				label: m.command_new_chat(),
				description: m.command_new_chat_desc(),
				category: categories.chat,
				action: () => {
					appShell.openNewChatDialog();
				},
			},
			{
				id: 'open-settings',
				label: m.command_open_settings(),
				description: m.command_open_settings_desc(),
				category: categories.navigation,
				action: () => appShell.openSettings(),
			},
			{
				id: 'toggle-colorblind',
				label: localSettings.colorblindMode
					? m.command_colorblind_disable()
					: m.command_colorblind_enable(),
				description: localSettings.colorblindMode
					? m.command_colorblind_disable_desc()
					: m.command_colorblind_enable_desc(),
				category: categories.accessibility,
				action: () => localSettings.toggle('colorblindMode'),
			},
			{
				id: 'workspace-chat',
				label: m.command_switch_to_chat(),
				description: m.command_open_panel({ panel: m.workspace_surface_chat() }),
				category: categories.workspace,
				action: () => void workspace.focusChat(),
			},
			{
				id: 'workspace-files',
				label: m.command_switch_to_files(),
				description: m.command_open_panel({ panel: m.workspace_surface_files() }),
				category: categories.workspace,
				action: () =>
					void (workspace.isMobile
						? workspace.focusMobileSingleton('files')
						: workspace.openSingleton('files', 'sidebar')),
			},
			{
				id: 'workspace-open-files',
				label: m.file_session_open_files(),
				description: m.file_session_open_files_description(),
				category: categories.workspace,
				action: () => files.showOpenFiles(),
			},
			{
				id: 'workspace-terminal',
				label: m.command_switch_to_terminal(),
				description: m.command_open_panel({ panel: m.workspace_surface_terminal() }),
				category: categories.workspace,
				action: () => reportTerminalAction(workspace.focusMostRecentTerminalOrCreate('main')),
			},
			...(terminals.listStatus === 'ready' &&
			terminals.orderedSessions.length < TERMINAL_SESSION_LIMIT
				? [
						{
							id: 'workspace-new-terminal',
							label: m.workspace_new_terminal(),
							description: m.command_new_terminal_description(),
							category: categories.workspace,
							action: () =>
								reportTerminalAction(workspace.createTerminal('main', 'command-menu:new-terminal')),
						},
					]
				: []),
			{
				id: 'workspace-git',
				label: m.command_switch_to_git(),
				description: m.command_open_panel({ panel: m.workspace_surface_git_workbench() }),
				category: categories.workspace,
				action: () =>
					void (workspace.isMobile
						? workspace.focusMobileSingleton('git')
						: workspace.openSingleton('git', 'main')),
			},
			...(ghCapability.available || !ghCapability.hasChecked
				? [
						{
							id: 'workspace-pull-requests',
							label: m.workspace_surface_pull_requests(),
							description: m.command_open_panel({ panel: m.workspace_surface_pull_requests() }),
							category: categories.workspace,
							action: () =>
								void (workspace.isMobile
									? workspace.focusMobileSingleton('pull-requests')
									: workspace.openSingleton('pull-requests', 'main')),
						},
					]
				: []),
			{
				id: 'workspace-commit',
				label: m.workspace_surface_commit(),
				description: m.command_open_panel({ panel: m.workspace_surface_commit() }),
				category: categories.workspace,
				action: () =>
					void (workspace.isMobile
						? workspace.focusMobileSingleton('commit')
						: workspace.openSingleton('commit', 'sidebar')),
			},
		];
	});

	let fuse = $derived(
		new Fuse(commands, {
			keys: ['label', 'description', 'category'],
			threshold: 0.4,
			includeScore: true,
		}),
	);

	let filteredCommands = $derived(query.trim() ? fuse.search(query).map((r) => r.item) : commands);

	function handleQueryInput(e: Event) {
		query = (e.target as HTMLInputElement).value;
		selectedIndex = 0;
	}

	function open() {
		focusReturnTarget =
			document.activeElement instanceof HTMLElement ? document.activeElement : null;
		transientLayers.open('main-inert', () => {
			isOpen = true;
			query = '';
			selectedIndex = 0;
			requestAnimationFrame(() => inputRef?.focus());
		});
	}

	function close() {
		isOpen = false;
		query = '';
	}

	export function toggle() {
		if (isOpen) close();
		else open();
	}

	function selectItem(item: CommandItem) {
		item.action();
		close();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Tab') {
			const focusable = Array.from(
				paletteRef?.querySelectorAll<HTMLElement>(
					'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
				) ?? [],
			);
			if (focusable.length === 0) {
				e.preventDefault();
				return;
			}
			const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
			const atBoundary = e.shiftKey ? currentIndex <= 0 : currentIndex === focusable.length - 1;
			if (!atBoundary) return;
			e.preventDefault();
			focusable[e.shiftKey ? focusable.length - 1 : 0]?.focus();
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			selectedIndex = Math.min(selectedIndex + 1, filteredCommands.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			selectedIndex = Math.max(selectedIndex - 1, 0);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const item = filteredCommands[selectedIndex];
			if (item) selectItem(item);
		}
	}

	function handleBackdropClick() {
		close();
	}

	function getCategoryIcon(category: string) {
		switch (category) {
			case categories.chat:
				return MessageSquarePlus;
			case categories.navigation:
				return Settings;
			case categories.accessibility:
				return Eye;
			case 'Tabs':
				return FileCode;
			default:
				return Search;
		}
	}

	$effect(() => {
		if (!isOpen) return;
		const el = document.querySelector(`[data-cmd-index="${selectedIndex}"]`);
		el?.scrollIntoView({ block: 'nearest' });
	});
</script>

{#if isOpen}
	<div class="fixed inset-0 z-50 transient-backdrop" role="presentation">
		<button
			class="absolute inset-0 w-full h-full cursor-default"
			onclick={handleBackdropClick}
			aria-label={m.command_close_menu()}
			tabindex="-1"
		></button>

		<div
			bind:this={paletteRef}
			class="fixed top-[20%] left-1/2 -translate-x-1/2 w-full max-w-lg bg-popover border border-border rounded-md shadow-2xl overflow-hidden"
			role="dialog"
			aria-modal="true"
			aria-label={m.command_command_palette()}
			tabindex="-1"
			onkeydown={handleKeydown}
			use:transientLayer={{
				registry: transientLayers,
				id: 'command-palette',
				kind: 'application-dialog',
				modality: 'main-inert',
				onEscape: () => {
					close();
					return true;
				},
				restoreFocus: () => focusReturnTarget?.focus(),
			}}
		>
			<div class="flex items-center gap-2 px-4 py-3 border-b border-border">
				<Search class="w-4 h-4 text-muted-foreground flex-shrink-0" />
				<input
					bind:this={inputRef}
					value={query}
					oninput={handleQueryInput}
					placeholder={m.command_placeholder()}
					class="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
					type="text"
				/>
				<kbd
					class="hidden sm:inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground bg-muted rounded border border-border"
				>
					{m.command_escape_hint()}
				</kbd>
			</div>

			<div class="max-h-[300px] overflow-y-auto p-2" role="listbox">
				{#if filteredCommands.length === 0}
					<div class="px-4 py-8 text-center text-sm text-muted-foreground">
						{m.command_no_matching()}
					</div>
				{:else}
					{#each filteredCommands as item, i}
						{@const Icon = getCategoryIcon(item.category)}
						<button
							data-cmd-index={i}
							role="option"
							aria-selected={i === selectedIndex}
							class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors {i ===
							selectedIndex
								? 'bg-accent text-accent-foreground'
								: 'text-foreground hover:bg-accent/50'}"
							onclick={() => selectItem(item)}
							onmouseenter={() => {
								selectedIndex = i;
							}}
						>
							<Icon class="w-4 h-4 flex-shrink-0 text-muted-foreground" />
							<div class="flex-1 min-w-0">
								<div class="text-sm font-medium truncate">{item.label}</div>
								{#if item.description}
									<div class="text-xs text-muted-foreground truncate">{item.description}</div>
								{/if}
							</div>
							<span class="text-[10px] text-muted-foreground uppercase flex-shrink-0">
								{item.category}
							</span>
						</button>
					{/each}
				{/if}
			</div>
		</div>
	</div>
{/if}
