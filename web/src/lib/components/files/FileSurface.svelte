<script lang="ts">
	import Save from '@lucide/svelte/icons/save';
	import Eye from '@lucide/svelte/icons/eye';
	import Pencil from '@lucide/svelte/icons/pencil';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import { Button } from '$lib/components/ui/button';
	import CodeEditor from './CodeEditor.svelte';
	import MarkdownViewer from './MarkdownViewer.svelte';
	import ImageViewer from './ImageViewer.svelte';
	import EditorSettingsMenu from './EditorSettingsMenu.svelte';
	import MarkdownViewerSettingsMenu from './MarkdownViewerSettingsMenu.svelte';
	import type { FileSession } from './file-session.svelte.js';
	import { getFileSessions } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import { fileSurfaceId } from '$lib/workspace/surface-types.js';

	let {
		session,
		presentation,
	}: {
		session: FileSession;
		presentation: 'main' | 'sidebar' | 'mobile' | 'dialog';
	} = $props();
	const files = getFileSessions();
	const compact = $derived(presentation === 'sidebar' || presentation === 'mobile');

	function showMarkdown(): void {
		session.markdownMode = 'rendered';
		session.rendererMode = 'markdown';
	}

	function showSource(): void {
		session.markdownMode = 'source';
		session.rendererMode = 'code';
	}
</script>

<div
	data-workspace-surface-id={fileSurfaceId(session.id)}
	class="flex h-full min-h-0 min-w-0 flex-col bg-background"
>
	<header class="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
		<div class="min-w-0 flex-1">
			<div class="flex min-w-0 items-center gap-1.5">
				<h2 class="truncate text-sm font-medium text-foreground">{session.fileName}</h2>
				{#if session.dirty}<span
						class="text-status-warning-foreground"
						aria-label={m.file_session_unsaved()}>*</span
					>{/if}
			</div>
			{#if !compact}
				<p class="truncate text-xs text-muted-foreground" title={session.relativePath}>
					{session.relativePath}
				</p>
			{/if}
		</div>
		<div class="flex shrink-0 items-center gap-1">
			<Button
				variant="ghost"
				size="icon-sm"
				onclick={() => files.showOpenFiles()}
				aria-label={m.file_session_open_files()}
				title={m.file_session_open_files()}
			>
				<FolderOpen class="h-4 w-4" />
			</Button>
			{#if session.contentKind === 'markdown'}
				{#if session.rendererMode === 'markdown'}
					<Button variant="ghost" size="sm" onclick={showSource}>
						<Pencil class="h-4 w-4" />
						<span class:hidden={compact}>{m.file_session_edit()}</span>
					</Button>
					<MarkdownViewerSettingsMenu />
				{:else}
					<Button variant="ghost" size="sm" onclick={showMarkdown}>
						<Eye class="h-4 w-4" />
						<span class:hidden={compact}>{m.file_session_view()}</span>
					</Button>
				{/if}
			{/if}
			{#if session.rendererMode === 'code'}
				<EditorSettingsMenu />
				<Button
					variant="default"
					size="sm"
					onclick={() => void files.save(session.id)}
					disabled={session.saving || !session.dirty}
					title={m.editor_actions_save()}
				>
					{#if session.saving}<LoaderCircle class="h-4 w-4 animate-spin" />{:else}<Save
							class="h-4 w-4"
						/>{/if}
					<span class:hidden={compact}
						>{session.saving ? m.editor_actions_saving() : m.editor_actions_save()}</span
					>
				</Button>
			{/if}
		</div>
	</header>

	{#if session.saveError}
		<div
			class="flex shrink-0 items-center gap-2 border-b border-status-error-border bg-status-error px-3 py-2 text-xs text-status-error-foreground"
		>
			<TriangleAlert class="h-4 w-4 shrink-0" />
			<span class="truncate">{session.saveError}</span>
		</div>
	{/if}

	<div class="min-h-0 flex-1 overflow-hidden">
		{#if session.loading}
			<div class="grid h-full place-items-center text-sm text-muted-foreground">
				<div class="flex items-center gap-2">
					<LoaderCircle class="h-4 w-4 animate-spin" />
					{m.file_session_loading_named({ fileName: session.fileName })}
				</div>
			</div>
		{:else if session.loadError}
			<div
				class="grid h-full place-items-center px-6 text-center text-sm text-status-error-foreground"
			>
				<div class="max-w-sm">
					<p>{session.loadError}</p>
					<Button variant="outline" class="mt-3" onclick={() => void files.reload(session.id)}>
						{m.common_retry()}
					</Button>
				</div>
			</div>
		{:else if session.rendererMode === 'image'}
			<ImageViewer {session} />
		{:else if session.rendererMode === 'markdown'}
			<MarkdownViewer {session} />
		{:else}
			<CodeEditor {session} />
		{/if}
	</div>
</div>
