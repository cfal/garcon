<script lang="ts">
	// Dropdown menu for slash-command autocomplete via "/" in the chat composer.
	// Fetches the command list for the active agent/project when first shown,
	// then filters locally by query.

	import { Slash, Sparkles } from '@lucide/svelte';
	import { getSlashCommands, type SlashCommand } from '$lib/api/commands.js';
	import { BUILTIN_SLASH_COMMANDS } from '$lib/chat/slash-commands';
	import { FixedVirtualWindow } from '$lib/components/virtual/fixed-virtual-window.svelte';
	import * as m from '$lib/paraglide/messages.js';
	import { getTransientLayers } from '$lib/context';
	import { transientLayer } from '$lib/workspace/transient-layer-action';
	import { allocateTransientLayerId } from '$lib/workspace/transient-layer-id';

	const COMMAND_ROW_HEIGHT = 48;
	const COMMAND_OVERSCAN = 3;
	const COMMAND_LIST_HEIGHT = 240;

	interface Props {
		agent: string;
		projectPath: string;
		chatId?: string | null;
		isVisible: boolean;
		query: string;
		supportsFork: boolean;
		canScheduleIn: boolean;
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
		supportsFork,
		canScheduleIn,
		onSelect,
		onClose,
		position,
	}: Props = $props();
	const transientLayers = getTransientLayers();
	const layerId = allocateTransientLayerId('slash-command');

	let allCommands = $state<SlashCommand[]>([]);
	let selectedIndex = $state(0);
	let listElement: HTMLDivElement | null = $state(null);
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

	// Agent-discovered commands are appended after visible client built-ins.
	// The app-owned /in command stays reserved when unavailable for draft chats.
	let mergedCommands = $derived.by(() => {
		const builtins = BUILTIN_SLASH_COMMANDS.filter((command) => {
			if (command.name === 'fork') return supportsFork;
			if (command.name === 'in') return canScheduleIn;
			if (command.name === 'goal' || command.name === 'steer') return agent === 'codex';
			return true;
		});
		const builtinNames = new Set(builtins.map((command) => command.name));
		const discovered = allCommands.filter(
			(command) => command.name !== 'in' && !builtinNames.has(command.name),
		);
		return [...builtins, ...discovered];
	});

	// Filters commands by query (case-insensitive). The list itself is scrollable,
	// so discovered Codex skills remain visible beyond the built-ins.
	// Prefix matches rank ahead of substring matches.
	let filteredCommands = $derived.by(() => {
		if (!query) return mergedCommands;

		const lowerQuery = query.toLowerCase();
		const prefix: SlashCommand[] = [];
		const contains: SlashCommand[] = [];
		for (const command of mergedCommands) {
			const name = command.name.toLowerCase();
			if (name.startsWith(lowerQuery)) prefix.push(command);
			else if (name.includes(lowerQuery)) contains.push(command);
		}
		return [...prefix, ...contains];
	});
	const virtualWindow = new FixedVirtualWindow({
		get itemCount() {
			return filteredCommands.length;
		},
		get rowHeight() {
			return COMMAND_ROW_HEIGHT;
		},
		get overscan() {
			return COMMAND_OVERSCAN;
		},
		get viewportRef() {
			return listElement;
		},
		defaultViewportHeight: COMMAND_LIST_HEIGHT,
	});
	let visibleCommands = $derived.by(() =>
		virtualWindow.visibleIndexes
			.map((index) => ({ index, command: filteredCommands[index] }))
			.filter((entry): entry is { index: number; command: SlashCommand } => Boolean(entry.command)),
	);

	// Resets selectedIndex when the filtered results change.
	$effect(() => {
		filteredCommands;
		selectedIndex = 0;
		if (listElement) {
			listElement.scrollTop = 0;
			virtualWindow.scrollTop = 0;
		}
	});

	$effect(() => {
		return virtualWindow.bindViewport();
	});

	// Tracks browser-owned viewport metrics that Svelte cannot derive.
	$effect(() => {
		return virtualWindow.observeViewport();
	});

	// Scrolls the highlighted item into view when selectedIndex changes.
	$effect(() => {
		selectedIndex;
		virtualWindow.scrollIndexIntoView(selectedIndex);
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
		use:transientLayer={{
			registry: transientLayers,
			id: layerId,
			kind: 'menu',
			modality: 'nonmodal',
			onEscape: () => {
				onClose();
				return true;
			},
			restoreFocus: () => undefined,
		}}
		style:top={position ? `${position.top}px` : undefined}
		style:left={position ? `${position.left}px` : undefined}
	>
		<div bind:this={listElement} class="max-h-[240px] overflow-y-auto py-1" role="listbox">
			<ul class="relative" style={`height:${virtualWindow.totalHeight}px;`}>
				{#each visibleCommands as entry (entry.command)}
					<li
						role="option"
						aria-selected={entry.index === selectedIndex}
						aria-posinset={entry.index + 1}
						aria-setsize={filteredCommands.length}
						class="absolute left-0 right-0 top-0 overflow-hidden"
						style={`height:${COMMAND_ROW_HEIGHT}px; transform:translateY(${virtualWindow.getOffset(entry.index)}px);`}
					>
						<svelte:boundary>
							<button
								type="button"
								class="flex h-full w-full items-start gap-2 px-3 py-1.5 text-left text-sm text-foreground transition-colors
										{entry.index === selectedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/50'}"
								onmouseenter={() => {
									selectedIndex = entry.index;
								}}
								onclick={() => onSelect(entry.command.name)}
							>
								{#if entry.command.source === 'skill'}
									<Sparkles class="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
								{:else}
									<Slash class="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
								{/if}
								<span class="min-w-0 flex-1">
									<span class="flex items-center gap-2">
										<span class="truncate">/{entry.command.name}</span>
										{#if entry.command.source === 'skill'}
											<span class="ml-auto text-xs uppercase tracking-wide text-muted-foreground">
												{m.chat_slash_command_skill_tag()}
											</span>
										{/if}
									</span>
									{#if entry.command.description}
										<span class="block truncate text-xs text-muted-foreground">
											{entry.command.description}
										</span>
									{/if}
								</span>
							</button>
							{#snippet failed()}
								<div class="flex h-full items-center gap-2 px-3 text-sm text-muted-foreground">
									<Slash class="h-4 w-4 flex-shrink-0" />
									<span>{m.chat_slash_command_load_failed()}</span>
								</div>
							{/snippet}
						</svelte:boundary>
					</li>
				{/each}
			</ul>
			{#if isLoading}
				<div class="px-3 py-2 text-sm text-muted-foreground">
					{m.chat_slash_command_loading()}
				</div>
			{:else if loadFailed}
				<div class="px-3 py-2 text-sm text-muted-foreground">
					{m.chat_slash_command_load_failed()}
				</div>
			{:else if filteredCommands.length === 0}
				<div class="px-3 py-2 text-sm text-muted-foreground">
					{m.chat_slash_command_no_matching()}
				</div>
			{/if}
		</div>
	</div>
{/if}
