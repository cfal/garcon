<script lang="ts">
	import Save from '@lucide/svelte/icons/save';
	import Eye from '@lucide/svelte/icons/eye';
	import Pencil from '@lucide/svelte/icons/pencil';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import X from '@lucide/svelte/icons/x';
	import { Button } from '$lib/components/ui/button';
	import CodeEditor from './CodeEditor.svelte';
	import MarkdownViewer from './MarkdownViewer.svelte';
	import ImageViewer from './ImageViewer.svelte';
	import EditorSettingsMenu from './EditorSettingsMenu.svelte';
	import MarkdownViewerSettingsMenu from './MarkdownViewerSettingsMenu.svelte';
	import type { FileViewSession } from '$lib/files/sessions/file-view-session.svelte.js';
	import type { PresentationHostId } from '$lib/workspace/surface-types.js';
	import { getFileSessions, getWorkbenchCommands } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import { fileSurfaceId } from '$lib/workspace/surface-types.js';
	import ResponsiveSurfaceActions, {
		type ResponsiveSurfaceAction,
	} from '$lib/components/shared/ResponsiveSurfaceActions.svelte';
	import FilePathTitle from './FilePathTitle.svelte';
	import FileFreshnessBanner from './FileFreshnessBanner.svelte';
	import FileEditorStatus from './FileEditorStatus.svelte';
	import type { ChatDraftAppend } from '$lib/chat/composer/chat-draft-append.js';
	import { canSaveFileChanges } from '$lib/files/persistence/file-write-policy.js';

	interface Props {
		session: FileViewSession;
		presentation: PresentationHostId;
		onClose?: () => void;
		closeDisabled?: boolean;
		onAppendToChatDraft?: ChatDraftAppend;
	}

	let {
		session,
		presentation,
		onClose,
		closeDisabled = false,
		onAppendToChatDraft,
	}: Props = $props();
	const files = getFileSessions();
	const commands = getWorkbenchCommands();
	const compact = $derived(presentation === 'mobile');
	const toolbarActions = $derived.by<ResponsiveSurfaceAction[]>(() => {
		const actions: ResponsiveSurfaceAction[] = [];
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
				onclick: () =>
					void commands.execute('file.save', {
						viewId: session.id,
						surfaceId: fileSurfaceId(session.id),
					}),
				disabled: !canSaveFileChanges(session),
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
			disabled: session.loading || session.mutationGuarded,
			busy: session.refreshing,
			priority: 2,
			iconClass: session.refreshing ? 'animate-spin' : undefined,
		});
		if (session.isExternallyStale && session.contentKind !== 'image' && !session.mutationGuarded) {
			actions.push({
				id: 'compare-file',
				label: m.file_session_compare(),
				icon: Eye,
				onclick: () => void files.showConflict(session.id),
				priority: 1,
			});
		}
		if (session.dirty) {
			actions.push({
				id: 'export-file',
				label: m.file_session_export_local_copy(),
				icon: Save,
				onclick: () => void files.exportContent(session.id),
				priority: 3,
			});
		}
		return actions;
	});

	function showMarkdown(): void {
		session.markdownMode = 'rendered';
		session.rendererMode = 'markdown';
	}

	function showSource(): void {
		void files.showSource(session.id);
	}

	$effect(() => {
		return commands.registerFileSurface(session.id, {
			appendToChatDraft: (block) => onAppendToChatDraft?.(block) ?? 'unavailable',
		});
	});
</script>

<div
	data-workspace-surface-id={fileSurfaceId(session.id)}
	class="flex h-full min-h-0 min-w-0 flex-col bg-background"
	onfocusin={() => session.noteFocused()}
>
	<header
		class="surface-toolbar flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-3"
		style="container-name: surface-toolbar; container-type: inline-size;"
	>
		<FilePathTitle path={session.fullPath} fileName={session.fileName} dirty={session.dirty} />
		<ResponsiveSurfaceActions
			actions={toolbarActions}
			menuLabel={m.workspace_surface_actions()}
			class="ml-2"
		/>
		{#if session.rendererMode === 'markdown'}
			<MarkdownViewerSettingsMenu />
		{:else if session.rendererMode === 'code'}
			<EditorSettingsMenu />
		{/if}
		{#if onClose && (compact || presentation === 'dialog')}
			<Button
				variant="ghost"
				size="icon-sm"
				onclick={onClose}
				disabled={closeDisabled}
				aria-label={m.file_session_close()}
				title={m.file_session_close()}
			>
				<X class="h-4 w-4" />
			</Button>
		{/if}
	</header>

	{#if session.isExternallyStale || session.refreshError || session.freshnessError}
		<FileFreshnessBanner
			changed={session.isExternallyStale}
			isRefreshing={session.refreshing}
			refreshError={session.refreshError ?? session.freshnessError}
			onRefresh={() => files.refresh(session.id)}
		/>
	{/if}

	{#if session.document.recoveryError}
		<div
			class="flex shrink-0 items-center gap-2 border-b border-status-warning-border bg-status-warning px-3 py-2 text-xs text-status-warning-foreground"
			role="status"
		>
			<TriangleAlert class="h-4 w-4 shrink-0" />
			<span class="min-w-0 flex-1"
				>{m.file_recovery_failed({ detail: session.document.recoveryError })}</span
			>
			<Button variant="outline" size="sm" onclick={() => void files.flushRecovery()}
				>{m.common_retry()}</Button
			>
		</div>
	{/if}

	{#if session.saveError}
		<div
			class="flex shrink-0 items-center gap-2 border-b border-status-error-border bg-status-error px-3 py-2 text-xs text-status-error-foreground"
		>
			<TriangleAlert class="h-4 w-4 shrink-0" />
			<span class="min-w-0 break-words">{session.saveError}</span>
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
			<MarkdownViewer {session} {presentation} />
		{:else}
			<CodeEditor {session} />
		{/if}
	</div>
	{#if session.rendererMode === 'code' && !session.loading && !session.loadError}
		<FileEditorStatus {session} {compact} />
	{/if}
</div>
