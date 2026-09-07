<script lang="ts">
	import type { CanvasDocumentState } from '$lib/chat-canvas/canvas-document.svelte';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import { CANVAS_LABEL_MAX_LENGTH } from '$shared/chat-canvas';
	import * as m from '$lib/paraglide/messages.js';
	let {
		document,
		selectedIds,
		chats,
		disabled,
		onrename,
		onopen,
		onbeside,
		onclose,
	}: {
		document: CanvasDocumentState;
		selectedIds: ReadonlySet<string>;
		chats: Readonly<Record<string, ChatSessionRecord>>;
		disabled: boolean;
		onrename: (id: string, title: string) => void;
		onopen: (id: string) => void;
		onbeside: ((id: string) => void) | undefined;
		onclose: () => void;
	} = $props();
	const id = $derived(selectedIds.size === 1 ? [...selectedIds][0] : null);
	const node = $derived(document.content.nodes.find((entry) => entry.id === id));
	const edge = $derived(document.content.connections.find((entry) => entry.id === id));
	const boxes = $derived(document.content.nodes.filter((entry) => entry.type === 'box'));
</script>

<aside
	class="flex shrink-0 flex-wrap items-center gap-2 border-t border-border bg-card p-2"
	aria-label={m.canvas_show_details()}
>
	{#if node?.type === 'box'}
		<span class="min-w-0 truncate text-sm font-medium">{node.title}</span><button
			class="canvas-button"
			{disabled}
			onclick={() => onrename(node.id, node.title)}>{m.canvas_rename_box()}</button
		>
	{:else if node?.type === 'chat'}
		<label class="flex min-w-0 items-center gap-2 text-xs"
			>{m.canvas_move_to()}<select
				class="canvas-input max-w-48"
				value={node.boxId ?? ''}
				{disabled}
				onchange={(event) => document.moveToBox(node.id, event.currentTarget.value || null)}
				><option value="">{m.canvas_ungrouped()}</option>{#each boxes as box (box.id)}<option
						value={box.id}>{box.title}</option
					>{/each}</select
			></label
		>
		{#if node.boxId}<button
				class="canvas-button"
				{disabled}
				onclick={() => document.reorderChat(node.id, -1)}>{m.canvas_move_up()}</button
			><button class="canvas-button" {disabled} onclick={() => document.reorderChat(node.id, 1)}
				>{m.canvas_move_down()}</button
			>{/if}
		{#if chats[node.chatId]}<button class="canvas-button" onclick={() => onopen(node.chatId)}
				>{m.canvas_open_chat()}</button
			>{#if onbeside}<button class="canvas-button" onclick={() => onbeside?.(node.chatId)}
					>{m.canvas_open_beside()}</button
				>{/if}{/if}
	{:else if edge}
		<form
			class="flex min-w-0 flex-1 items-center gap-2"
			onsubmit={(event) => {
				event.preventDefault();
				if (disabled) return;
				const data = new FormData(event.currentTarget);
				document.labelConnection(edge.id, String(data.get('label') ?? ''));
			}}
		>
			<input
				name="label"
				class="canvas-input"
				aria-label={m.canvas_label()}
				value={edge.label}
				maxlength={CANVAS_LABEL_MAX_LENGTH}
				{disabled}
			/><button class="canvas-button" {disabled}>{m.canvas_apply()}</button>
		</form>
	{:else}<span class="text-xs text-muted-foreground"
			>{m.canvas_selection_count({ count: selectedIds.size })}</span
		>{/if}
	<button
		class="canvas-button"
		{disabled}
		title={m.canvas_remove_description()}
		onclick={() => {
			document.remove(selectedIds);
			onclose();
		}}>{m.canvas_remove()}</button
	>
	<button class="canvas-button ml-auto" onclick={onclose}>{m.canvas_done()}</button>
</aside>
