<script lang="ts">
	// Main workbench shell for Git. Provides a two-pane layout on
	// desktop (file tree + diff) and a segmented single-pane on mobile.
	// Review drafts open in a modal; comments use a popover (desktop)
	// or modal (mobile). All state lives in GitWorkbenchStore.

	import { untrack } from 'svelte';
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
	} from '$lib/stores/git-workbench.svelte.js';
	import type { GitInspectorView } from '$lib/stores/git/git-porcelain.svelte';
	import type { ConfirmAction } from '$lib/api/git.js';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import * as m from '$lib/paraglide/messages.js';

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

	// Mobile pane navigation (files or diff only -- review is now a modal)
	type MobilePane = 'files' | 'diff';
	let mobilePane = $state<MobilePane>('files');

	$effect(() => {
		const nextTarget = activeTarget;
		untrack(() => void wb.setTarget(nextTarget));
	});

	function handleVisibleRowsChange(rows: GitVirtualReviewRow[]): void {
		if (!activeProjectPath) return;
		wb.handleVisibleReviewRows(activeProjectPath, rows);
	}

	function handleSelectFile(path: string): void {
		if (!activeProjectPath) return;
		void wb.selectFile(activeProjectPath, path);
		if (isMobile) mobilePane = 'diff';
	}

	function handleSelectDirectory(path: string): void {
		if (!activeProjectPath) return;
		const firstFile = wb.firstVisibleFileInDirectory(path);
		if (!firstFile) return;
		void wb.selectFile(activeProjectPath, firstFile);
		if (isMobile) mobilePane = 'diff';
	}

	function handleAddCommentForFile(filePath: string, side: 'before' | 'after', line: number): void {
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
				wb.lastError = 'Failed to copy review to clipboard';
			}
		}
		drafts.reviewModalOpen = false;
	}

	function handleInitialCommit(): void {
		if (!activeProjectPath) return;
		wb.createInitialCommit(activeProjectPath);
	}

	// Pointer-based tree pane resize
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
		staging.requestDiscard(filePath);
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

	function handleWorkbenchKeydown(event: KeyboardEvent): void {
		if (!activeProjectPath || !event.altKey || isTextInputTarget(event.target)) return;
		if (event.key === 'ArrowUp') {
			event.preventDefault();
			handlePreviousFile();
		} else if (event.key === 'ArrowDown') {
			event.preventDefault();
			handleNextFile();
		}
	}

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

<svelte:window onkeydown={handleWorkbenchKeydown} />

{#if !activeProjectPath}
	<div class="h-full flex items-center justify-center text-muted-foreground">
		<p class="text-sm">Select a project to view changes</p>
	</div>
{:else}
	<div class="h-full flex flex-col">
		<!-- Error banner -->
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
			<!-- Initial commit prompt -->
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

			<!-- Main content area -->
			{#if isMobile}
				<!-- Mobile: segmented nav (files + diff only) -->
				<div class="flex border-b border-border">
					{#each ['files', 'diff'] as const as pane}
						<button
							onclick={() => {
								mobilePane = pane;
							}}
							class="flex-1 px-3 py-1.5 text-xs font-medium transition-colors
							{mobilePane === pane
								? 'text-interactive-accent border-b-2 border-interactive-accent'
								: 'text-muted-foreground hover:text-foreground'}"
						>
							{pane === 'files' ? 'Files' : 'Diff'}
						</button>
					{/each}
				</div>

				<div class="flex-1 overflow-hidden flex flex-col">
					{#if mobilePane === 'files'}
						<GitFileTree
							tree={wb.filteredTree}
							selectedFile={wb.selectedFile}
							collapsedDirs={files.collapsedDirs}
							treeSearchQuery={files.treeSearchQuery}
							totalChangedFiles={files.totalChangedFiles}
							visibleChangedFiles={wb.visibleChangedFiles}
							hideGenerated={wb.hideGenerated}
							hideOtherTabFiles={wb.hideOtherTabFiles}
							hideOtherTabFilesLabel={wb.hideOtherTabFilesLabel}
							onSelectFile={handleSelectFile}
							onSelectDirectory={handleSelectDirectory}
							onToggleDir={(p) => files.toggleDirCollapsed(p)}
							onSearchChange={(q) => {
								files.treeSearchQuery = q;
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
							alwaysShowActions
						/>
					{:else}
						<!-- Mobile diff tab bar (Unstaged / Staged) -->
						<div class="flex border-b border-border shrink-0">
							{#each ['unstaged', 'staged'] as const as tab}
								<button
									onclick={() => wb.setActiveTab(tab)}
									class="flex-1 px-2 py-1 text-[11px] font-medium transition-colors
									{wb.activeTab === tab
										? 'text-interactive-accent border-b-2 border-interactive-accent'
										: 'text-muted-foreground hover:text-foreground'}"
								>
									{tab === 'unstaged' ? 'Unstaged' : 'Staged'}
									<span class="ml-1 text-[10px] opacity-70"
										>({tab === 'unstaged'
											? files.unstagedFileCount()
											: files.stagedFileCount()})</span
									>
								</button>
							{/each}
						</div>
						<div class="flex items-center justify-between gap-2 border-b border-border px-2 py-1">
							<div class="flex items-center gap-1">
								<button
									type="button"
									onclick={handlePreviousFile}
									disabled={!wb.previousVisibleFile() ||
										wb.previousVisibleFile() === wb.selectedFile}
									class="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40"
									title="Previous file"
									aria-label="Previous file"
								>
									<ChevronUp class="w-3.5 h-3.5" />
								</button>
								<button
									type="button"
									onclick={handleNextFile}
									disabled={!wb.nextVisibleFile() || wb.nextVisibleFile() === wb.selectedFile}
									class="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40"
									title="Next file"
									aria-label="Next file"
								>
									<ChevronDown class="w-3.5 h-3.5" />
								</button>
							</div>
							{@render inspectorButtons()}
						</div>
						<GitPorcelainPanel
							projectPath={activeProjectPath}
							selectedFile={wb.selectedFile}
							{porcelain}
						/>
						<GitVirtualDiffSurface
							rows={review.virtualRows}
							fileRowIndex={review.fileRowIndex}
							activeTab={wb.activeTab}
							fontSize={diffFontSize}
							selectedLineKeys={selection.selectedLineKeys}
							operationPending={staging.hasPendingOperations || wb.isExternallyStale}
							scrollToRequest={review.scrollRequest}
							composerState={drafts.commentComposer}
							overscan={3}
							onVisibleRowsChange={handleVisibleRowsChange}
							onSelectFile={handleSelectFile}
							onToggleLineSelection={(k) => selection.toggleLineSelection(k)}
							onSelectLineRange={(s, e, all) => selection.selectLineRange(s, e, all)}
							onStageHunk={handleStageHunk}
							onUnstageHunk={handleUnstageHunk}
							onStageLine={handleStageLine}
							onUnstageLine={handleUnstageLine}
							onStageFile={handleStageFile}
							onUnstageFile={handleUnstageFile}
							onAddCommentForFile={handleAddCommentForFile}
							onEditComment={(id, patch) => drafts.updateDraftComment(id, patch)}
							onRemoveComment={(id) => drafts.removeDraftComment(id)}
							onComposerBodyChange={(b) => {
								drafts.commentComposer = { ...drafts.commentComposer, body: b };
							}}
							onComposerSeverityChange={(s) => {
								drafts.commentComposer = { ...drafts.commentComposer, severity: s };
							}}
							onComposerSubmit={() => drafts.commitCommentComposer()}
							onComposerClose={() => drafts.closeCommentComposer()}
							{onOpenInEditor}
						/>
					{/if}
				</div>

				<!-- Mobile sticky bottom action bar -->
				{#if selection.hasSelection && mobilePane === 'diff'}
					<div class="flex gap-2 px-3 py-2 border-t border-border bg-background">
						{#if wb.activeTab === 'unstaged'}
							<button
								onclick={() => {
									if (activeProjectPath) staging.stageSelectedLines(activeProjectPath);
								}}
								disabled={staging.hasPendingOperations || wb.isExternallyStale}
								class="flex-1 px-2 py-1.5 text-xs rounded bg-git-added/20 text-git-added disabled:opacity-50"
							>
								Stage ({selection.selectedLineKeys.size})
							</button>
						{:else}
							<button
								onclick={() => {
									if (activeProjectPath) staging.unstageSelectedLines(activeProjectPath);
								}}
								disabled={staging.hasPendingOperations || wb.isExternallyStale}
								class="flex-1 px-2 py-1.5 text-xs rounded bg-git-deleted/20 text-git-deleted disabled:opacity-50"
							>
								Unstage ({selection.selectedLineKeys.size})
							</button>
						{/if}
						<button
							onclick={() => selection.clearSelection()}
							class="px-2 py-1.5 text-xs rounded bg-muted text-muted-foreground"
						>
							Clear
						</button>
					</div>
				{/if}
			{:else}
				<!-- Desktop: two-pane layout (tree + separator + diff) -->
				<div
					class="flex-1 grid overflow-hidden"
					style="grid-template-columns: {files.treePaneWidthPx}px 6px minmax(0,1fr); grid-template-rows: minmax(0,1fr);"
				>
					<div class="min-h-0 overflow-hidden border-r border-border">
						<GitFileTree
							tree={wb.filteredTree}
							selectedFile={wb.selectedFile}
							collapsedDirs={files.collapsedDirs}
							treeSearchQuery={files.treeSearchQuery}
							totalChangedFiles={files.totalChangedFiles}
							visibleChangedFiles={wb.visibleChangedFiles}
							hideGenerated={wb.hideGenerated}
							hideOtherTabFiles={wb.hideOtherTabFiles}
							hideOtherTabFilesLabel={wb.hideOtherTabFilesLabel}
							onSelectFile={handleSelectFile}
							onSelectDirectory={handleSelectDirectory}
							onToggleDir={(p) => files.toggleDirCollapsed(p)}
							onSearchChange={(q) => {
								files.treeSearchQuery = q;
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
						/>
					</div>
					<button
						type="button"
						aria-label={m.git_resize_file_tree()}
						class="cursor-col-resize bg-border/60 hover:bg-interactive-accent/40 transition-colors border-none p-0 m-0 rounded-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
						onpointerdown={startTreeResize}
						onkeydown={(e) => {
							if (e.key === 'ArrowLeft') files.setTreePaneWidth(files.treePaneWidthPx - 16);
							if (e.key === 'ArrowRight') files.setTreePaneWidth(files.treePaneWidthPx + 16);
						}}
					></button>
					<div class="flex flex-col min-h-0 overflow-hidden">
						<!-- Desktop diff tab bar (Unstaged / Staged) -->
						<div
							class="flex items-center justify-between gap-2 border-b border-border shrink-0 pr-2"
						>
							<div class="flex">
								{#each ['unstaged', 'staged'] as const as tab}
									<button
										onclick={() => wb.setActiveTab(tab)}
										class="px-3 py-1.5 text-xs font-medium transition-colors
										{wb.activeTab === tab
											? 'text-interactive-accent border-b-2 border-interactive-accent'
											: 'text-muted-foreground hover:text-foreground'}"
									>
										{tab === 'unstaged' ? 'Unstaged' : 'Staged'}
										<span class="ml-1 text-[10px] opacity-70"
											>({tab === 'unstaged'
												? files.unstagedFileCount()
												: files.stagedFileCount()})</span
										>
									</button>
								{/each}
							</div>
							<div class="flex items-center gap-1">
								<button
									type="button"
									onclick={handlePreviousFile}
									disabled={!wb.previousVisibleFile() ||
										wb.previousVisibleFile() === wb.selectedFile}
									class="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40"
									title="Previous file"
									aria-label="Previous file"
								>
									<ChevronUp class="w-3.5 h-3.5" />
								</button>
								<button
									type="button"
									onclick={handleNextFile}
									disabled={!wb.nextVisibleFile() || wb.nextVisibleFile() === wb.selectedFile}
									class="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40"
									title="Next file"
									aria-label="Next file"
								>
									<ChevronDown class="w-3.5 h-3.5" />
								</button>
							</div>
							{@render inspectorButtons()}
						</div>
						<GitPorcelainPanel
							projectPath={activeProjectPath}
							selectedFile={wb.selectedFile}
							{porcelain}
						/>
						<GitVirtualDiffSurface
							rows={review.virtualRows}
							fileRowIndex={review.fileRowIndex}
							activeTab={wb.activeTab}
							fontSize={diffFontSize}
							selectedLineKeys={selection.selectedLineKeys}
							operationPending={staging.hasPendingOperations || wb.isExternallyStale}
							scrollToRequest={review.scrollRequest}
							composerState={drafts.commentComposer}
							overscan={5}
							onVisibleRowsChange={handleVisibleRowsChange}
							onSelectFile={handleSelectFile}
							onToggleLineSelection={(k) => selection.toggleLineSelection(k)}
							onSelectLineRange={(s, e, all) => selection.selectLineRange(s, e, all)}
							onStageHunk={handleStageHunk}
							onUnstageHunk={handleUnstageHunk}
							onStageLine={handleStageLine}
							onUnstageLine={handleUnstageLine}
							onStageFile={handleStageFile}
							onUnstageFile={handleUnstageFile}
							onAddCommentForFile={handleAddCommentForFile}
							onEditComment={(id, patch) => drafts.updateDraftComment(id, patch)}
							onRemoveComment={(id) => drafts.removeDraftComment(id)}
							onComposerBodyChange={(b) => {
								drafts.commentComposer = { ...drafts.commentComposer, body: b };
							}}
							onComposerSeverityChange={(s) => {
								drafts.commentComposer = { ...drafts.commentComposer, severity: s };
							}}
							onComposerSubmit={() => drafts.commitCommentComposer()}
							onComposerClose={() => drafts.closeCommentComposer()}
							{onOpenInEditor}
						/>
						{#if selection.hasSelection}
							<div
								class="flex items-center gap-2 px-3 py-2 border-t border-border bg-background shrink-0"
							>
								{#if wb.activeTab === 'unstaged'}
									<button
										onclick={() => {
											if (activeProjectPath) staging.stageSelectedLines(activeProjectPath);
										}}
										disabled={staging.hasPendingOperations || wb.isExternallyStale}
										class="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-git-added/20 text-git-added hover:bg-git-added/30 transition-colors disabled:opacity-50"
									>
										<Plus class="w-4 h-4" />
										Stage {selection.selectedLineKeys.size}
										{selection.selectedLineKeys.size === 1 ? 'line' : 'lines'}
									</button>
								{:else}
									<button
										onclick={() => {
											if (activeProjectPath) staging.unstageSelectedLines(activeProjectPath);
										}}
										disabled={staging.hasPendingOperations || wb.isExternallyStale}
										class="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-git-deleted/20 text-git-deleted hover:bg-git-deleted/30 transition-colors disabled:opacity-50"
									>
										<Minus class="w-4 h-4" />
										Unstage {selection.selectedLineKeys.size}
										{selection.selectedLineKeys.size === 1 ? 'line' : 'lines'}
									</button>
								{/if}
								<button
									onclick={() => selection.clearSelection()}
									class="px-3 py-1.5 text-sm rounded-lg bg-muted text-muted-foreground hover:text-foreground transition-colors"
								>
									Clear
								</button>
							</div>
						{/if}
					</div>
				</div>
			{/if}
		{/if}
	</div>

	<!-- Review changes modal -->
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

	<!-- Comment composer: mobile uses full-screen modal; desktop uses inline composer -->
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

	<!-- Discard file confirmation -->
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
