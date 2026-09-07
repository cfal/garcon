<script lang="ts">
	import type { CanvasContent } from '$shared/chat-canvas';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import { boxChats } from '$lib/chat-canvas/canvas-layout';
	import * as m from '$lib/paraglide/messages.js';
	import CanvasChatCard from './CanvasChatCard.svelte';
	let {
		content,
		chats,
		selectedIds,
		currentTime,
		onselect,
		onopen,
	}: {
		content: CanvasContent;
		chats: Readonly<Record<string, ChatSessionRecord>>;
		selectedIds: ReadonlySet<string>;
		currentTime: Date;
		onselect: (id: string) => void;
		onopen: (id: string) => void;
	} = $props();
	function title(id: string): string {
		const node = content.nodes.find((entry) => entry.id === id);
		return node?.type === 'box'
			? node.title
			: node?.type === 'chat'
				? chats[node.chatId]?.title || m.canvas_unavailable_chat()
				: '';
	}
	const groups = $derived([
		...content.nodes
			.filter((node) => node.type === 'box')
			.map((box) => ({ id: box.id, title: box.title })),
		{ id: null, title: m.canvas_ungrouped() },
	]);
</script>

<div class="h-full overflow-y-auto p-3" data-canvas-list>
	{#each groups as group (group.id)}
		{@const members = boxChats(content, group.id)}
		{#if group.id || members.length}
			<section class="mb-4 rounded-lg border border-border bg-muted/30">
				<div class="flex items-center justify-between border-b border-border p-3">
					<h2 class="font-semibold">{group.title}</h2>
					{#if group.id}<button
							class="canvas-button"
							aria-label={`${m.canvas_show_details()}: ${group.title}`}
							onclick={() => onselect(group.id!)}>{m.canvas_show_details()}</button
						>{/if}
				</div>
				<ul class="space-y-2 p-2">
					{#each members as node (node.id)}
						<svelte:boundary>
							<li
								class="rounded-md border border-border bg-card"
								class:canvas-selected={selectedIds.has(node.id)}
							>
								<CanvasChatCard chat={chats[node.chatId]} {currentTime} />
								<div class="flex justify-end gap-2 border-t border-border p-2">
									<button class="canvas-button" onclick={() => onselect(node.id)}
										>{m.canvas_show_details()}</button
									>{#if chats[node.chatId]}<button
											class="canvas-button"
											onclick={() => onopen(node.chatId)}>{m.canvas_open_chat()}</button
										>{/if}
								</div>
							</li>
							{#snippet failed()}<li>{m.canvas_unavailable_chat()}</li>{/snippet}
						</svelte:boundary>
					{:else}<li class="p-4 text-sm text-muted-foreground">{m.canvas_empty_box()}</li>{/each}
				</ul>
			</section>
		{/if}
	{/each}
	{#if content.connections.length}
		<h2 class="mb-2 font-semibold">{m.canvas_connection()}</h2>
		<ul class="space-y-2">
			{#each content.connections as edge (edge.id)}<li>
					<button class="canvas-button w-full justify-start" onclick={() => onselect(edge.id)}
						>{title(edge.source)} → {title(edge.target)}{edge.label
							? ` · ${edge.label}`
							: ''}</button
					>
				</li>{/each}
		</ul>
	{/if}
</div>
