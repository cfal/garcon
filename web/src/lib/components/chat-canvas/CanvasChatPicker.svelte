<script lang="ts">
	import { untrack } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import type { CanvasBox } from '$shared/chat-canvas';
	import * as m from '$lib/paraglide/messages.js';
	let {
		visible = true,
		chats,
		boxes,
		initialBox = '',
		capacity,
		onadd,
		onclose,
	}: {
		visible?: boolean;
		chats: readonly ChatSessionRecord[];
		boxes: CanvasBox[];
		initialBox?: string;
		capacity: number;
		onadd: (ids: string[], boxId: string | null) => boolean;
		onclose: () => void;
	} = $props();
	let query = $state('');
	let selected = $state<ReadonlySet<string>>(new Set());
	let boxId = $state(untrack(() => initialBox));
	const canAdd = $derived(
		selected.size > 0 &&
			selected.size <= capacity &&
			[...selected].every((id) => chats.some((chat) => chat.id === id)) &&
			(!boxId || boxes.some((box) => box.id === boxId)),
	);
	const matches = $derived(
		chats
			.filter((chat) =>
				`${chat.title} ${chat.projectPath} ${chat.tags.join(' ')}`
					.toLowerCase()
					.includes(query.toLowerCase()),
			)
			.slice(0, 100),
	);
	function toggle(id: string) {
		const next = new Set(selected);
		if (next.has(id)) next.delete(id);
		else if (next.size < capacity) next.add(id);
		selected = next;
	}
	function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!canAdd) return;
		if (onadd([...selected], boxId || null)) onclose();
	}
</script>

{#if visible}
	<Dialog.Root
		open
		onOpenChange={(open) => {
			if (!open) onclose();
		}}
	>
		<Dialog.Content class="flex max-h-[85dvh] flex-col">
			<Dialog.Header
				><Dialog.Title>{m.canvas_add_chats()}</Dialog.Title><Dialog.Description
					>{m.canvas_chat_search()}</Dialog.Description
				></Dialog.Header
			>
			<form class="flex min-h-0 flex-col gap-3" onsubmit={submit}>
				<input
					type="search"
					class="canvas-input text-base"
					aria-label={m.canvas_chat_search()}
					bind:value={query}
				/>
				<label class="space-y-1 text-sm"
					>{m.canvas_move_to()}<select
						class="canvas-input text-base"
						value={boxId}
						onchange={(event) => (boxId = event.currentTarget.value)}
						><option value="">{m.canvas_ungrouped()}</option>{#each boxes as box (box.id)}<option
								value={box.id}>{box.title}</option
							>{/each}</select
					></label
				>
				<div class="min-h-20 overflow-y-auto rounded-md border border-border">
					{#each matches as chat (chat.id)}
						<svelte:boundary>
							<label
								class="flex cursor-pointer items-start gap-3 border-b border-border p-3 last:border-0 hover:bg-accent"
							>
								<input
									type="checkbox"
									class="mt-1 size-4"
									checked={selected.has(chat.id)}
									disabled={!selected.has(chat.id) && selected.size >= capacity}
									onchange={() => toggle(chat.id)}
								/>
								<span class="min-w-0"
									><span class="block truncate text-sm font-medium"
										>{chat.title || m.sidebar_chats_unnamed()}</span
									><span class="block truncate text-xs text-muted-foreground"
										>{chat.projectPath} · {chat.agentId}</span
									></span
								>
							</label>
							{#snippet failed()}<p class="p-3 text-sm">{m.canvas_unavailable_chat()}</p>{/snippet}
						</svelte:boundary>
					{:else}<p class="p-4 text-sm text-muted-foreground">{m.canvas_no_chats()}</p>{/each}
				</div>
				<div class="flex items-center justify-between gap-2">
					<span class="text-xs text-muted-foreground"
						>{m.canvas_selection_count({ count: selected.size })}</span
					><button class="canvas-button" disabled={!canAdd}>{m.canvas_add_selected()}</button>
				</div>
			</form>
		</Dialog.Content>
	</Dialog.Root>
{/if}
