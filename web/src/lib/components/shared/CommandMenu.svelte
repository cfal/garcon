<script lang="ts">
	import Fuse from 'fuse.js';
	import Search from '@lucide/svelte/icons/search';
	import MessageSquarePlus from '@lucide/svelte/icons/message-square-plus';
	import Settings from '@lucide/svelte/icons/settings';
	import FileCode from '@lucide/svelte/icons/file-code';
	import {
		getAppShell,
		getGhCapability,
		getNotifications,
		getOptionalWorkbenchCommands,
		getTerminalRegistry,
		getTransientLayers,
		getWorkspaceCoordinator,
	} from '$lib/context';
	import { transientLayer } from '$lib/workspace/transient-layer-action.js';
	import * as m from '$lib/paraglide/messages.js';
	import type { WorkbenchCommand } from '$lib/workspace/workbench-commands.svelte.js';

	const categories = {
		chat: m.command_category_chat(),
		navigation: m.command_category_navigation(),
		workspace: m.command_category_workspace(),
	} as const;
	const knownFilePrefix = 'file.open-known:';

	const commandRegistry = getOptionalWorkbenchCommands();
	const workspace = commandRegistry ? null : getWorkspaceCoordinator();
	const terminals = commandRegistry ? null : getTerminalRegistry();
	const appShell = commandRegistry ? null : getAppShell();
	const ghCapability = commandRegistry ? null : getGhCapability();
	const notifications = commandRegistry ? null : getNotifications();
	const transientLayers = getTransientLayers();
	const uid = $props.id();
	const listId = `${uid}-list`;
	let focusReturnTarget: HTMLElement | null = null;

	let isOpen = $state(false);
	let query = $state('');
	let selectedIndex = $state(0);
	let inputRef = $state<HTMLInputElement | null>(null);
	let paletteRef = $state<HTMLDivElement | null>(null);


	function legacyCommands(): WorkbenchCommand[] {
		if (!workspace || !terminals || !appShell || !ghCapability || !notifications) return [];
		const report = (operation: Promise<unknown>) => void operation.catch((error) =>
			notifications.error(error instanceof Error ? error.message : m.workspace_open_failed()),
		);
		const open = (id: string, label: string, kind: Parameters<typeof workspace.openSingleton>[0]): WorkbenchCommand => ({
			id, label, category: 'Workspace', defaultBindings: [], isEnabled: () => true,
			run: () => report(workspace.openSingleton(kind)),
		});
		return [
			{ id: 'new-chat', label: m.command_new_chat(), description: m.command_new_chat_desc(), category: 'Chat', defaultBindings: [], isEnabled: () => true, run: () => appShell.openNewChatDialog() },
			{ id: 'open-settings', label: m.command_open_settings(), description: m.command_open_settings_desc(), category: 'Navigation', defaultBindings: [], isEnabled: () => true, run: () => appShell.openSettings() },
			{ id: 'workspace-chat', label: m.command_switch_to_chat(), category: 'Workspace', defaultBindings: [], isEnabled: () => true, run: () => void workspace.focusChat() },
			open('workspace-files', m.command_switch_to_files(), 'files'),
			open('workspace-chat-map', m.workspace_open_chat_map(), 'chat-map'),
			open('workspace-chat-canvas', m.workspace_open_chat_canvas(), 'chat-canvas'),
			open('workspace-chat-board', m.workspace_open_chat_board(), 'chat-board'),
			{ id: 'workspace-terminal', label: m.command_switch_to_terminal(), category: 'Workspace', defaultBindings: [], isEnabled: () => true, run: () => report(workspace.focusMostRecentTerminalOrCreate()) },
			...(terminals.listStatus === 'ready' && terminals.orderedSessions.length < 5 ? [{ id: 'workspace-new-terminal', label: m.workspace_new_terminal(), category: 'Workspace' as const, defaultBindings: [], isEnabled: () => true, run: () => report(workspace.createTerminalInAvailableSpace('command-menu:new-terminal')) }] : []),
			open('workspace-git', m.command_switch_to_git(), 'git'),
			open('workspace-git-history', m.workspace_surface_git_history(), 'git-history'),
			open('workspace-git-compare', m.workspace_surface_git_compare(), 'git-compare'),
			...(ghCapability.available || !ghCapability.hasChecked ? [open('workspace-pull-requests', m.workspace_surface_pull_requests(), 'pull-requests')] : []),
			open('workspace-commit', m.workspace_surface_commit(), 'commit'),
		];
	}

	let commandContext = $derived(commandRegistry?.context() ?? { viewId: null, surfaceId: null });
	let commands = $derived.by<WorkbenchCommand[]>(() => {
		const registered = commandRegistry?.available(commandContext) ?? legacyCommands();
		if (!commandRegistry) return [...registered];
		return [
			...registered,
			...commandRegistry.knownFileLocations.map((location) => ({
				id: `${knownFilePrefix}${location.key}`,
				label: `Open ${location.displayPath}`,
				description: 'Known file',
				category: 'File' as const,
				defaultBindings: [],
				isEnabled: () => true,
				run: () => commandRegistry.openLocation(location),
			})),
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
	let selectedCommand = $derived(filteredCommands[selectedIndex]);

	function isEnabled(command: WorkbenchCommand): boolean {
		return command.isEnabled(commandContext);
	}

	function optionIdFor(commandId: string): string {
		return `${uid}-command-${commandId}`;
	}

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

	function selectItem(item: WorkbenchCommand) {
		if (!isEnabled(item)) return;
		if (commandRegistry && !item.id.startsWith(knownFilePrefix)) {
			void commandRegistry.execute(item.id, commandContext);
		} else {
			void item.run(commandContext);
		}
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
			selectedIndex = Math.min(selectedIndex + 1, Math.max(filteredCommands.length - 1, 0));
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
					class="flex-1 bg-transparent text-base text-foreground placeholder:text-muted-foreground outline-none sm:pointer-fine:text-sm"
					type="text"
					role="combobox"
					aria-expanded="true"
					aria-controls={listId}
					aria-autocomplete="list"
					aria-activedescendant={selectedCommand ? optionIdFor(selectedCommand.id) : undefined}
				/>
				<kbd
					class="hidden sm:inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground bg-muted rounded border border-border"
				>
					{m.command_escape_hint()}
				</kbd>
			</div>

			<div id={listId} class="max-h-[300px] overflow-y-auto p-2" role="listbox">
				{#if filteredCommands.length === 0}
					<div class="px-4 py-8 text-center text-sm text-muted-foreground">
						{m.command_no_matching()}
					</div>
				{:else}
					{#each filteredCommands as item, i (item.id)}
						{@const Icon = getCategoryIcon(item.category)}
						<button
							id={optionIdFor(item.id)}
							data-cmd-index={i}
							role="option"
							aria-selected={i === selectedIndex}
							aria-disabled={!isEnabled(item)}
							disabled={!isEnabled(item)}
							class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45 {i ===
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
