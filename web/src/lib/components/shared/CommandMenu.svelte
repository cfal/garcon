<script lang="ts">
	// Global command palette triggered by Ctrl+P / Cmd+P. Provides fuzzy
	// search over application commands with keyboard navigation and
	// selection via Enter or click.

	import Fuse from 'fuse.js';
	import Search from '@lucide/svelte/icons/search';
	import MessageSquarePlus from '@lucide/svelte/icons/message-square-plus';
	import Settings from '@lucide/svelte/icons/settings';
	import FileCode from '@lucide/svelte/icons/file-code';
	import Eye from '@lucide/svelte/icons/eye';
	import { getNavigation, getAppShell, getPreferences } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';

	interface CommandItem {
		id: string;
		label: string;
		description?: string;
		category: string;
		action: () => void;
	}

	const navigation = getNavigation();
	const appShell = getAppShell();
	const preferences = getPreferences();

	let isOpen = $state(false);
	let query = $state('');
	let selectedIndex = $state(0);
	let inputRef = $state<HTMLInputElement | null>(null);

	let commands = $derived.by<CommandItem[]>(() => {
		return [
			{
				id: 'new-chat',
				label: m.command_new_chat(),
				description: m.command_new_chat_desc(),
				category: 'Chat',
				action: () => {
					appShell.openNewChatDialog();
				}
			},
				{
					id: 'open-settings',
					label: m.command_open_settings(),
					description: m.command_open_settings_desc(),
					category: 'Navigation',
					action: () => appShell.openSettings()
				},
				{
					id: 'toggle-colorblind',
					label: m.command_toggle_colorblind(),
					description: m.command_toggle_colorblind_desc(),
					category: 'Accessibility',
					action: () => preferences.setPreference('colorblindMode', !preferences.colorblindMode)
				},
				{
					id: 'tab-chat',
					label: m.command_switch_to_chat(),
					description: m.command_open_panel({ panel: 'Chat' }),
				category: 'Tabs',
				action: () => navigation.setActiveTab('chat')
			},
			{
				id: 'tab-files',
				label: m.command_switch_to_files(),
				description: m.command_open_panel({ panel: 'Files' }),
				category: 'Tabs',
				action: () => navigation.setActiveTab('files')
			},
			{
				id: 'tab-shell',
				label: m.command_switch_to_shell(),
				description: m.command_open_panel({ panel: 'Shell' }),
				category: 'Tabs',
				action: () => navigation.setActiveTab('shell')
			},
				{
					id: 'tab-git',
					label: m.command_switch_to_git(),
					description: m.command_open_panel({ panel: 'Git' }),
					category: 'Tabs',
					action: () => navigation.setActiveTab('git')
				}
			];
		});

	let fuse = $derived(new Fuse(commands, {
		keys: ['label', 'description', 'category'],
		threshold: 0.4,
		includeScore: true
	}));

	let filteredCommands = $derived(
		query.trim()
			? fuse.search(query).map((r) => r.item)
			: commands
	);

	function handleQueryInput(e: Event) {
		query = (e.target as HTMLInputElement).value;
		selectedIndex = 0;
	}

	function open() {
		isOpen = true;
		query = '';
		selectedIndex = 0;
		// Focus the input on next tick
		requestAnimationFrame(() => inputRef?.focus());
	}

	function close() {
		isOpen = false;
		query = '';
	}

	/** Exported so KeyboardShortcuts can toggle externally. */
	export function toggle() {
		if (isOpen) close();
		else open();
	}

	function selectItem(item: CommandItem) {
		item.action();
		close();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			selectedIndex = Math.min(selectedIndex + 1, filteredCommands.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			selectedIndex = Math.max(selectedIndex - 1, 0);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const item = filteredCommands[selectedIndex];
			if (item) selectItem(item);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			close();
		}
	}

	function handleBackdropClick() {
		close();
	}

	function getCategoryIcon(category: string) {
		switch (category) {
			case 'Chat': return MessageSquarePlus;
			case 'Navigation': return Settings;
			case 'Accessibility': return Eye;
			case 'Tabs': return FileCode;
			default: return Search;
		}
	}

	$effect(() => {
		if (!isOpen) return;
		const el = document.querySelector(`[data-cmd-index="${selectedIndex}"]`);
		el?.scrollIntoView({ block: 'nearest' });
	});
</script>

{#if isOpen}
	<div class="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" role="presentation">
		<button
			class="absolute inset-0 w-full h-full cursor-default"
			onclick={handleBackdropClick}
			aria-label={m.command_close_menu()}
			tabindex="-1"
		></button>

		<div
			class="fixed top-[20%] left-1/2 -translate-x-1/2 w-full max-w-lg bg-popover border border-border rounded-xl shadow-2xl overflow-hidden"
			role="dialog"
			aria-label={m.command_command_palette()}
			tabindex="-1"
			onkeydown={handleKeydown}
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
				<kbd class="hidden sm:inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground bg-muted rounded border border-border">
					ESC
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
							class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors {i === selectedIndex ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-accent/50'}"
							onclick={() => selectItem(item)}
							onmouseenter={() => { selectedIndex = i; }}
						>
							<Icon class="w-4 h-4 flex-shrink-0 text-muted-foreground" />
							<div class="flex-1 min-w-0">
								<div class="text-sm font-medium truncate">{item.label}</div>
								{#if item.description}
									<div class="text-xs text-muted-foreground truncate">{item.description}</div>
								{/if}
							</div>
							<span class="text-[10px] text-muted-foreground uppercase tracking-wider flex-shrink-0">
								{item.category}
							</span>
						</button>
					{/each}
				{/if}
			</div>
		</div>
	</div>
{/if}
