<script lang="ts">
	// Dropdown menu for built-in composer slash commands (for example "/compact").
	// Filters a static registry by the in-progress command word and exposes a
	// keyboard contract mirroring FileMentionMenu so the composer can defer
	// navigation keys while the menu is open.

	import { TerminalSquare } from '@lucide/svelte';
	import { matchSlashCommands, type SlashCommand } from '$lib/chat/slash-commands.js';

	interface Props {
		isVisible: boolean;
		query: string;
		onSelect: (name: string) => void;
		onClose: () => void;
	}

	let { isVisible, query, onSelect, onClose }: Props = $props();

	let selectedIndex = $state(0);
	let listElement: HTMLUListElement | undefined = $state();

	const matches = $derived<SlashCommand[]>(matchSlashCommands(query));

	// Resets the highlight whenever the result set changes.
	$effect(() => {
		matches;
		selectedIndex = 0;
	});

	// Keeps the highlighted row in view during keyboard navigation.
	$effect(() => {
		if (!listElement) return;
		const active = listElement.children[selectedIndex] as HTMLElement | undefined;
		active?.scrollIntoView({ block: 'nearest' });
	});

	export function handleKeyDown(event: KeyboardEvent): boolean {
		if (!isVisible || matches.length === 0) {
			if (event.key === 'Escape' && isVisible) {
				event.preventDefault();
				onClose();
				return true;
			}
			return false;
		}

		if (event.key === 'ArrowDown') {
			event.preventDefault();
			selectedIndex = (selectedIndex + 1) % matches.length;
			return true;
		}

		if (event.key === 'ArrowUp') {
			event.preventDefault();
			selectedIndex = (selectedIndex - 1 + matches.length) % matches.length;
			return true;
		}

		if (event.key === 'Enter' || event.key === 'Tab') {
			event.preventDefault();
			onSelect(matches[selectedIndex].name);
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

{#if isVisible && matches.length > 0}
	<div class="absolute bottom-full left-0 z-50 mb-2 w-80 rounded-md border border-border bg-popover shadow-md">
		<ul bind:this={listElement} class="max-h-[200px] overflow-y-auto py-1" role="listbox">
			{#each matches as command, i (command.name)}
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
						<TerminalSquare class="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
						<span class="min-w-0">
							<span class="font-medium">{command.hint}</span>
							<span class="block truncate text-xs text-muted-foreground">{command.description}</span>
						</span>
					</button>
				</li>
			{/each}
		</ul>
	</div>
{/if}
