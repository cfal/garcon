<script lang="ts">
	import { tick } from 'svelte';
	import Tag from '@lucide/svelte/icons/tag';
	import Plus from '@lucide/svelte/icons/plus';
	import ChatTagEditor from '../ChatTagEditor.svelte';
	import { getOptionalTransientLayers } from '$lib/context';
	import { allocateTransientLayerId } from '$lib/workspace/transient-layer-id';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		tags: string[];
		knownTags: string[];
		open: boolean;
		onToggle: () => void;
		onAdd: (raw: string) => boolean;
		onRemove: (tag: string) => void;
		onClose: () => void;
	}

	let { tags, knownTags, open, onToggle, onAdd, onRemove, onClose }: Props = $props();
	let addButton = $state<HTMLButtonElement | null>(null);
	let rowElement = $state<HTMLDivElement | null>(null);
	const transientLayers = getOptionalTransientLayers();
	const layerId = allocateTransientLayerId('session-tags');

	$effect(() => {
		if (!open || !transientLayers || !rowElement) return;
		return transientLayers.register({
			id: layerId,
			kind: 'inline-editor',
			modality: 'nonmodal',
			isOpen: () => open,
			element: () => rowElement,
			onEscape: () => { onClose(); return true; },
			restoreFocus: () => addButton?.focus(),
		});
	});

	async function removeTag(tag: string): Promise<void> {
		onRemove(tag);
		await tick();
		if (document.activeElement === document.body) addButton?.focus();
	}
</script>

<div
	bind:this={rowElement}
	data-slot="new-chat-tags-row"
	class="flex min-h-11 min-w-0 items-center gap-2 rounded-lg border border-border bg-background px-4 py-1"
>
	<Tag class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
	{#if tags.length === 0 && !open}
		<button
			bind:this={addButton}
			type="button"
			aria-label={m.chat_new_chat_tags_add_to_session()}
			aria-expanded={open}
			onclick={onToggle}
			class="flex min-h-7 min-w-0 flex-1 items-center gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			<span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{m.chat_new_chat_tags_add_to_session()}</span>
			<span class="inline-flex size-8 shrink-0 items-center justify-center" aria-hidden="true"><Plus class="size-4 text-muted-foreground" /></span>
		</button>
	{:else}
		<div class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
			{#if tags.length === 0}
				<span class="min-w-0 text-xs text-muted-foreground">{m.chat_new_chat_tags_add_to_session()}</span>
			{/if}
			<ChatTagEditor
				{tags}
				{knownTags}
				{open}
				presentation="session-row"
				{onAdd}
				onRemove={(tag) => void removeTag(tag)}
				{onClose}
			/>
		</div>
		<button
			bind:this={addButton}
			type="button"
			aria-label={m.chat_new_chat_tags_add_to_session()}
			title={m.chat_new_chat_tags_add_to_session()}
			aria-expanded={open}
			onclick={onToggle}
			class="inline-flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			<Plus class="size-4 text-muted-foreground" aria-hidden="true" />
		</button>
	{/if}
</div>
