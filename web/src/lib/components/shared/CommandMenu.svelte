<script lang="ts">
	import { CHAT_OPEN_COMMAND_PREFIX } from '$lib/workspace/workbench-commands.svelte.js';
	import { flushSync } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import Fuse from 'fuse.js';
	import Search from '@lucide/svelte/icons/search';
	import X from '@lucide/svelte/icons/x';
	import MessageSquarePlus from '@lucide/svelte/icons/message-square-plus';
	import Settings from '@lucide/svelte/icons/settings';
	import { getWorkbenchCommands, getTransientLayers } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import type {
		WorkbenchCommand,
		WorkbenchCommandCategory,
	} from '$lib/workspace/workbench-commands.svelte.js';
	const knownFilePrefix = 'file.open-known:';
	const searchResultLimit = 50;
	const recentChatLimit = 10;
	const categoryLabels: Record<WorkbenchCommandCategory, () => string> = {
		Chat: m.command_category_chat,
		Navigation: m.command_category_navigation,
		Workspace: m.command_category_workspace,
		Editor: m.command_category_editor,
		File: m.command_category_file,
	};

	const commandRegistry = getWorkbenchCommands();
	const transientLayers = getTransientLayers();
	const uid = $props.id();
	const listId = `${uid}-list`;

	let isOpen = $state(false);
	let query = $state('');
	let selectedIndex = $state(0);
	let inputRef = $state<HTMLInputElement | null>(null);

	let commandContext = $derived(commandRegistry.context());
	let commands = $state.raw<readonly WorkbenchCommand[]>([]);

	// Captures one catalog per opening so typing does not rebuild the search index.
	function captureCommands(): readonly WorkbenchCommand[] {
		return [
			...commandRegistry.paletteCandidates(commandContext),
			...commandRegistry.knownFileLocations.map<WorkbenchCommand>((location) => ({
				id: `${knownFilePrefix}${location.key}`,
				label: m.command_open_known_file_named({ path: location.displayPath }),
				description: m.command_known_file_description(),
				category: 'File',
				isEnabled: () => true,
				run: (context) => commandRegistry.openLocation(location, context),
			})),
		];
	}

	let fuse = $derived(
		new Fuse(commands, {
			keys: [
				'label',
				'description',
				{ name: 'category', getFn: (item) => categoryLabels[item.category]() },
			],
			threshold: 0.4,
			includeScore: true,
		}),
	);

	let filteredCommands = $derived(
		query.trim()
			? fuse.search(query, { limit: searchResultLimit }).map((r) => r.item)
			: commands
					.filter(
						(command, index) =>
							!command.id.startsWith(CHAT_OPEN_COMMAND_PREFIX) || index < recentChatLimit,
					)
					.slice(0, searchResultLimit),
	);
	let selectedCommand = $derived(filteredCommands[selectedIndex]);

	function isEnabled(command: WorkbenchCommand): boolean {
		return command.isEnabled(commandContext);
	}

	function optionIdFor(commandId: string): string {
		return `${uid}-command-${encodeURIComponent(commandId)}`;
	}

	function handleQueryInput(e: Event) {
		query = (e.target as HTMLInputElement).value;
		selectedIndex = 0;
	}

	function open() {
		transientLayers.open('main-inert', () => {
			commands = captureCommands();
			isOpen = true;
			query = '';
			selectedIndex = 0;
		});
	}

	function close() {
		isOpen = false;
		commands = [];
		query = '';
	}

	export function toggle() {
		if (isOpen) close();
		else open();
	}

	function selectItem(item: WorkbenchCommand) {
		if (!isEnabled(item)) return;
		const context = commandContext;
		// Releases the focus trap before a command focuses another surface.
		flushSync(close);
		void commandRegistry.invoke(item, context);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.isComposing || e.keyCode === 229) {
			if (e.key === 'Escape') e.stopPropagation();
			return;
		}
		if (e.target instanceof HTMLButtonElement && e.target.matches('[role="option"]')) {
			if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
			e.preventDefault();
			const options = Array.from(
				e.target.parentElement!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
			);
			const delta = e.key === 'ArrowDown' ? 1 : -1;
			options[options.indexOf(e.target) + delta]?.focus();
			return;
		}
		if (e.target !== inputRef) return;
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			selectedIndex = Math.min(selectedIndex + 1, Math.max(filteredCommands.length - 1, 0));
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			selectedIndex = Math.max(selectedIndex - 1, 0);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			if (selectedCommand) selectItem(selectedCommand);
		}
	}

	function getCategoryIcon(category: WorkbenchCommandCategory) {
		switch (category) {
			case 'Chat':
				return MessageSquarePlus;
			case 'Navigation':
				return Settings;
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
	<Dialog.Root open={true} requestClose={close}>
		<Dialog.Content
			class="top-[20%] translate-y-0 grid-cols-1 gap-0 overflow-hidden rounded-md bg-popover p-0 shadow-2xl"
			showCloseButton={false}
			aria-label={m.command_command_palette()}
			onkeydowncapture={handleKeydown}
			onOpenAutoFocus={(event) => {
				event.preventDefault();
				inputRef?.focus();
			}}
		>
			<div class="flex items-center gap-2 px-4 py-3 border-b border-border">
				<Search class="w-4 h-4 text-muted-foreground flex-shrink-0" />
				<input
					bind:this={inputRef}
					value={query}
					oninput={handleQueryInput}
					placeholder={m.command_placeholder()}
					class="min-w-0 flex-1 bg-transparent text-base text-foreground placeholder:text-muted-foreground outline-none sm:pointer-fine:text-sm"
					type="text"
					role="combobox"
					aria-expanded="true"
					aria-controls={listId}
					aria-autocomplete="list"
					aria-activedescendant={selectedCommand ? optionIdFor(selectedCommand.id) : undefined}
				/>
				<Dialog.Close
					class="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
					aria-label={m.command_close_menu()}
				>
					<X class="size-4 sm:hidden" />
					<span class="sm:hidden"><span class="ansi-glyph" aria-hidden="true">[x]</span></span>
					<kbd
						class="hidden rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] sm:inline"
					>
						{m.command_escape_hint()}
					</kbd>
				</Dialog.Close>
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
							onfocus={() => (selectedIndex = i)}
							onmouseenter={(event) => {
								// A focused result owns native Enter and Space activation.
								if (!event.currentTarget.parentElement?.contains(document.activeElement)) {
									selectedIndex = i;
								}
							}}
						>
							<Icon class="w-4 h-4 flex-shrink-0 text-muted-foreground" />
							<div class="flex-1 min-w-0">
								<div class="text-sm font-medium truncate">{item.label}</div>
								{#if item.description}
									<div
										class="text-xs text-muted-foreground line-clamp-2 break-words"
										title={item.description}
									>
										{item.description}
									</div>
								{/if}
							</div>
							<span class="text-[10px] text-muted-foreground uppercase flex-shrink-0">
								{categoryLabels[item.category]()}
							</span>
						</button>
					{/each}
				{/if}
			</div>
		</Dialog.Content>
	</Dialog.Root>
{/if}
