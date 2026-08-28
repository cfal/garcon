<script lang="ts">
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import AlertTriangle from '@lucide/svelte/icons/triangle-alert';
	import type { GitComparisonController } from '$lib/git/review/git-comparison.svelte.js';
	import type { ChatDraftAppend } from '$lib/chat/composer/chat-draft-append.js';
	import type { PaneId } from '$lib/workspace/surface-types.js';
	import GitComparisonHeader from './GitComparisonHeader.svelte';
	import GitDiffDocumentScreen from './GitDiffDocumentScreen.svelte';
	import * as m from '$lib/paraglide/messages.js';

	interface GitComparisonScreenProps {
		comparison: GitComparisonController;
		isLoading: boolean;
		presentation: PaneId | 'mobile';
		active?: boolean;
		fontSize: number;
		onBack?: () => void;
		onEdit?: () => void;
		onRefresh: () => void;
		onOpenInEditor?: (relativePath: string, line: number) => void;
		onAppendToChatDraft?: ChatDraftAppend;
		onOpenChat: () => void;
	}

	let {
		comparison,
		isLoading,
		presentation,
		active = true,
		fontSize,
		onBack,
		onEdit,
		onRefresh,
		onOpenInEditor,
		onAppendToChatDraft,
		onOpenChat,
	}: GitComparisonScreenProps = $props();
	const isMobile = $derived(presentation === 'mobile');
	const fullscreenPaneId = $derived<PaneId | null>(presentation === 'mobile' ? null : presentation);
</script>

{#snippet header(
	showFileTreeToggle: boolean,
	fileTreeVisible: boolean,
	onToggleFileTree: () => void,
)}
	{#if comparison.snapshot}
		<GitComparisonHeader
			snapshot={comparison.snapshot}
			{showFileTreeToggle}
			{fileTreeVisible}
			{onToggleFileTree}
			{onBack}
			{onEdit}
			{fullscreenPaneId}
		/>
		{#if comparison.staleMessage}
			<div
				class="flex items-center gap-2 border-b border-status-warning-border bg-status-warning/10 px-3 py-2 text-xs text-status-warning-muted-foreground"
				role="status"
			>
				<AlertTriangle class="h-3.5 w-3.5 shrink-0" />
				<span class="min-w-0 flex-1">{comparison.staleMessage}</span>
				<button
					type="button"
					class="rounded border border-status-warning-border px-2 py-1 font-medium hover:bg-status-warning/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
					disabled={isLoading}
					onclick={onRefresh}>{m.git_compare_refresh()}</button
				>
			</div>
		{/if}
	{/if}
{/snippet}

{#snippet fallbackActions()}
	{#if onEdit}
		<button
			type="button"
			class="rounded border border-border px-3 py-1.5 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
			onclick={onEdit}
		>
			{m.git_compare_edit_comparison()}
		</button>
	{/if}
{/snippet}

{#if onBack && !comparison.snapshot}
	<header class="flex items-center gap-2 border-b border-border bg-background px-3 py-2">
		<button
			type="button"
			class="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
			aria-label={m.git_history_back_to_comparison_selection()}
			title={m.git_history_back_to_comparison_selection()}
			onclick={onBack}
		>
			<ArrowLeft class="h-4 w-4" />
		</button>
		<h3 class="text-sm font-semibold text-foreground">{m.git_compare_title()}</h3>
	</header>
{/if}

<GitDiffDocumentScreen
	{header}
	{fallbackActions}
	documentId={comparison.snapshot?.documentId ?? null}
	documentAvailable={Boolean(comparison.snapshot)}
	files={comparison.document.visibleFiles}
	{isLoading}
	error={comparison.documentError}
	onDismissError={() => comparison.dismissDocumentError()}
	source={comparison.document.rowSource}
	scrollRequest={comparison.document.scrollRequest}
	fileFilter={comparison.document.fileFilter}
	focusedFilePath={comparison.document.focusedFilePath}
	{isMobile}
	{active}
	{fontSize}
	loadingLabel={m.git_compare_loading()}
	emptyErrorLabel={m.git_compare_load_failed()}
	emptyDocumentLabel={m.git_compare_no_changes()}
	onRetry={onRefresh}
	onSelectFile={(filePath) => comparison.focusFile(filePath)}
	onFileFilterChange={(value) => comparison.setFileFilter(value)}
	onBodyDemand={(demand) => comparison.handleBodyDemand(demand)}
	{onOpenInEditor}
	composerState={comparison.document.commentComposer}
	commentFeedback={comparison.document.commentFeedback}
	commentError={comparison.document.commentError}
	commentCopyText={comparison.document.commentCopyText}
	onAddComment={(filePath, side, line) =>
		comparison.document.openCommentComposer(filePath, side, line)}
	onComposerBodyChange={(body) => comparison.document.setCommentBody(body)}
	onComposerSeverityChange={(severity) => comparison.document.setCommentSeverity(severity)}
	onComposerSubmit={() => comparison.document.submitComment(onAppendToChatDraft)}
	onComposerClose={() => comparison.document.closeCommentComposer()}
	onComposerFocusHandled={() => comparison.document.markCommentComposerFocused()}
	{onOpenChat}
/>
