<script lang="ts">
	import { untrack } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { CANVAS_LABEL_MAX_LENGTH, type CanvasNode } from '$shared/chat-canvas';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import * as m from '$lib/paraglide/messages.js';
	let {
		nodes,
		chats,
		initialSource = '',
		onconnect,
		onclose,
	}: {
		nodes: CanvasNode[];
		chats: Readonly<Record<string, ChatSessionRecord>>;
		initialSource?: string;
		onconnect: (source: string, target: string, label: string) => void;
		onclose: () => void;
	} = $props();
	let source = $state(untrack(() => initialSource));
	let target = $state('');
	let label = $state('');
	function title(node: CanvasNode) {
		return node.type === 'box'
			? node.title
			: chats[node.chatId]?.title || m.canvas_unavailable_chat();
	}
	function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!source || !target || source === target) return;
		onconnect(source, target, label);
		onclose();
	}
</script>

<Dialog.Root
	open
	onOpenChange={(open) => {
		if (!open) onclose();
	}}
>
	<Dialog.Content>
		<Dialog.Header
			><Dialog.Title>{m.canvas_connect()}</Dialog.Title><Dialog.Description
				>{m.canvas_connect_help()}</Dialog.Description
			></Dialog.Header
		>
		<form class="space-y-3" onsubmit={submit}>
			<label class="block space-y-1 text-sm"
				>{m.canvas_source()}<select
					class="canvas-input text-base"
					value={source}
					onchange={(event) => (source = event.currentTarget.value)}
					><option value="">—</option>{#each nodes as node (node.id)}<option value={node.id}
							>{title(node)}</option
						>{/each}</select
				></label
			>
			<label class="block space-y-1 text-sm"
				>{m.canvas_target()}<select
					class="canvas-input text-base"
					value={target}
					onchange={(event) => (target = event.currentTarget.value)}
					><option value="">—</option>{#each nodes as node (node.id)}<option
							value={node.id}
							disabled={node.id === source}>{title(node)}</option
						>{/each}</select
				></label
			>
			<label class="block space-y-1 text-sm"
				>{m.canvas_label()}<input
					class="canvas-input text-base"
					bind:value={label}
					maxlength={CANVAS_LABEL_MAX_LENGTH}
				/></label
			>
			<div class="flex justify-end">
				<button class="canvas-button" disabled={!source || !target || source === target}
					>{m.canvas_connect()}</button
				>
			</div>
		</form>
	</Dialog.Content>
</Dialog.Root>
