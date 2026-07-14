<script lang="ts">
	// Adapts Git presentation to its host while retaining root-owned workbench state.

	import AlertTriangle from '@lucide/svelte/icons/triangle-alert';
	import Plus from '@lucide/svelte/icons/plus';
	import Minus from '@lucide/svelte/icons/minus';
	import X from '@lucide/svelte/icons/x';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import ChevronUp from '@lucide/svelte/icons/chevron-up';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Archive from '@lucide/svelte/icons/archive';
	import HistoryIcon from '@lucide/svelte/icons/history';
	import GitGraph from '@lucide/svelte/icons/git-graph';
	import GitBranchIcon from '@lucide/svelte/icons/git-branch';
	import PanelLeft from '@lucide/svelte/icons/panel-left';
	import GitFileTree from './GitFileTree.svelte';
	import GitVirtualDiffSurface from './GitVirtualDiffSurface.svelte';
	import GitPorcelainPanel from './GitPorcelainPanel.svelte';
	import GitReviewChangesModal from './GitReviewChangesModal.svelte';
	import GitCommentModal from './GitCommentModal.svelte';
	import GitConfirmModal from './GitConfirmModal.svelte';
	import {
		GitWorkbenchStore,
		type GitWorkbenchTarget,
		type GitDiffActionTarget,
		type GitVirtualReviewRow,
	} from '$lib/stores/git/git-workbench.svelte.js';
	import type { GitInspectorView } from '$lib/stores/git/git-porcelain.svelte';
	import type { ConfirmAction } from '$lib/api/git.js';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import { cn } from '$lib/utils/cn';
	import * as m from '$lib/paraglide/messages.js';
	import { getTransientLayers, getWorkspaceShortcuts } from '$lib/context';
	import { singletonSurfaceId } from '$lib/workspace/surface-types.js';
	import {
		containerPresentationForWidth,
		observeContainerWidth,
		type ContainerPresentation,
	} from '$lib/components/shared/container-presentation.js';

	interface GitWorkbenchProps {
		projectPath?: string | null;
		target?: GitWorkbenchTarget | null;
		isMobile: boolean;
		wb: GitWorkbenchStore;
		diffFontSize: number;
		onSendToChat?: (message: string) => Promise<boolean>;
		onOpenInEditor?: (relativePath: string, line: number) => void;
	}

	let {
		projectPath = null,
		target = null,
		isMobile,
		wb,
		diffFontSize,
		onSendToChat,
		onOpenInEditor,
	}: GitWorkbenchProps = $props();
	let fallbackTarget = $derived<GitWorkbenchTarget | null>(
		projectPath
			? {
					projectPath,
					repoRoot: projectPath,
					worktreePath: projectPath,
					label: projectPath.split('/').pop() || projectPath,
					source: 'chat-project',
				}
			: null,
	);
	let activeTarget = $derived(target ?? fallbackTarget);
	let activeProjectPath = $derived(activeTarget?.projectPath ?? null);
	let isWorkbenchTargetCurrent = $derived(
		Boolean(
			activeTarget &&
			wb.target?.projectPath === activeTarget.projectPath &&
			wb.target?.worktreePath === activeTarget.worktreePath,
		),
	);
	let showInitialLoading = $derived(
		Boolean(activeTarget) && (!isWorkbenchTargetCurrent || wb.isInitialLoadPending),
	);
	let files = $derived(wb.files);
	let review = $derived(wb.review);
	let selection = $derived(wb.selection);
	let staging = $derived(wb.staging);
	let commit = $derived(wb.commit);
	let drafts = $derived(wb.drafts);
	let porcelain = $derived(wb.porcelain);
	const workspaceShortcuts = getWorkspaceShortcuts();
	const transientLayers = getTransientLayers();

	type SinglePane = 'files' | 'diff';
	const containerBreakpoints = { compactMinWidth: 560, wideMinWidth: 840 } as const;
	let containerWidth = $state(0);
	let singlePane = $state<SinglePane>('files');
	let compactTreeOpen = $state(false);
	const observeWorkbenchWidth = observeContainerWidth((width) => {
		containerWidth = width;
	});
	let containerPresentation = $derived<ContainerPresentation>(
		isMobile ? 'narrow' : containerPresentationForWidth(containerWidth, containerBreakpoints),
	);

	function handleVisibleRowsChange(rows: GitVirtualReviewRow[]): void {
		if (!activeProjectPath) return;
		wb.handleVisibleReviewRows(activeProjectPath, rows);
	}

	function handleSelectFile(path: string): void {
		if (!activeProjectPath) return;
		void wb.selectFile(activeProjectPath, path);
		if (containerPresentation === 'narrow') singlePane = 'diff';
		if (containerPresentation === 'compact') compactTreeOpen = false;
	}

	function handleSelectDirectory(path: string): void {
		if (!activeProjectPath) return;
		const firstFile = files.firstVisibleFileInDirectory(path);
		if (!firstFile) return;
		void wb.selectFile(activeProjectPath, firstFile);
		if (containerPresentation === 'narrow') singlePane = 'diff';
		if (containerPresentation === 'compact') compactTreeOpen = false;
	}

	function handleAddCommentForFile(filePath: string, side: 'before' | 'after', line: number): void {
		if (isMobile) {
			transientLayers.open('main-inert', () => {
				drafts.openCommentComposer(filePath, side, line);
			});
			return;
		}
		drafts.openCommentComposer(filePath, side, line);
	}

	async function handleFinalizeReview(): Promise<void> {
		if (onSendToChat) {
			await drafts.finalizeReviewToAgent(onSendToChat);
		} else {
			const message = drafts.buildFinalizedReviewMessage();
			const copied = await copyToClipboard(message);
			if (copied) {
				drafts.reviewComments = [];
				drafts.reviewSummary = '';
			} else {
				wb.lastError = m.git_review_copy_failed();
			}
		}
		drafts.reviewModalOpen = false;
	}

	function handleInitialCommit(): void {
		if (!activeProjectPath) return;
		commit.createInitialCommit(activeProjectPath);
	}

	function startTreeResize(e: PointerEvent): void {
		const startX = e.clientX;
		const startWidth = files.treePaneWidthPx;
		const target = e.currentTarget as HTMLElement;
		target.setPointerCapture(e.pointerId);

		function onMove(ev: PointerEvent): void {
			files.setTreePaneWidth(startWidth + (ev.clientX - startX));
		}
		function onUp(): void {
			target.removeEventListener('pointermove', onMove);
			target.removeEventListener('pointerup', onUp);
		}
		target.addEventListener('pointermove', onMove);
		target.addEventListener('pointerup', onUp);
	}

	function handleStageFile(filePath: string): void {
		if (!activeProjectPath) return;
		staging.stageFile(activeProjectPath, filePath);
	}

	function handleUnstageFile(filePath: string): void {
		if (!activeProjectPath) return;
		staging.unstageFile(activeProjectPath, filePath);
	}

	function handleStageDir(dirPath: string): void {
		if (!activeProjectPath) return;
		staging.stageDirectory(activeProjectPath, dirPath);
	}

	function handleUnstageDir(dirPath: string): void {
		if (!activeProjectPath) return;
		staging.unstageDirectory(activeProjectPath, dirPath);
	}

	function handleStageHunk(actionTarget: GitDiffActionTarget, hunkIndex: number): void {
		if (!activeProjectPath) return;
		staging.stageHunk(activeProjectPath, actionTarget, hunkIndex);
	}

	function handleUnstageHunk(actionTarget: GitDiffActionTarget, hunkIndex: number): void {
		if (!activeProjectPath) return;
		staging.unstageHunk(activeProjectPath, actionTarget, hunkIndex);
	}

	function handleStageLine(actionTarget: GitDiffActionTarget, diffLineIndex: number): void {
		if (!activeProjectPath) return;
		staging.stageLine(activeProjectPath, actionTarget, diffLineIndex);
	}

	function handleUnstageLine(actionTarget: GitDiffActionTarget, diffLineIndex: number): void {
		if (!activeProjectPath) return;
		staging.unstageLine(activeProjectPath, actionTarget, diffLineIndex);
	}

	function handleDiscardFile(filePath: string): void {
		transientLayers.open('main-inert', () => staging.requestDiscard(filePath));
	}

	function handlePreviousFile(): void {
		if (!activeProjectPath) return;
		void wb.selectPreviousFile(activeProjectPath);
	}

	function handleNextFile(): void {
		if (!activeProjectPath) return;
		void wb.selectNextFile(activeProjectPath);
	}

	function isTextInputTarget(target: EventTarget | null): boolean {
		return (
			target instanceof HTMLElement &&
			Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
		);
	}

	function handleWorkbenchKeydown(event: KeyboardEvent): boolean {
		if (!activeProjectPath || !event.altKey || isTextInputTarget(event.target)) return false;
		if (event.key === 'ArrowUp') {
			event.preventDefault();
			handlePreviousFile();
		} else if (event.key === 'ArrowDown') {
			event.preventDefault();
			handleNextFile();
		} else return false;
		return true;
	}

	$effect(() =>
		workspaceShortcuts.registerSurface(singletonSurfaceId('git'), handleWorkbenchKeydown),
	);

	function inspectorButtonClass(view: GitInspectorView): string {
		return porcelain.inspectorView === view
			? 'text-interactive-accent bg-muted'
			: 'text-muted-foreground hover:text-foreground hover:bg-muted';
	}

	function handleInspectorView(view: Exclude<GitInspectorView, 'none'>): void {
		porcelain.setInspectorView(view);
	}

	let discardConfirmAction = $derived.by((): ConfirmAction | null => {
		if (!staging.pendingDiscardFile) return null;
		const name = staging.pendingDiscardFile.split('/').pop() ?? staging.pendingDiscardFile;
		return {
			type: 'discard',
			file: staging.pendingDiscardFile,
			message: `Are you sure you want to discard changes in "${name}"? This cannot be undone.`,
		};
	});
</script>

{#snippet inspectorButtons()}
	<div class="flex items-center gap-1">
		<button
			type="button"
			onclick={() => handleInspectorView('conflicts')}
			class="rounded p-1 {inspectorButtonClass('conflicts')}"
			title="Conflicts"
			aria-label="Conflicts"
		>
			<AlertTriangle class="h-3.5 w-3.5" />
		</button>
		<button
			type="button"
			onclick={() => handleInspectorView('stash')}
			class="rounded p-1 {inspectorButtonClass('stash')}"
			title="Stash"
			aria-label="Stash"
		>
			<Archive class="h-3.5 w-3.5" />
		</button>
		<button
			type="button"
			onclick={() => handleInspectorView('history')}
			class="rounded p-1 {inspectorButtonClass('history')}"
			title="History and blame"
			aria-label="History and blame"
		>
			<HistoryIcon class="h-3.5 w-3.5" />
		</button>
		<button
			type="button"
			onclick={() => handleInspectorView('graph')}
			class="rounded p-1 {inspectorButtonClass('graph')}"
			title="Graph and compare"
			aria-label="Graph and compare"
		>
			<GitGraph class="h-3.5 w-3.5" />
		</button>
	</div>
{/snippet}

{#snippet fileTree(alwaysShowActions: boolean)}
	<GitFileTree
		tree={files.filteredTree}
		selectedFile={files.selectedFile}
		collapsedDirs={files.collapsedDirs}
		treeSearchQuery={files.treeSearchQuery}
		totalChangedFiles={files.totalChangedFiles}
		visibleChangedFiles={files.visibleChangedFiles}
		hideGenerated={files.hideGenerated}
		hideOtherTabFiles={files.hideOtherTabFiles}
		hideOtherTabFilesLabel={files.hideOtherTabFilesLabel}
		onSelectFile={handleSelectFile}
		onSelectDirectory={handleSelectDirectory}
		onToggleDir={(path) => files.toggleDirCollapsed(path)}
		onSearchChange={(query) => {
			files.treeSearchQuery = query;
		}}
		onHideGeneratedChange={(value) => wb.setHideGenerated(value)}
		onHideOtherTabFilesChange={(value) => wb.setHideOtherTabFiles(value)}
		isStageFilePending={(path) => staging.isFilePending(path, 'stage')}
		isUnstageFilePending={(path) => staging.isFilePending(path, 'unstage')}
		isStageDirPending={(path) => staging.isDirectoryPending(path, 'stage')}
		isUnstageDirPending={(path) => staging.isDirectoryPending(path, 'unstage')}
		onStageFile={handleStageFile}
		onUnstageFile={handleUnstageFile}
		onStageDir={handleStageDir}
		onUnstageDir={handleUnstageDir}
		onDiscardFile={handleDiscardFile}
		{alwaysShowActions}
	/>
{/snippet}

{#snippet diffTabs()}
	<div class="flex min-w-0">
		{#each ['unstaged', 'staged'] as const as tab}
			<button
				type="button"
				onclick={() => wb.setActiveTab(tab)}
				class="min-w-0 px-2 py-1.5 text-xs font-medium transition-colors
				{files.activeTab === tab
					? 'border-b-2 border-interactive-accent text-interactive-accent'
					: 'text-muted-foreground hover:text-foreground'}"
			>
				<span class="truncate">{tab === 'unstaged' ? 'Unstaged' : 'Staged'}</span>
				<span class="ml-1 text-[10px] opacity-70"
					>({tab === 'unstaged' ? files.unstagedFileCount() : files.stagedFileCount()})</span
				>
			</button>
		{/each}
	</div>
{/snippet}

{#snippet diffNavigation()}
	<div class="flex items-center gap-1">
		<button
			type="button"
			onclick={handlePreviousFile}
			disabled={!files.previousVisibleFile() || files.previousVisibleFile() === files.selectedFile}
			class="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
			title="Previous file"
			aria-label="Previous file"
		>
			<ChevronUp class="h-3.5 w-3.5" />
		</button>
		<button
			type="button"
			onclick={handleNextFile}
			disabled={!files.nextVisibleFile() || files.nextVisibleFile() === files.selectedFile}
			class="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
			title="Next file"
			aria-label="Next file"
		>
			<ChevronDown class="h-3.5 w-3.5" />
		</button>
	</div>
{/snippet}

{#snippet diffPane(overscan: number, narrowControls: boolean)}
	{#if narrowControls}
		<div class="shrink-0 border-b border-border">{@render diffTabs()}</div>
		<div class="flex shrink-0 items-center justify-between gap-2 border-b border-border px-2 py-1">
			{@render diffNavigation()}
			{@render inspectorButtons()}
		</div>
	{:else}
		<div class="flex shrink-0 items-center justify-between gap-2 border-b border-border pr-2">
			{@render diffTabs()}
			<div class="flex items-center gap-1">
				{@render diffNavigation()}
				{@render inspectorButtons()}
			</div>
		</div>
	{/if}
	<GitPorcelainPanel
		projectPath={activeProjectPath ?? ''}
		selectedFile={files.selectedFile}
		{porcelain}
	/>
	<GitVirtualDiffSurface
		rows={review.virtualRows}
		fileRowIndex={review.fileRowIndex}
		activeTab={files.activeTab}
		fontSize={diffFontSize}
		selectedLineKeys={selection.selectedLineKeys}
		operationPending={staging.hasPendingOperations || wb.isExternallyStale}
		scrollToRequest={review.scrollRequest}
		composerState={drafts.commentComposer}
		{overscan}
		onVisibleRowsChange={handleVisibleRowsChange}
		onSelectFile={handleSelectFile}
		onToggleLineSelection={(key) => selection.toggleLineSelection(key)}
		onSelectLineRange={(start, end, selectAll) => selection.selectLineRange(start, end, selectAll)}
		onStageHunk={handleStageHunk}
		onUnstageHunk={handleUnstageHunk}
		onStageLine={handleStageLine}
		onUnstageLine={handleUnstageLine}
		onStageFile={handleStageFile}
		onUnstageFile={handleUnstageFile}
		onAddCommentForFile={handleAddCommentForFile}
		onEditComment={(id, patch) => drafts.updateDraftComment(id, patch)}
		onRemoveComment={(id) => drafts.removeDraftComment(id)}
		onComposerBodyChange={(body) => {
			drafts.commentComposer = { ...drafts.commentComposer, body };
		}}
		onComposerSeverityChange={(severity) => {
			drafts.commentComposer = { ...drafts.commentComposer, severity };
		}}
		onComposerSubmit={() => drafts.commitCommentComposer()}
		onComposerClose={() => drafts.closeCommentComposer()}
		{onOpenInEditor}
	/>
	{#if selection.hasSelection}
		<div class="flex shrink-0 gap-2 border-t border-border bg-background px-3 py-2">
			{#if files.activeTab === 'unstaged'}
				<button
					type="button"
					onclick={() => {
						if (activeProjectPath) staging.stageSelectedLines(activeProjectPath);
					}}
					disabled={staging.hasPendingOperations || wb.isExternallyStale}
					class="flex-1 rounded bg-git-added/20 px-2 py-1.5 text-xs text-git-added transition-colors hover:bg-git-added/30 disabled:opacity-50"
				>
					<Plus class="mr-1 inline h-3.5 w-3.5" />
					Stage ({selection.selectedLineKeys.size})
				</button>
			{:else}
				<button
					type="button"
					onclick={() => {
						if (activeProjectPath) staging.unstageSelectedLines(activeProjectPath);
					}}
					disabled={staging.hasPendingOperations || wb.isExternallyStale}
					class="flex-1 rounded bg-git-deleted/20 px-2 py-1.5 text-xs text-git-deleted transition-colors hover:bg-git-deleted/30 disabled:opacity-50"
				>
					<Minus class="mr-1 inline h-3.5 w-3.5" />
					Unstage ({selection.selectedLineKeys.size})
				</button>
			{/if}
			<button
				type="button"
				onclick={() => selection.clearSelection()}
				class="rounded bg-muted px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
			>
				Clear
			</button>
		</div>
	{/if}
{/snippet}

{#if !activeProjectPath}
	<div class="h-full flex items-center justify-center text-muted-foreground">
		<p class="text-sm">Select a project to view changes</p>
	</div>
{:else}
	<div
		class="flex h-full min-w-0 flex-col"
		data-git-workbench
		data-git-layout={containerPresentation}
		{@attach observeWorkbenchWidth}
	>
		{#if wb.lastError}
			<div
				class="px-3 py-1.5 border-b border-status-error-border bg-status-error/10 flex items-center gap-2"
			>
				<AlertTriangle class="w-3.5 h-3.5 text-status-error-foreground shrink-0" />
				<span class="text-xs text-status-error-foreground flex-1 truncate">{wb.lastError}</span>
				<button
					onclick={() => wb.dismissError()}
					class="p-0.5 rounded hover:bg-muted transition-colors"
				>
					<X class="w-3 h-3 text-status-error-foreground" />
				</button>
			</div>
		{/if}

		{#if wb.repositoryError}
			<div
				class="flex-1 flex flex-col items-center justify-center text-muted-foreground px-6 py-12"
			>
				<GitBranchIcon class="w-20 h-20 mb-6 opacity-30" />
				<h3 class="text-xl font-medium mb-3 text-center">{wb.repositoryError}</h3>
				<div class="p-4 bg-status-info rounded-lg border border-status-info-border max-w-md">
					<p class="text-sm text-status-info-foreground text-center">
						<strong>{m.git_panel_tip()}</strong>
						{m.git_panel_init_repo()}
					</p>
				</div>
			</div>
		{:else if showInitialLoading}
			<div
				class="flex-1 flex flex-col items-center justify-center gap-3 px-6 py-12 text-muted-foreground"
			>
				<LoaderCircle class="h-6 w-6 animate-spin text-interactive-accent" />
				<p class="text-sm">Loading Git changes...</p>
			</div>
		{:else}
			{#if !files.hasCommits}
				<div class="px-3 py-2 border-b border-border bg-status-info/10">
					<div class="text-xs text-status-info-foreground mb-1.5">
						No commits yet. Create an initial commit to get started.
					</div>
					<button
						onclick={handleInitialCommit}
						disabled={commit.isCreatingInitialCommit}
						class="px-3 py-1 text-xs rounded bg-interactive-accent text-interactive-accent-foreground hover:brightness-110 disabled:opacity-50 transition-all"
					>
						{#if commit.isCreatingInitialCommit}
							<LoaderCircle class="w-3 h-3 inline animate-spin mr-1" />
						{/if}
						Create initial commit
					</button>
				</div>
			{/if}

			{#if containerPresentation === 'narrow'}
				<div class="flex shrink-0 border-b border-border" data-git-segmented-navigation>
					{#each ['files', 'diff'] as const as pane}
						<button
							type="button"
							onclick={() => {
								singlePane = pane;
							}}
							class="flex-1 px-3 py-1.5 text-xs font-medium transition-colors
							{singlePane === pane
								? 'border-b-2 border-interactive-accent text-interactive-accent'
								: 'text-muted-foreground hover:text-foreground'}"
						>
							{pane === 'files' ? 'Files' : 'Diff'}
						</button>
					{/each}
				</div>
			{/if}
			<div
				class={cn(
					'relative min-h-0 flex-1 overflow-hidden',
					containerPresentation === 'wide' ? 'grid' : 'flex',
				)}
				style={containerPresentation === 'wide'
					? `grid-template-columns: ${files.treePaneWidthPx}px 6px minmax(0,1fr); grid-template-rows: minmax(0,1fr);`
					: undefined}
				data-git-compact-layout={containerPresentation === 'compact' ? '' : undefined}
				data-git-wide-layout={containerPresentation === 'wide' ? '' : undefined}
			>
				{#if containerPresentation === 'compact' && compactTreeOpen}
					<button
						type="button"
						class="absolute inset-0 z-10 cursor-default rounded-none bg-background/60"
						aria-label="Close changed files"
						onclick={() => (compactTreeOpen = false)}
					></button>
				{/if}
				<div
					class={cn(
						'flex min-h-0 flex-col overflow-hidden bg-background',
						containerPresentation === 'wide' && 'border-r border-border',
						containerPresentation === 'compact' &&
							(compactTreeOpen
								? 'absolute inset-y-0 left-0 z-20 max-w-[85%] border-r border-border shadow-lg'
								: 'hidden'),
						containerPresentation === 'narrow' && 'absolute inset-0',
						containerPresentation === 'narrow' &&
							singlePane !== 'files' &&
							'invisible pointer-events-none',
					)}
					style={containerPresentation === 'compact' && compactTreeOpen
						? 'width: min(20rem, 85%);'
						: undefined}
					aria-label={containerPresentation === 'compact' ? 'Changed files' : undefined}
					role={containerPresentation === 'compact' ? 'complementary' : undefined}
					aria-hidden={containerPresentation === 'narrow' && singlePane !== 'files'}
					inert={containerPresentation === 'narrow' && singlePane !== 'files'}
					data-git-files-pane
				>
					{#if containerPresentation === 'compact'}
						<div
							class="flex shrink-0 items-center justify-between border-b border-border px-3 py-1.5"
						>
							<span class="text-xs font-medium text-foreground">Changed files</span>
							<button
								type="button"
								class="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
								aria-label="Close changed files"
								onclick={() => (compactTreeOpen = false)}
							>
								<X class="h-3.5 w-3.5" />
							</button>
						</div>
					{/if}
					<div class="min-h-0 flex-1 overflow-hidden">
						{@render fileTree(containerPresentation !== 'wide')}
					</div>
				</div>
				{#if containerPresentation === 'wide'}
					<button
						type="button"
						aria-label={m.git_resize_file_tree()}
						data-git-tree-resizer
						class="m-0 cursor-col-resize rounded-none border-none bg-border/60 p-0 transition-colors hover:bg-interactive-accent/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
						onpointerdown={startTreeResize}
						onkeydown={(event) => {
							if (event.key === 'ArrowLeft') {
								event.preventDefault();
								files.setTreePaneWidth(files.treePaneWidthPx - 16);
							}
							if (event.key === 'ArrowRight') {
								event.preventDefault();
								files.setTreePaneWidth(files.treePaneWidthPx + 16);
							}
						}}
					></button>
				{/if}
				<div
					class={cn(
						'flex min-h-0 min-w-0 flex-col overflow-hidden',
						containerPresentation === 'narrow' && 'absolute inset-0',
						containerPresentation === 'narrow' &&
							singlePane !== 'diff' &&
							'invisible pointer-events-none',
						containerPresentation !== 'wide' && 'flex-1',
					)}
					aria-hidden={containerPresentation === 'narrow' && singlePane !== 'diff'}
					inert={containerPresentation === 'narrow' && singlePane !== 'diff'}
					data-git-diff-pane
				>
					{#if containerPresentation === 'compact'}
						<div class="shrink-0 border-b border-border px-2 py-1">
							<button
								type="button"
								class="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
								onclick={() => (compactTreeOpen = !compactTreeOpen)}
								aria-expanded={compactTreeOpen}
								aria-label={compactTreeOpen ? 'Hide changed files' : 'Show changed files'}
							>
								<PanelLeft class="h-3.5 w-3.5" />
								Files
							</button>
						</div>
					{/if}
					{@render diffPane(
						containerPresentation === 'wide' ? 5 : containerPresentation === 'compact' ? 4 : 3,
						containerPresentation === 'narrow',
					)}
				</div>
			</div>
		{/if}
	</div>

	{#if drafts.reviewModalOpen}
		<GitReviewChangesModal
			commentsByFile={drafts.commentsByFile}
			commentCount={drafts.reviewComments.length}
			reviewSummary={drafts.reviewSummary}
			{isMobile}
			onSummaryChange={(s) => {
				drafts.reviewSummary = s;
			}}
			onUpdateComment={(id, patch) => drafts.updateDraftComment(id, patch)}
			onRemoveComment={(id) => drafts.removeDraftComment(id)}
			onSend={handleFinalizeReview}
			onClose={() => {
				drafts.reviewModalOpen = false;
			}}
		/>
	{/if}

	{#if drafts.commentComposer.open && isMobile}
		<GitCommentModal
			composer={drafts.commentComposer}
			onBodyChange={(b) => {
				drafts.commentComposer = { ...drafts.commentComposer, body: b };
			}}
			onSeverityChange={(s) => {
				drafts.commentComposer = { ...drafts.commentComposer, severity: s };
			}}
			onSubmit={() => drafts.commitCommentComposer()}
			onClose={() => drafts.closeCommentComposer()}
		/>
	{/if}

	{#if discardConfirmAction}
		<GitConfirmModal
			confirmAction={discardConfirmAction}
			onConfirm={() => {
				if (activeProjectPath) staging.confirmDiscard(activeProjectPath);
			}}
			onCancel={() => staging.cancelDiscard()}
		/>
	{/if}
{/if}
