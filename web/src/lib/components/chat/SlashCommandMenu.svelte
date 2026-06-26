<script lang="ts">
	// Dropdown menu for slash-command autocomplete via "/" in the chat composer.
	// Fetches the command list for the active agent/project when first shown,
	// then filters locally by query.

	import { Slash, Sparkles } from '@lucide/svelte';
	import { getSlashCommands, type SlashCommand } from '$lib/api/commands.js';
	import { BUILTIN_SLASH_COMMANDS } from '$lib/chat/slash-commands';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		agent: string;
		projectPath: string;
		chatId?: string | null;
		isVisible: boolean;
		query: string;
		onSelect: (name: string) => void;
		onClose: () => void;
		position?: { top: number; left: number };
	}

	let {
		agent,
		projectPath,
		chatId = null,
		isVisible,
		query,
		onSelect,
		onClose,
		position,
	}: Props = $props();

	let allCommands = $state<SlashCommand[]>([]);
	let selectedIndex = $state(0);
	let listElement: HTMLUListElement | undefined = $state();
	let isLoading = $state(false);
	let loadFailed = $state(false);

	let fetchedKey = '';

	// Defers fetch until the menu becomes visible for the first time.
	// Re-fetches when the agent/project identity changes.
	$effect(() => {
		const key = `${agent}::${chatId ?? ''}::${projectPath}`;
		if (!projectPath || !isVisible) return;
		if (fetchedKey === key) return;
		fetchedKey = key;
		isLoading = true;
		loadFailed = false;

		const controller = new AbortController();

		getSlashCommands({ agent, chatId, projectPath }, { signal: controller.signal })
			.then((commands) => {
				if (!controller.signal.aborted) {
					allCommands = commands;
				}
			})
			.catch((err) => {
				if (!controller.signal.aborted) {
					console.error('Failed to fetch slash commands:', err);
					fetchedKey = '';
					loadFailed = true;
				}
			})
			.finally(() => {
				if (!controller.signal.aborted) {
					isLoading = false;
				}
			});

		return () => controller.abort();
	});

	// Client-side built-ins are always available; agent-discovered commands are
	// appended, skipping any whose name a built-in already covers so the richer
	// built-in entry (with its description) wins.
	let mergedCommands = $derived.by(() => {
		const builtinNames = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));
		const discovered = allCommands.filter((command) => !builtinNames.has(command.name));
		return [...BUILTIN_SLASH_COMMANDS, ...discovered];
	});

	// Filters commands by query (case-insensitive), capped at 10 results.
	// Prefix matches rank ahead of substring matches.
	let filteredCommands = $derived.by(() => {
		if (!query) return mergedCommands.slice(0, 10);

		const lowerQuery = query.toLowerCase();
		const prefix: SlashCommand[] = [];
		const contains: SlashCommand[] = [];
		for (const command of mergedCommands) {
			const name = command.name.toLowerCase();
			if (name.startsWith(lowerQuery)) prefix.push(command);
			else if (name.includes(lowerQuery)) contains.push(command);
		}
		return [...prefix, ...contains].slice(0, 10);
	});

	// Resets selectedIndex when the filtered results change.
	$effect(() => {
		filteredCommands;
		selectedIndex = 0;
	});

	// Scrolls the highlighted item into view when selectedIndex changes.
	$effect(() => {
		if (!listElement) return;
		const active = listElement.children[selectedIndex] as HTMLElement | undefined;
		active?.scrollIntoView({ block: 'nearest' });
	});

	export function handleKeyDown(event: KeyboardEvent): boolean {
		if (!isVisible || filteredCommands.length === 0) {
			if (event.key === 'Escape' && isVisible) {
				event.preventDefault();
				onClose();
				return true;
			}
			return false;
		}

		if (event.key === 'ArrowDown') {
			event.preventDefault();
			selectedIndex = (selectedIndex + 1) % filteredCommands.length;
			return true;
		}

		if (event.key === 'ArrowUp') {
			event.preventDefault();
			selectedIndex = (selectedIndex - 1 + filteredCommands.length) % filteredCommands.length;
			return true;
		}

		if (event.key === 'Enter' || event.key === 'Tab') {
			event.preventDefault();
			onSelect(filteredCommands[selectedIndex].name);
			return true;
		}

		if (event.key === 'Escape') {
			event.preventDefault();
			onClose();
			return true;
		}

		return false;
	}
</script>

{#if isVisible}
	<div
		class="absolute bottom-full left-0 z-50 mb-1 w-80 rounded-md border border-border bg-popover shadow-md"
		style:top={position ? `${position.top}px` : undefined}
		style:left={position ? `${position.left}px` : undefined}
	>
		<ul bind:this={listElement} class="max-h-[240px] overflow-y-auto py-1" role="listbox">
			{#each filteredCommands as command, i (command.name)}
				<li role="option" aria-selected={i === selectedIndex}>
					<button
						type="button"
						class="flex w-full items-start gap-2 px-3 py-1.5 text-left text-sm text-foreground transition-colors
							{i === selectedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/50'}"
						onmouseenter={() => {
							selectedIndex = i;
						}}
						onclick={() => onSelect(command.name)}
					>
						{#if command.source === 'skill'}
							<Sparkles class="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
						{:else}
							<Slash class="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
						{/if}
						<span class="min-w-0 flex-1">
							<span class="flex items-center gap-2">
								<span class="truncate">/{command.name}</span>
								{#if command.source === 'skill'}
									<span class="ml-auto text-xs uppercase tracking-wide text-muted-foreground">
										{m.chat_slash_command_skill_tag()}
									</span>
								{/if}
							</span>
							{#if command.description}
								<span class="block truncate text-xs text-muted-foreground">
									{command.description}
								</span>
							{/if}
						</span>
					</button>
				</li>
			{/each}
			{#if isLoading}
				<li class="px-3 py-2 text-sm text-muted-foreground">
					{m.chat_slash_command_loading()}
				</li>
			{:else if loadFailed}
				<li class="px-3 py-2 text-sm text-muted-foreground">
					{m.chat_slash_command_load_failed()}
				</li>
			{:else if filteredCommands.length === 0}
				<li class="px-3 py-2 text-sm text-muted-foreground">
					{m.chat_slash_command_no_matching()}
				</li>
			{/if}
		</ul>
	</div>
{/if}
