<script lang="ts">
	import { tick } from 'svelte';
	import X from '@lucide/svelte/icons/x';
	import { getTagColorClasses } from '$lib/utils/tag-colors';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		tags: string[];
		knownTags: string[];
		open: boolean;
		onAdd: (raw: string) => boolean;
		onRemove: (tag: string) => void;
		onClose: () => void;
	}

	let { tags, knownTags, open, onAdd, onRemove, onClose }: Props = $props();
	let inputValue = $state('');
	let inputRef = $state<HTMLInputElement | null>(null);

	const suggestions = $derived.by(() => {
		const query = inputValue.trim().toLowerCase();
		if (!query) return [];
		const selected = new Set(tags.map((tag) => tag.toLowerCase()));
		return Array.from(new Set(knownTags))
			.filter((tag) => tag.toLowerCase().startsWith(query) && !selected.has(tag.toLowerCase()))
			.sort()
			.slice(0, 5);
	});

	$effect(() => {
		if (!open) {
			inputValue = '';
			return;
		}
		void tick().then(() => {
			if (open) inputRef?.focus();
		});
	});

	function add(raw: string): void {
		if (!onAdd(raw)) return;
		inputValue = '';
		inputRef?.focus();
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'Enter' || event.key === ',') {
			event.preventDefault();
			if (inputValue.trim()) add(inputValue);
			return;
		}
		if (event.key === 'Backspace' && !inputValue && tags.length > 0) {
			onRemove(tags[tags.length - 1]);
			return;
		}
		if (event.key !== 'Escape') return;
		event.preventDefault();
		event.stopPropagation();
		onClose();
	}
</script>

{#if open || tags.length > 0}
	<div class="space-y-2">
		<div class="flex flex-wrap items-center gap-1.5">
			{#each tags as tag (tag)}
				<button
					type="button"
					class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium hover:opacity-80 transition-opacity {getTagColorClasses(
						tag,
					)}"
					onclick={() => onRemove(tag)}
					aria-label={m.sidebar_tags_remove({ tag })}
				>
					{tag}
					<X class="w-3 h-3" aria-hidden="true" />
				</button>
			{/each}
			{#if open}
				<div class="relative flex-1 min-w-[120px]">
					<input
						bind:this={inputRef}
						type="text"
						bind:value={inputValue}
						onkeydown={handleKeydown}
						placeholder={m.chat_new_chat_tags_placeholder()}
						class="w-full px-2 py-1 text-xs bg-transparent border-none outline-none placeholder-muted-foreground/60 text-foreground"
					/>
					{#if suggestions.length > 0}
						<div class="absolute z-10 mt-1 w-full rounded-md border border-border bg-popover shadow-md">
							{#each suggestions as suggestion (suggestion)}
								<button
									type="button"
									class="w-full text-left px-3 py-1.5 text-xs hover:bg-accent transition-colors first:rounded-t-md last:rounded-b-md"
									onclick={() => add(suggestion)}
								>
									{suggestion}
								</button>
							{/each}
						</div>
					{/if}
				</div>
			{/if}
		</div>
	</div>
{/if}
