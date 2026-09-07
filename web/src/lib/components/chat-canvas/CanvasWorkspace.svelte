<script lang="ts">
	import { SvelteFlowProvider } from '@xyflow/svelte';
	import { tick, untrack } from 'svelte';
	import { availablePosition } from '$lib/chat-canvas/canvas-layout';
	import { CANVAS_MAX_NODES, CANVAS_MAX_CONNECTIONS } from '$shared/chat-canvas';
	import type { CanvasSession } from '$lib/chat-canvas/canvas-session.svelte';
	import type { CanvasController } from '$lib/chat-canvas/canvas-controller.svelte';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import { getWorkspaceShortcuts } from '$lib/context';
	import { setCanvasView } from '$lib/context/canvas-context';
	import * as m from '$lib/paraglide/messages.js';
	import { CanvasEditorState } from './canvas-editor-state.svelte';
	import CanvasFlow from './CanvasFlow.svelte';
	import CanvasList from './CanvasList.svelte';
	import CanvasInspector from './CanvasInspector.svelte';
	import CanvasNameDialog from './CanvasNameDialog.svelte';
	import CanvasChatPicker from './CanvasChatPicker.svelte';
	import CanvasConnectionDialog from './CanvasConnectionDialog.svelte';

	let {
		session,
		controller,
		chats,
		visible,
		presentation,
		onopen,
		onbeside,
	}: {
		session: CanvasSession;
		controller: CanvasController;
		chats: readonly ChatSessionRecord[];
		visible: boolean;
		presentation: string;
		onopen: (id: string) => void;
		onbeside: ((id: string) => void) | undefined;
	} = $props();
	const disabled = $derived(controller.loading || controller.closing || session.reloading);
	const ui = new CanvasEditorState({
		get document() {
			return session.document;
		},
		get disabled() {
			return disabled;
		},
	});
	const content = $derived(session.document.content);
	const chatsById = $derived(Object.fromEntries(chats.map((chat) => [chat.id, chat])));
	const boxes = $derived(content.nodes.filter((node) => node.type === 'box'));
	const editing = $derived(!disabled && (presentation !== 'mobile' || ui.touchEditing));
	const selectedBox = $derived(
		content.nodes.find((node) => node.type === 'box' && ui.selectedIds.has(node.id))?.id ?? '',
	);
	const matches = $derived(
		ui.query.trim()
			? content.nodes
					.filter((node) => {
						const label =
							node.type === 'box'
								? node.title
								: `${chatsById[node.chatId]?.title ?? ''} ${chatsById[node.chatId]?.projectPath ?? ''} ${chatsById[node.chatId]?.tags.join(' ') ?? ''}`;
						return label.toLowerCase().includes(ui.query.toLowerCase());
					})
					.slice(0, 20)
			: [],
	);
	let currentTime = $state(new Date());
	let diagram = $state<CanvasFlow>();
	let keyboardScope = $state<HTMLElement>();
	const shortcuts = getWorkspaceShortcuts();
	$effect(() => {
		if (!visible || !keyboardScope) return;
		return shortcuts.registerLocalShortcutOwner(keyboardScope, (event) => {
			ui.keydown(event);
			return event.defaultPrevented;
		});
	});
	setCanvasView({
		get document() {
			return session.document;
		},
		get chats() {
			return chatsById;
		},
		get currentTime() {
			return currentTime;
		},
		get readOnly() {
			return !editing;
		},
		openChat: (id) => onopen(id),
	});

	$effect(() => {
		void content;
		untrack(() => ui.reconcile());
	});
	$effect(() => {
		if (!visible) return;
		const timer = setInterval(() => (currentTime = new Date()), 60_000);
		return () => clearInterval(timer);
	});
	function select(id: string) {
		ui.select(new Set([id]));
		diagram?.focusNode(id);
		ui.query = '';
	}
	function position() {
		return availablePosition(content, diagram?.centerPosition() ?? { x: 0, y: 0 });
	}
</script>

<section
	bind:this={keyboardScope}
	class="flex h-full min-h-0 flex-col outline-none"
	aria-label={m.canvas_title()}
>
	<div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card p-2">
		<button
			class="canvas-button"
			disabled={disabled || content.nodes.length >= CANVAS_MAX_NODES}
			onclick={() => (ui.dialog = { kind: 'box' })}>{m.canvas_add_box()}</button
		>
		<button
			class="canvas-button"
			disabled={disabled || content.nodes.length >= CANVAS_MAX_NODES}
			onclick={() => (ui.dialog = { kind: 'chats', boxId: selectedBox })}
			>{m.canvas_add_chats()}</button
		>
		<button
			class="canvas-button"
			disabled={disabled ||
				content.nodes.length < 2 ||
				content.connections.length >= CANVAS_MAX_CONNECTIONS}
			onclick={() => (ui.dialog = { kind: 'connect' })}>{m.canvas_connect()}</button
		>
		<button
			class="canvas-button"
			disabled={disabled || !session.document.canUndo}
			onclick={() => session.document.undo()}>{m.canvas_undo()}</button
		>
		<button
			class="canvas-button"
			disabled={disabled || !session.document.canRedo}
			onclick={() => session.document.redo()}>{m.canvas_redo()}</button
		>
		<div class="ml-auto flex gap-1">
			<button
				class="canvas-button"
				aria-pressed={controller.view === 'diagram'}
				onclick={() => (controller.view = 'diagram')}>{m.canvas_diagram()}</button
			><button
				class="canvas-button"
				aria-pressed={controller.view === 'list'}
				onclick={() => (controller.view = 'list')}>{m.canvas_list()}</button
			>
		</div>
	</div>
	{#if ui.error}<div
			role="alert"
			class="flex items-center gap-2 bg-destructive/10 p-2 text-sm text-destructive"
		>
			{ui.error}<button class="canvas-button" onclick={() => (ui.error = null)}
				>{m.canvas_close()}</button
			>
		</div>{/if}
	<div class="relative min-h-0 flex-1">
		{#if controller.view === 'diagram'}
			<SvelteFlowProvider>
				<CanvasFlow
					bind:this={diagram}
					{session}
					{controller}
					{editing}
					{visible}
					{presentation}
					selectedIds={ui.selectedIds}
					onselect={(ids) => ui.select(ids)}
					onerror={(error) => (ui.error = error)}
				/>
			</SvelteFlowProvider>
			<div class="absolute left-3 top-3 z-10 w-52 max-w-[calc(100%-1.5rem)]">
				<input
					type="search"
					class="canvas-input shadow-sm"
					placeholder={m.canvas_search()}
					aria-label={m.canvas_search()}
					bind:value={ui.query}
				/>
				{#if ui.query.trim()}<ul
						class="mt-1 max-h-60 overflow-y-auto rounded-md border border-border bg-card shadow-md"
					>
						{#each matches as node (node.id)}<li>
								<button
									class="w-full truncate px-3 py-2 text-left text-sm hover:bg-accent focus-visible:outline focus-visible:outline-ring"
									onclick={() => select(node.id)}
									>{node.type === 'box'
										? node.title
										: chatsById[node.chatId]?.title || m.canvas_unavailable_chat()}</button
								>
							</li>{:else}<li class="p-3 text-sm text-muted-foreground">
								{m.canvas_search_empty()}
							</li>{/each}
					</ul>{/if}
			</div>
			<div class="absolute bottom-7 left-3 z-10 flex flex-wrap gap-1">
				<button class="canvas-button" onclick={() => diagram?.fit()}>{m.canvas_fit()}</button
				><button
					class="canvas-button"
					aria-label={m.canvas_zoom_out()}
					onclick={() => diagram?.zoomOut()}>−</button
				><button
					class="canvas-button"
					aria-label={m.canvas_zoom_in()}
					onclick={() => diagram?.zoomIn()}>+</button
				>{#if presentation === 'mobile'}<button
						class="canvas-button"
						aria-pressed={ui.touchEditing}
						onclick={() => (ui.touchEditing = !ui.touchEditing)}>{m.canvas_edit()}</button
					>{/if}
			</div>
			{#if content.nodes.length === 0}<div
					class="pointer-events-none absolute inset-0 flex items-center justify-center p-10 text-center text-sm text-muted-foreground"
				>
					{m.canvas_board_empty()}
				</div>{/if}
		{:else}
			<CanvasList
				{content}
				chats={chatsById}
				selectedIds={ui.selectedIds}
				{currentTime}
				onselect={(id) => ui.select(new Set([id]))}
				{onopen}
			/>
		{/if}
	</div>
	{#if ui.selectedIds.size}
		<CanvasInspector
			document={session.document}
			selectedIds={ui.selectedIds}
			chats={chatsById}
			{disabled}
			{onopen}
			{onbeside}
			onrename={(id, title) => (ui.dialog = { kind: 'rename-box', id, title })}
			onclose={() => ui.select(new Set())}
		/>
	{:else}<p
			class="shrink-0 border-t border-border bg-card px-3 py-1 text-[11px] text-muted-foreground"
		>
			{presentation === 'mobile' ? m.canvas_touch_help() : m.canvas_desktop_help()}
		</p>{/if}
</section>

{#if ui.dialog}
	{#key ui.dialog}
		{@const dialog = ui.dialog}
		{#if dialog.kind === 'box' || dialog.kind === 'rename-box'}
			<CanvasNameDialog
				title={dialog.kind === 'box' ? m.canvas_add_box() : m.canvas_rename_box()}
				initial={dialog.kind === 'box' ? m.canvas_default_box() : dialog.title}
				onclose={() => (ui.dialog = null)}
				onsubmit={async (title) => {
					if (disabled) return false;
					if (dialog.kind === 'box') {
						const id = session.document.addBox(title, position());
						ui.select(new Set([id]));
						await tick();
						diagram?.focusNode(id);
					} else session.document.renameBox(dialog.id, title);
					return true;
				}}
			/>
		{:else if dialog.kind === 'chats'}
			<CanvasChatPicker
				{chats}
				{boxes}
				initialBox={dialog.boxId}
				capacity={CANVAS_MAX_NODES - content.nodes.length}
				onclose={() => (ui.dialog = null)}
				onadd={(ids, boxId) => {
					if (!disabled) session.document.addChats(ids, boxId, position());
				}}
			/>
		{:else}
			<CanvasConnectionDialog
				nodes={content.nodes}
				chats={chatsById}
				initialSource={content.nodes.find((node) => ui.selectedIds.has(node.id))?.id ?? ''}
				onclose={() => (ui.dialog = null)}
				onconnect={(source, target, label) => {
					if (disabled || content.connections.length >= CANVAS_MAX_CONNECTIONS) return;
					session.document.connect({
						source,
						target,
						label,
						sourceSide: 'right',
						targetSide: 'left',
					});
				}}
			/>
		{/if}
	{/key}
{/if}
