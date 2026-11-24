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
		presentation?: 'standalone' | 'session-row';
	}

	let { tags, knownTags, open, onAdd, onRemove, onClose, presentation = 'standalone' }: Props = $props();
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
	<div class={presentation === 'session-row' ? 'min-w-[min(120px,100%)] flex-1' : 'space-y-2'}>
		<div class="flex min-w-0 flex-wrap items-center gap-1.5">
			{#each tags as tag (tag)}
				<button
					type="button"
					class="inline-flex min-w-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium hover:opacity-80 transition-opacity {presentation === 'session-row'
						? 'max-w-36 border-border bg-muted text-foreground'
						: 'max-w-full ' + getTagColorClasses(tag)}"
					onclick={() => onRemove(tag)}
					aria-label={m.sidebar_tags_remove({ tag })}
					title={tag}
				>
					<span class="min-w-0 truncate">{tag}</span>
					<X class="size-3 shrink-0" aria-hidden="true" />
				</button>
			{/each}
			{#if open}
				<div class="relative min-w-[min(120px,100%)] max-w-full flex-1">
					<input
						bind:this={inputRef}
						type="text"
						bind:value={inputValue}
						onkeydown={handleKeydown}
						placeholder={m.chat_new_chat_tags_placeholder()}
						class="w-full px-2 py-1 text-xs pointer-coarse:text-base bg-transparent border-none outline-none placeholder-muted-foreground/60 text-foreground"
					/>
					{#if suggestions.length > 0}
						<div
							data-slot="chat-tag-suggestions"
							class="absolute z-10 mt-1 w-full rounded-md border border-border bg-popover shadow-md"
						>
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
