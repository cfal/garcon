<script lang="ts">
	import { untrack } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import {
		CANVAS_MAX_CONNECTIONS,
		CANVAS_LABEL_MAX_LENGTH,
		type CanvasNode,
	} from '$shared/chat-canvas';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import * as m from '$lib/paraglide/messages.js';
	let {
		visible = true,
		nodes,
		chats,
		initialSource = '',
		capacity = CANVAS_MAX_CONNECTIONS,
		onconnect,
		onclose,
	}: {
		visible?: boolean;
		nodes: CanvasNode[];
		chats: Readonly<Record<string, ChatSessionRecord>>;
		initialSource?: string;
		capacity?: number;
		onconnect: (source: string, target: string, label: string) => boolean;
		onclose: () => void;
	} = $props();
	let source = $state(untrack(() => initialSource));
	let target = $state('');
	let label = $state('');
	const canConnect = $derived(
		capacity > 0 &&
			source !== target &&
			nodes.some((node) => node.id === source) &&
			nodes.some((node) => node.id === target),
	);
	function title(node: CanvasNode) {
		return node.type === 'box'
			? node.title
			: chats[node.chatId]?.title || m.canvas_unavailable_chat();
	}
	function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!canConnect) return;
		if (onconnect(source, target, label)) onclose();
	}
</script>

{#if visible}
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
					<button class="canvas-button" disabled={!canConnect}>{m.canvas_connect()}</button>
				</div>
			</form>
		</Dialog.Content>
	</Dialog.Root>
{/if}
