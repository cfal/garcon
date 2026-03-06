<script lang="ts">
	// Main workbench shell for Git V2. Provides a two-pane layout on
	// desktop (file tree + diff) and a segmented single-pane on mobile.
	// Review drafts open in a modal; comments use a popover (desktop)
	// or modal (mobile). All state lives in GitWorkbenchStore.

	import { untrack } from 'svelte';
	import AlertTriangle from '@lucide/svelte/icons/triangle-alert';
	import Plus from '@lucide/svelte/icons/plus';
	import Minus from '@lucide/svelte/icons/minus';
	import X from '@lucide/svelte/icons/x';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import GitFileTree from './GitFileTree.svelte';
	import GitAllFilesVirtualList from './GitAllFilesVirtualList.svelte';
	import GitReviewChangesModal from './GitReviewChangesModal.svelte';
	import GitCommentModal from './GitCommentModal.svelte';
	import { GitWorkbenchStore } from '$lib/stores/git-workbench.svelte.js';
	import type { GitFileReviewData } from '$lib/api/git.js';
	import { copyToClipboard } from '$lib/utils/clipboard';

	interface GitWorkbenchProps {
		projectPath: string | null;
		isMobile: boolean;
		wb: GitWorkbenchStore;
		diffFontSize: number;
		onSendToChat?: (message: string) => Promise<boolean>;
		onOpenInEditor?: (relativePath: string, line: number) => void;
	}

	let { projectPath, isMobile, wb, diffFontSize, onSendToChat, onOpenInEditor }: GitWorkbenchProps = $props();

	// Mobile pane navigation (files or diff only -- review is now a modal)
	type MobilePane = 'files' | 'diff';
	let mobilePane = $state<MobilePane>('files');

	let allScopeReviewItems = $derived.by((): Array<{ filePath: string; reviewData: GitFileReviewData | null }> => {
		const paths = wb.visibleFilePaths;
		return paths.map((filePath) => ({ filePath, reviewData: wb.reviewDataByPath[filePath] ?? null }));
	});

	// Reload tree when project changes. Auto-select the first file.
	// Diff loading is viewport-driven: the virtual list requests data
	// for visible files via onRequestLoad.
	$effect(() => {
		wb.reset();
		if (!projectPath) return;
		const pp = projectPath;
		untrack(() => void wb.loadTree(pp).then(() => {
			const first = wb.visibleFilePaths[0];
			if (first && !wb.selectedFile) wb.openFile(pp, first);
		}));
	});

	function handleRequestLoad(filePaths: string[]): void {
		if (!projectPath) return;
		wb.requestFilesLoaded(projectPath, filePaths);
	}

	function handleSelectFile(path: string): void {
		if (!projectPath) return;
		wb.openFile(projectPath, path);
		wb.requestDiffScrollToFile(path);
		if (isMobile) mobilePane = 'diff';
	}

	function handleSelectDirectory(path: string): void {
		if (!projectPath) return;
		const firstFile = wb.firstVisibleFileInDirectory(path);
		if (!firstFile) return;
		wb.openFile(projectPath, firstFile);
		wb.requestDiffScrollToFile(firstFile);
		if (isMobile) mobilePane = 'diff';
	}

	function handleAddCommentForFile(filePath: string, side: 'before' | 'after', line: number): void {
		wb.openCommentComposer(filePath, side, line);
	}

	async function handleFinalizeReview(): Promise<void> {
		if (onSendToChat) {
			await wb.finalizeReviewToAgent(onSendToChat);
		} else {
			const message = wb.buildFinalizedReviewMessage();
			const copied = await copyToClipboard(message);
			if (copied) {
				wb.reviewComments = [];
				wb.reviewSummary = '';
			} else {
				wb.lastError = 'Failed to copy review to clipboard';
			}
		}
		wb.reviewModalOpen = false;
	}

	function handleInitialCommit(): void {
		if (!projectPath) return;
		wb.createInitialCommit(projectPath);
	}

	// Pointer-based tree pane resize
	function startTreeResize(e: PointerEvent): void {
		const startX = e.clientX;
		const startWidth = wb.treePaneWidthPx;
		const target = e.currentTarget as HTMLElement;
		target.setPointerCapture(e.pointerId);

		function onMove(ev: PointerEvent): void {
			wb.setTreePaneWidth(startWidth + (ev.clientX - startX));
		}
		function onUp(): void {
			target.removeEventListener('pointermove', onMove);
			target.removeEventListener('pointerup', onUp);
		}
		target.addEventListener('pointermove', onMove);
		target.addEventListener('pointerup', onUp);
	}

	function handleStageFile(filePath: string): void {
		if (!projectPath) return;
		wb.stageFile(projectPath, filePath);
	}

	function handleUnstageFile(filePath: string): void {
		if (!projectPath) return;
		wb.unstageFile(projectPath, filePath);
	}

	function handleStageDir(dirPath: string): void {
		if (!projectPath) return;
		wb.stageDirectory(projectPath, dirPath);
	}

	function handleUnstageDir(dirPath: string): void {
		if (!projectPath) return;
		wb.unstageDirectory(projectPath, dirPath);
	}
</script>

{#if !projectPath}
	<div class="h-full flex items-center justify-center text-muted-foreground">
		<p class="text-sm">Select a project to view changes</p>
	</div>
{:else}
	<div class="h-full flex flex-col">
		<!-- Error banner -->
		{#if wb.lastError}
			<div class="px-3 py-1.5 border-b border-status-error-border bg-status-error/10 flex items-center gap-2">
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

		<!-- Initial commit prompt -->
		{#if !wb.hasCommits}
			<div class="px-3 py-2 border-b border-border bg-status-info/10">
				<div class="text-xs text-status-info-foreground mb-1.5">No commits yet. Create an initial commit to get started.</div>
				<button
					onclick={handleInitialCommit}
					disabled={wb.isCreatingInitialCommit}
					class="px-3 py-1 text-xs rounded bg-interactive-accent text-interactive-accent-foreground hover:brightness-110 disabled:opacity-50 transition-all"
				>
					{#if wb.isCreatingInitialCommit}
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
				{#each (['files', 'diff'] as const) as pane}
					<button
						onclick={() => { mobilePane = pane; }}
						class="flex-1 px-3 py-1.5 text-xs font-medium transition-colors
							{mobilePane === pane ? 'text-interactive-accent border-b-2 border-interactive-accent' : 'text-muted-foreground hover:text-foreground'}"
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
						collapsedDirs={wb.collapsedDirs}
						treeSearchQuery={wb.treeSearchQuery}
						totalChangedFiles={wb.totalChangedFiles}
						onSelectFile={handleSelectFile}
						onSelectDirectory={handleSelectDirectory}
						onToggleDir={(p) => wb.toggleDirCollapsed(p)}
						onSearchChange={(q) => { wb.treeSearchQuery = q; }}
						onStageFile={handleStageFile}
						onUnstageFile={handleUnstageFile}
						onStageDir={handleStageDir}
						onUnstageDir={handleUnstageDir}
						alwaysShowActions
					/>
				{:else}
					<!-- Mobile diff tab bar (Unstaged / Staged) -->
					<div class="flex border-b border-border shrink-0">
						{#each (['unstaged', 'staged'] as const) as tab}
							<button
								onclick={() => wb.setActiveTab(tab)}
								class="flex-1 px-2 py-1 text-[11px] font-medium transition-colors
									{wb.activeTab === tab ? 'text-interactive-accent border-b-2 border-interactive-accent' : 'text-muted-foreground hover:text-foreground'}"
							>
								{tab === 'unstaged' ? 'Unstaged' : 'Staged'}
								<span class="ml-1 text-[10px] opacity-70">({tab === 'unstaged' ? wb.unstagedFileCount : wb.stagedFileCount})</span>
							</button>
						{/each}
					</div>
					<GitAllFilesVirtualList
						items={allScopeReviewItems}
						activeTab={wb.activeTab}
						diffMode={wb.diffMode}
						fontSize={diffFontSize}
						selectedLineKeys={wb.selectedLineKeys}
						overscan={3}
						onRequestLoad={handleRequestLoad}
						onToggleLineSelection={(k) => wb.toggleLineSelection(k)}
						onSelectLineRange={(s, e, all) => wb.selectLineRange(s, e, all)}
						onStageHunk={(i) => wb.stageHunk(projectPath, i)}
						onUnstageHunk={(i) => wb.unstageHunk(projectPath, i)}
						onStageLine={(i) => wb.stageLine(projectPath, i)}
						onUnstageLine={(i) => wb.unstageLine(projectPath, i)}
						onAddCommentForFile={handleAddCommentForFile}
						commentsForFile={(fp) => wb.commentsForFile(fp)}
						onEditComment={(id, patch) => wb.updateDraftComment(id, patch)}
						onRemoveComment={(id) => wb.removeDraftComment(id)}
						scrollToRequest={wb.diffScrollRequest}
						{onOpenInEditor}
					/>
				{/if}
			</div>

			<!-- Mobile sticky bottom action bar -->
			{#if wb.hasSelection && mobilePane === 'diff'}
				<div class="flex gap-2 px-3 py-2 border-t border-border bg-background">
					{#if wb.activeTab === 'unstaged'}
						<button
							onclick={() => wb.stageSelectedLines(projectPath)}
							class="flex-1 px-2 py-1.5 text-xs rounded bg-git-added/20 text-git-added"
						>
							Stage ({wb.selectedLineKeys.size})
						</button>
					{:else}
						<button
							onclick={() => wb.unstageSelectedLines(projectPath)}
							class="flex-1 px-2 py-1.5 text-xs rounded bg-git-deleted/20 text-git-deleted"
						>
							Unstage ({wb.selectedLineKeys.size})
						</button>
					{/if}
					<button
						onclick={() => wb.clearSelection()}
						class="px-2 py-1.5 text-xs rounded bg-muted text-muted-foreground"
					>
						Clear
					</button>
				</div>
			{/if}
		{:else}
			<!-- Desktop: two-pane layout (tree + separator + diff) -->
			<div class="flex-1 grid overflow-hidden" style="grid-template-columns: {wb.treePaneWidthPx}px 6px minmax(0,1fr); grid-template-rows: minmax(0,1fr);">
				<div class="min-h-0 overflow-hidden border-r border-border">
						<GitFileTree
							tree={wb.filteredTree}
							selectedFile={wb.selectedFile}
							collapsedDirs={wb.collapsedDirs}
							treeSearchQuery={wb.treeSearchQuery}
							totalChangedFiles={wb.totalChangedFiles}
							onSelectFile={handleSelectFile}
							onSelectDirectory={handleSelectDirectory}
							onToggleDir={(p) => wb.toggleDirCollapsed(p)}
							onSearchChange={(q) => { wb.treeSearchQuery = q; }}
							onStageFile={handleStageFile}
							onUnstageFile={handleUnstageFile}
							onStageDir={handleStageDir}
							onUnstageDir={handleUnstageDir}
						/>
				</div>
				<button
					type="button"
					aria-label="Resize file tree"
					class="cursor-col-resize bg-border/60 hover:bg-interactive-accent/40 transition-colors border-none p-0 m-0 rounded-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
					onpointerdown={startTreeResize}
					onkeydown={(e) => {
						if (e.key === 'ArrowLeft') wb.setTreePaneWidth(wb.treePaneWidthPx - 16);
						if (e.key === 'ArrowRight') wb.setTreePaneWidth(wb.treePaneWidthPx + 16);
					}}
				></button>
				<div class="flex flex-col min-h-0 overflow-hidden">
					<!-- Desktop diff tab bar (Unstaged / Staged) -->
					<div class="flex border-b border-border shrink-0">
						{#each (['unstaged', 'staged'] as const) as tab}
							<button
								onclick={() => wb.setActiveTab(tab)}
								class="px-3 py-1.5 text-xs font-medium transition-colors
									{wb.activeTab === tab ? 'text-interactive-accent border-b-2 border-interactive-accent' : 'text-muted-foreground hover:text-foreground'}"
							>
								{tab === 'unstaged' ? 'Unstaged' : 'Staged'}
								<span class="ml-1 text-[10px] opacity-70">({tab === 'unstaged' ? wb.unstagedFileCount : wb.stagedFileCount})</span>
							</button>
						{/each}
					</div>
					<GitAllFilesVirtualList
						items={allScopeReviewItems}
						activeTab={wb.activeTab}
						diffMode={wb.diffMode}
						fontSize={diffFontSize}
						selectedLineKeys={wb.selectedLineKeys}
						overscan={5}
						onRequestLoad={handleRequestLoad}
						onToggleLineSelection={(k) => wb.toggleLineSelection(k)}
						onSelectLineRange={(s, e, all) => wb.selectLineRange(s, e, all)}
						onStageHunk={(i) => wb.stageHunk(projectPath, i)}
						onUnstageHunk={(i) => wb.unstageHunk(projectPath, i)}
						onStageLine={(i) => wb.stageLine(projectPath, i)}
						onUnstageLine={(i) => wb.unstageLine(projectPath, i)}
						onAddCommentForFile={handleAddCommentForFile}
						commentsForFile={(fp) => wb.commentsForFile(fp)}
						composerState={wb.commentComposer}
						onComposerBodyChange={(b) => { wb.commentComposer = { ...wb.commentComposer, body: b }; }}
						onComposerSeverityChange={(s) => { wb.commentComposer = { ...wb.commentComposer, severity: s }; }}
						onComposerSubmit={() => wb.commitCommentComposer()}
						onComposerClose={() => wb.closeCommentComposer()}
						onEditComment={(id, patch) => wb.updateDraftComment(id, patch)}
						onRemoveComment={(id) => wb.removeDraftComment(id)}
						scrollToRequest={wb.diffScrollRequest}
						{onOpenInEditor}
					/>
					{#if wb.hasSelection}
						<div class="flex items-center gap-2 px-3 py-2 border-t border-border bg-background shrink-0">
							{#if wb.activeTab === 'unstaged'}
								<button
									onclick={() => wb.stageSelectedLines(projectPath)}
									class="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-git-added/20 text-git-added hover:bg-git-added/30 transition-colors"
								>
									<Plus class="w-4 h-4" />
									Stage {wb.selectedLineKeys.size} {wb.selectedLineKeys.size === 1 ? 'line' : 'lines'}
								</button>
							{:else}
								<button
									onclick={() => wb.unstageSelectedLines(projectPath)}
									class="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-git-deleted/20 text-git-deleted hover:bg-git-deleted/30 transition-colors"
								>
									<Minus class="w-4 h-4" />
									Unstage {wb.selectedLineKeys.size} {wb.selectedLineKeys.size === 1 ? 'line' : 'lines'}
								</button>
							{/if}
							<button
								onclick={() => wb.clearSelection()}
								class="px-3 py-1.5 text-sm rounded-lg bg-muted text-muted-foreground hover:text-foreground transition-colors"
							>
								Clear
							</button>
						</div>
					{/if}
				</div>
			</div>
		{/if}
	</div>

	<!-- Review changes modal -->
	{#if wb.reviewModalOpen}
		<GitReviewChangesModal
			commentsByFile={wb.commentsByFile}
			commentCount={wb.reviewComments.length}
			reviewSummary={wb.reviewSummary}
			{isMobile}
			onSummaryChange={(s) => { wb.reviewSummary = s; }}
			onUpdateComment={(id, patch) => wb.updateDraftComment(id, patch)}
			onRemoveComment={(id) => wb.removeDraftComment(id)}
			onSend={handleFinalizeReview}
			onClose={() => { wb.reviewModalOpen = false; }}
		/>
	{/if}

	<!-- Comment composer: mobile uses full-screen modal; desktop uses inline composer -->
	{#if wb.commentComposer.open && isMobile}
		<GitCommentModal
			composer={wb.commentComposer}
			onBodyChange={(b) => { wb.commentComposer = { ...wb.commentComposer, body: b }; }}
			onSeverityChange={(s) => { wb.commentComposer = { ...wb.commentComposer, severity: s }; }}
			onSubmit={() => wb.commitCommentComposer()}
			onClose={() => wb.closeCommentComposer()}
		/>
	{/if}
{/if}
