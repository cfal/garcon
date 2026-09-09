<script lang="ts">
	import { onMount } from 'svelte';
	import type { CanvasController } from '$lib/chat-canvas/canvas-controller.svelte';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import type { PresentationHostId } from '$lib/workspace/surface-types';
	import { getWorkspaceCoordinator } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import CanvasWorkspace from './CanvasWorkspace.svelte';
	import CanvasNameDialog from './CanvasNameDialog.svelte';
	import CanvasConfirmDialog from './CanvasConfirmDialog.svelte';
	import './canvas.css';

	let {
		controller,
		chats,
		visible,
		presentation,
	}: {
		controller: CanvasController;
		chats: readonly ChatSessionRecord[];
		visible: boolean;
		presentation: PresentationHostId;
	} = $props();
	const workspace = getWorkspaceCoordinator();
	let dialog = $state<'create' | 'rename' | 'copy' | 'delete' | 'reload' | null>(null);
	let navigationError = $state<string | null>(null);
	const session = $derived(controller.session);
	const busy = $derived(controller.loading || controller.closing || session?.reloading === true);
	const saveStatus = $derived.by(() => {
		if (busy) return m.canvas_loading();
		if (session?.saving) return m.canvas_saving();
		if (session?.dirty || session?.conflict) return m.canvas_unsaved();
		if (session) return m.canvas_saved();
		return '';
	});
	const nameDialogTitle = $derived.by(() => {
		switch (dialog) {
			case 'create':
				return m.canvas_create();
			case 'rename':
				return m.canvas_rename();
			case 'copy':
				return m.canvas_copy();
			default:
				return '';
		}
	});

	onMount(() => {
		if (!controller.loaded && presentation === 'mobile') controller.view = 'list';
		void controller.activate();
	});
	$effect(() => {
		if (!visible) return;
		const refresh = () => {
			if (document.visibilityState === 'visible') void controller.refresh();
		};
		const flush = () => {
			void controller.session?.flush();
		};
		const timer = setInterval(refresh, 15_000);
		window.addEventListener('focus', refresh);
		return () => {
			clearInterval(timer);
			window.removeEventListener('focus', refresh);
			flush();
		};
	});

	async function openChat(id: string) {
		try {
			if (presentation === 'mobile' || presentation === 'dialog')
				await workspace.showChatInCurrentWindow(id);
			else await workspace.showChatInWindow(id, presentation);
		} catch (error) {
			navigationError = error instanceof Error ? error.message : String(error);
		}
	}
	async function openBeside(id: string) {
		try {
			await workspace.openChatBeside(
				id,
				presentation === 'mobile' || presentation === 'dialog' ? undefined : presentation,
			);
		} catch (error) {
			navigationError = error instanceof Error ? error.message : String(error);
		}
	}
	async function submitName(value: string): Promise<boolean> {
		if (busy) return false;
		if (dialog === 'create') return controller.create(value);
		if (dialog === 'copy') return controller.saveCopy(value);
		if (dialog === 'rename' && session) {
			session.document.rename(value);
			return true;
		}
		return false;
	}
</script>

<section
	class="flex h-full min-h-0 flex-col bg-background text-foreground"
	aria-label={m.workspace_surface_chat_canvas()}
	data-canvas-panel
>
	<header class="shrink-0 border-b border-border bg-card p-3">
		<div class="flex flex-wrap items-center gap-2">
			<select
				class="canvas-input flex-1 sm:max-w-64"
				style="min-width: 12rem; flex-basis: 12rem"
				aria-label={m.canvas_choose()}
				value={session?.saved.id ?? ''}
				disabled={busy}
				onchange={(event) => {
					const id = event.currentTarget.value;
					event.currentTarget.value = session?.saved.id ?? '';
					void controller.open(id);
				}}
			>
				<option value="" disabled>{m.canvas_no_boards()}</option
				>{#each controller.canvases as canvas (canvas.id)}<option value={canvas.id}
						>{session?.saved.id === canvas.id
							? session.document.content.title
							: canvas.title}</option
					>{/each}
			</select>
			<button class="canvas-button" disabled={busy} onclick={() => (dialog = 'create')}
				>{m.canvas_new()}</button
			>
			{#if session}<button class="canvas-button" disabled={busy} onclick={() => (dialog = 'rename')}
					>{m.canvas_rename()}</button
				><button class="canvas-button" disabled={busy} onclick={() => (dialog = 'copy')}
					>{m.canvas_copy()}</button
				><button class="canvas-button" disabled={busy} onclick={() => (dialog = 'delete')}
					>{m.canvas_delete()}</button
				>{/if}
			<span class="ml-auto text-xs text-muted-foreground" role="status">{saveStatus}</span>
		</div>
	</header>
	{#if controller.unavailableIds.length}
		<p role="alert" class="border-b border-border bg-muted p-3 text-sm">
			{m.canvas_catalog_warning()}
		</p>
	{/if}
	{#if controller.error || navigationError}<div
			role="alert"
			class="flex flex-wrap items-center gap-2 border-b border-border bg-destructive/10 p-3 text-sm"
		>
			<span>{controller.error || navigationError}</span><button
				class="canvas-button"
				onclick={() => {
					navigationError = null;
					void controller.activate();
				}}>{m.canvas_refresh()}</button
			>
		</div>{/if}
	{#if session?.conflict}
		<div
			role="alert"
			class="flex flex-wrap items-center gap-2 border-b border-border bg-muted p-3 text-sm"
		>
			<span>{m.canvas_conflict()}</span><button
				class="canvas-button"
				disabled={busy}
				onclick={() => (dialog = 'reload')}>{m.canvas_reload()}</button
			><button class="canvas-button" disabled={busy} onclick={() => (dialog = 'copy')}
				>{m.canvas_copy()}</button
			>
		</div>
	{:else if session?.error}
		<div role="alert" class="flex items-center gap-2 bg-destructive/10 p-3 text-sm">
			<span>{session.error}</span><button
				class="canvas-button"
				disabled={session.saving}
				onclick={() => void session?.flush()}>{m.canvas_retry()}</button
			>
		</div>
	{/if}
	{#if session?.recoveryError}<p role="alert" class="bg-muted p-3 text-sm">
			{m.canvas_recovery_error()}
		</p>{/if}
	<div class="min-h-0 flex-1">
		{#if session}
			{#key session.saved.id}<CanvasWorkspace
					{session}
					{controller}
					{chats}
					{visible}
					{presentation}
					onopen={(id) => void openChat(id)}
					onbeside={presentation === 'mobile' ? undefined : (id) => void openBeside(id)}
				/>{/key}
		{:else if controller.loading}<p class="p-6 text-sm text-muted-foreground">
				{m.canvas_loading()}
			</p>
		{:else}<div class="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
				<h1 class="text-lg font-semibold">{m.canvas_empty()}</h1>
				<p class="max-w-sm text-sm text-muted-foreground">{m.canvas_empty_description()}</p>
				<button class="canvas-button" onclick={() => (dialog = 'create')}
					>{m.canvas_create()}</button
				>
			</div>{/if}
	</div>
</section>

{#if dialog === 'create' || dialog === 'rename' || dialog === 'copy'}
	{#key dialog}<CanvasNameDialog
			{visible}
			errorMessage={controller.error || session?.error}
			title={nameDialogTitle}
			initial={dialog === 'create' ? m.canvas_new_name() : (session?.document.content.title ?? '')}
			onclose={() => (dialog = null)}
			onsubmit={submitName}
		/>{/key}
{:else if dialog === 'delete'}
	<CanvasConfirmDialog
		{visible}
		errorMessage={controller.error || session?.error}
		title={m.canvas_delete_confirm()}
		description={m.canvas_delete_description()}
		onclose={() => (dialog = null)}
		onconfirm={() => controller.removeCurrent()}
	/>
{:else if dialog === 'reload'}
	<CanvasConfirmDialog
		{visible}
		errorMessage={controller.error || session?.error}
		title={m.canvas_discard()}
		description={m.canvas_reload_description()}
		onclose={() => (dialog = null)}
		onconfirm={() => session?.discardAndReload() ?? Promise.resolve(false)}
	/>
{/if}
