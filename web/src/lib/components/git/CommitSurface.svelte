<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import GripHorizontal from '@lucide/svelte/icons/grip-horizontal';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import GitCommitHorizontal from '@lucide/svelte/icons/git-commit-horizontal';
	import type { CommitController } from '$lib/git/commit/commit-controller.svelte.js';
	import * as m from '$lib/paraglide/messages.js';
	import { cn } from '$lib/utils/cn';
	import type { ResponsiveSurfaceAction } from '$lib/components/shared/ResponsiveSurfaceActions.svelte';
	import GitSurfaceToolbar from './GitSurfaceToolbar.svelte';
	import CommitFileTree from './CommitFileTree.svelte';
	import { gitProjectInvalidations } from '$lib/git/surface/git-project-invalidation.svelte.js';
	import type { PaneId } from '$lib/workspace/surface-types.js';

	interface Props {
		controller: CommitController;
		presentation: PaneId | 'mobile';
	}

	let { controller, presentation }: Props = $props();
	const isMobile = $derived(presentation === 'mobile');
	let dialogBodyEl = $state<HTMLDivElement | null>(null);
	let messagePanePercent = $state(28);
	let resizeCleanup: (() => void) | null = null;

	const dialogBodyGridStyle = $derived(
		isMobile
			? 'grid-template-rows: minmax(0, 1fr) auto auto;'
			: `grid-template-rows: minmax(260px, ${100 - messagePanePercent}fr) auto auto minmax(150px, ${messagePanePercent}fr);`,
	);
	const messagePaneStyle = $derived(
		isMobile
			? 'padding: 0.75rem; padding-left: max(0.75rem, env(safe-area-inset-left)); padding-right: max(0.75rem, env(safe-area-inset-right)); padding-bottom: calc(0.75rem + env(safe-area-inset-bottom));'
			: undefined,
	);
	const actionBarClass = $derived(
		cn(isMobile ? 'grid grid-cols-1 gap-2' : 'flex flex-wrap items-center gap-2'),
	);
	const commitButtonClass = $derived(
		cn(
			'inline-flex h-9 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
			isMobile ? 'w-full' : 'flex-1 min-w-[150px]',
			controller.canCommit
				? 'bg-interactive-accent text-interactive-accent-foreground hover:brightness-110'
				: 'bg-muted text-muted-foreground cursor-not-allowed',
		),
	);
	const generateButtonClass = $derived(
		cn(
			'inline-flex h-9 min-w-0 items-center justify-center gap-2 rounded-md border border-border bg-background px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
			isMobile ? 'w-full' : '',
		),
	);
	const toolbarActions = $derived<ResponsiveSurfaceAction[]>([
		{
			id: 'refresh',
			label: m.filetree_refresh_files(),
			icon: RefreshCw,
			iconClass:
				controller.isRefreshingTree || controller.isLoadingTree ? 'animate-spin' : undefined,
			onclick: () => void controller.refreshTree(),
			disabled: controller.isLoadingTree || controller.isRefreshingTree,
			priority: 0,
		},
	]);

	$effect(() => {
		if (!controller.isPresentationVisible) return;
		const key = controller.target.effectiveProjectKey;
		if (!key) return;
		const version = gitProjectInvalidations.version(key);
		untrack(() => void controller.target.refreshForInvalidation(key, version));
	});

	function clampMessagePanePercent(value: number): number {
		return Math.max(18, Math.min(52, value));
	}

	function handlePaneResizeStart(event: PointerEvent): void {
		event.preventDefault();
		const bodyEl = dialogBodyEl;
		if (!bodyEl) return;
		const bounds = bodyEl.getBoundingClientRect();
		if (bounds.height <= 0) return;

		document.body.style.cursor = 'row-resize';
		document.body.style.userSelect = 'none';
		document.body.style.touchAction = 'none';

		function handlePointerMove(moveEvent: PointerEvent): void {
			const nextPercent = ((bounds.bottom - moveEvent.clientY) / bounds.height) * 100;
			messagePanePercent = clampMessagePanePercent(nextPercent);
		}

		function handlePointerUp(): void {
			document.removeEventListener('pointermove', handlePointerMove);
			document.removeEventListener('pointerup', handlePointerUp);
			document.body.style.cursor = '';
			document.body.style.userSelect = '';
			document.body.style.touchAction = '';
			resizeCleanup = null;
		}

		document.addEventListener('pointermove', handlePointerMove);
		document.addEventListener('pointerup', handlePointerUp);
		resizeCleanup = handlePointerUp;
	}

	function cleanupResize(): void {
		resizeCleanup?.();
		resizeCleanup = null;
	}

	onDestroy(() => {
		cleanupResize();
	});
</script>

<div class="flex h-full min-h-0 min-w-0 overflow-hidden bg-background">
	<div class="flex min-h-0 min-w-0 flex-1 flex-col">
		<GitSurfaceToolbar target={controller.target} {presentation} actions={toolbarActions} />

		<div bind:this={dialogBodyEl} class="grid min-h-0 min-w-0 flex-1" style={dialogBodyGridStyle}>
			<section class="min-h-0 min-w-0 overflow-hidden" data-commit-file-tree>
				<CommitFileTree {controller} />
			</section>

			{#if !isMobile}
				<button
					type="button"
					class="group flex h-3 items-center justify-center border-y border-border bg-muted/30 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					onpointerdown={handlePaneResizeStart}
					aria-label={m.git_quick_commit_resize_files_message()}
				>
					<GripHorizontal class="h-3.5 w-3.5" />
				</button>
			{/if}

			<div
				class={cn(
					'flex min-w-0 items-center gap-2 bg-background py-2',
					isMobile ? 'border-y border-border px-3' : 'border-b border-border px-4',
				)}
				data-commit-selection-summary
			>
				<GitCommitHorizontal class="h-4 w-4 shrink-0 text-muted-foreground" />
				<h2 class="min-w-0 truncate text-sm font-medium text-foreground">
					{controller.selectedFileCount === 0
						? m.git_quick_commit_select_files()
						: m.git_changes_commit_files({ count: controller.selectedFileCount })}
				</h2>
				<div class="flex shrink-0 gap-1.5 text-xs tabular-nums">
					{#if controller.totalAdditions > 0}
						<span class="text-git-added">+{controller.totalAdditions}</span>
					{/if}
					{#if controller.totalDeletions > 0}
						<span class="text-git-deleted">-{controller.totalDeletions}</span>
					{/if}
				</div>
			</div>

			<section
				class="flex min-h-0 min-w-0 flex-col {isMobile ? 'gap-2' : 'gap-3 p-4'}"
				style={messagePaneStyle}
				data-commit-message-pane
			>
				<textarea
					data-surface-primary
					value={controller.message}
					oninput={(event) => {
						controller.message = event.currentTarget.value;
					}}
					placeholder={m.git_commit_message_placeholder()}
					rows={isMobile ? 3 : 5}
					class="resize-none rounded-md border border-border bg-muted/30 p-3 text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring {isMobile
						? 'h-20 min-h-20 text-base leading-6'
						: 'min-h-20 flex-1 text-sm'}"></textarea>

				<div class={actionBarClass}>
					<button
						type="button"
						onclick={() => void controller.commit()}
						disabled={!controller.canCommit}
						class={commitButtonClass}
					>
						{#if controller.isCommitting || controller.preparingAction === 'commit'}
							<LoaderCircle class="h-3.5 w-3.5 animate-spin" />
						{/if}
						{controller.preparingAction === 'commit'
							? m.git_quick_commit_preparing_index()
							: m.git_changes_commit()}
					</button>
					<button
						type="button"
						onclick={() => void controller.generateMessage()}
						disabled={controller.desiredSelectedFiles.length === 0 ||
							controller.isGeneratingMessage}
						class={generateButtonClass}
						title={m.git_changes_generate_message()}
					>
						{#if controller.isGeneratingMessage || controller.preparingAction === 'generate'}
							<LoaderCircle class="h-3.5 w-3.5 animate-spin" />
						{:else}
							<Sparkles class="h-3.5 w-3.5" />
						{/if}
						<span class="min-w-0 truncate">
							{controller.preparingAction === 'generate'
								? m.git_quick_commit_preparing_index()
								: m.git_quick_commit_generate()}
						</span>
					</button>
				</div>
			</section>
		</div>
	</div>
</div>
