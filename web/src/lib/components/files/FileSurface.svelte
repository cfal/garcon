<script lang="ts">
	import Save from '@lucide/svelte/icons/save';
	import Eye from '@lucide/svelte/icons/eye';
	import Pencil from '@lucide/svelte/icons/pencil';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { Button } from '$lib/components/ui/button';
	import CodeEditor from './CodeEditor.svelte';
	import MarkdownViewer from './MarkdownViewer.svelte';
	import ImageViewer from './ImageViewer.svelte';
	import EditorSettingsMenu from './EditorSettingsMenu.svelte';
	import MarkdownViewerSettingsMenu from './MarkdownViewerSettingsMenu.svelte';
	import type { FileSession } from '$lib/files/sessions/file-session.svelte.js';
	import { getFileSessions } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import { fileSurfaceId } from '$lib/workspace/surface-types.js';
	import ResponsiveSurfaceActions, {
		type ResponsiveSurfaceAction,
	} from '$lib/components/shared/ResponsiveSurfaceActions.svelte';
	import CopyFilePathButton from './CopyFilePathButton.svelte';
	import FileFreshnessBanner from './FileFreshnessBanner.svelte';
	import { startVisibilityPolling } from '$lib/components/shared/visibility-polling.js';
	import { FILE_FRESHNESS_POLL_MS } from '$lib/files/sessions/file-freshness.js';

	let {
		session,
		presentation,
	}: {
		session: FileSession;
		presentation: 'main' | 'sidebar' | 'mobile' | 'dialog';
	} = $props();
	const files = getFileSessions();
	const compact = $derived(presentation === 'sidebar' || presentation === 'mobile');
	const toolbarActions = $derived.by<ResponsiveSurfaceAction[]>(() => {
		const actions: ResponsiveSurfaceAction[] = [];
		if (presentation !== 'mobile') {
			actions.push({
				id: 'open-files',
				label: m.file_session_open_files(),
				icon: FolderOpen,
				onclick: () => files.showOpenFiles(),
				priority: 3,
			});
		}
		if (session.contentKind === 'markdown') {
			const showingMarkdown = session.rendererMode === 'markdown';
			actions.push({
				id: showingMarkdown ? 'edit' : 'view',
				label: showingMarkdown ? m.file_session_edit() : m.file_session_view(),
				icon: showingMarkdown ? Pencil : Eye,
				onclick: showingMarkdown ? showSource : showMarkdown,
				priority: 1,
				showLabel: true,
			});
		}
		if (session.rendererMode === 'code') {
			actions.push({
				id: 'save',
				label: session.saving ? m.editor_actions_saving() : m.editor_actions_save(),
				icon: session.saving ? LoaderCircle : Save,
				iconClass: session.saving ? 'animate-spin' : undefined,
				onclick: () => void files.save(session.id),
				disabled: session.saving || !session.dirty,
				priority: 0,
				showLabel: true,
				variant: 'primary',
			});
		}
		actions.push({
			id: 'refresh-file',
			label: m.file_session_refresh(),
			icon: RefreshCw,
			onclick: () => void files.refresh(session.id),
			disabled: session.loading || session.saving,
			busy: session.refreshing,
			priority: 2,
			iconClass: session.refreshing ? 'animate-spin' : undefined,
		});
		return actions;
	});

	$effect(() => {
		const sessionId = session.id;
		return startVisibilityPolling({
			intervalMs: FILE_FRESHNESS_POLL_MS,
			pollImmediately: true,
			poll: () => void files.checkFreshness(sessionId),
		});
	});

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
	<header
		class="surface-toolbar flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-3"
		style="container-name: surface-toolbar; container-type: inline-size;"
	>
		<div class="min-w-0 flex-1">
			<div class="flex min-w-0 items-center gap-1.5">
				<h2 class="truncate text-sm font-medium text-foreground">{session.fileName}</h2>
				<CopyFilePathButton path={session.relativePath} />
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
		<ResponsiveSurfaceActions
			actions={toolbarActions}
			menuLabel={m.workspace_surface_actions()}
			class="ml-2"
		>
			{#snippet fixed()}
				{#if session.rendererMode === 'markdown'}
					<MarkdownViewerSettingsMenu />
				{:else if session.rendererMode === 'code'}
					<EditorSettingsMenu />
				{/if}
			{/snippet}
		</ResponsiveSurfaceActions>
	</header>

	{#if session.isExternallyStale || session.refreshError}
		<FileFreshnessBanner
			changed={session.isExternallyStale}
			isRefreshing={session.refreshing}
			refreshError={session.refreshError}
			onRefresh={() => files.refresh(session.id)}
		/>
	{/if}

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
