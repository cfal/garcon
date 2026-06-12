<script lang="ts">
	import Code2 from '@lucide/svelte/icons/code-2';
	import MessageSquare from '@lucide/svelte/icons/message-square';
	import Minus from '@lucide/svelte/icons/minus';
	import Plus from '@lucide/svelte/icons/plus';
	import type { GitDiffTab } from '$lib/api/git.js';
	import type { GitDiffActionTarget } from '$lib/stores/git-workbench.svelte.js';
	import type { GitDiffLineContextTarget } from './git-diff-rows';
	import * as m from '$lib/paraglide/messages.js';

	interface GitDiffLineContextMenuProps {
		activeTab: GitDiffTab;
		actionTarget: GitDiffActionTarget;
		readOnly: boolean;
		onAddComment: (side: 'before' | 'after', line: number) => void;
		onStageHunk: (target: GitDiffActionTarget, hunkIndex: number) => void;
		onUnstageHunk: (target: GitDiffActionTarget, hunkIndex: number) => void;
		onStageLine?: (target: GitDiffActionTarget, diffLineIndex: number) => void;
		onUnstageLine?: (target: GitDiffActionTarget, diffLineIndex: number) => void;
		onOpenInEditor?: (line: number) => void;
	}

	let {
		activeTab,
		actionTarget,
		readOnly,
		onAddComment,
		onStageHunk,
		onUnstageHunk,
		onStageLine,
		onUnstageLine,
		onOpenInEditor,
	}: GitDiffLineContextMenuProps = $props();

	let menu = $state<{
		open: boolean;
		x: number;
		y: number;
		target: GitDiffLineContextTarget | null;
	}>({
		open: false,
		x: 0,
		y: 0,
		target: null,
	});

	export function open(event: MouseEvent, target: GitDiffLineContextTarget | null): void {
		if (!target) return;
		event.preventDefault();
		event.stopPropagation();
		const x = Math.min(event.clientX, window.innerWidth - 180);
		const y = Math.min(event.clientY, window.innerHeight - 220);
		menu = { open: true, x, y, target };
	}

	function close(): void {
		menu = { ...menu, open: false };
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') close();
	}

	$effect(() => {
		if (!menu.open) return;
		window.addEventListener('keydown', handleKeydown);
		return () => window.removeEventListener('keydown', handleKeydown);
	});

	function addComment(): void {
		if (!menu.target) return;
		onAddComment(menu.target.side, menu.target.line);
		close();
	}

	function openInEditor(): void {
		if (!menu.target) return;
		onOpenInEditor?.(menu.target.line);
		close();
	}

	function stageHunk(): void {
		if (!menu.target) return;
		onStageHunk(actionTarget, menu.target.hunkIndex);
		close();
	}

	function unstageHunk(): void {
		if (!menu.target) return;
		onUnstageHunk(actionTarget, menu.target.hunkIndex);
		close();
	}

	function stageLine(): void {
		if (!menu.target) return;
		onStageLine?.(actionTarget, menu.target.diffLineIndex);
		close();
	}

	function unstageLine(): void {
		if (!menu.target) return;
		onUnstageLine?.(actionTarget, menu.target.diffLineIndex);
		close();
	}
</script>

{#if menu.open && menu.target}
	<div
		role="presentation"
		class="fixed inset-0 z-50"
		onclick={close}
		oncontextmenu={(event) => {
			event.preventDefault();
			close();
		}}
	>
		<div
			role="menu"
			tabindex="-1"
			class="fixed z-50 bg-popover border border-border rounded-lg shadow-lg py-1 min-w-[180px] text-xs"
			style="left:{menu.x}px; top:{menu.y}px;"
			onclick={(event) => event.stopPropagation()}
			onkeydown={(event) => event.stopPropagation()}
		>
			<button
				type="button"
				role="menuitem"
				onclick={addComment}
				class="w-full text-left px-3 py-1.5 hover:bg-muted transition-colors flex items-center gap-2"
			>
				<MessageSquare class="w-3 h-3" />
				Add comment
			</button>
			{#if onOpenInEditor}
				<button
					type="button"
					role="menuitem"
					onclick={openInEditor}
					class="w-full text-left px-3 py-1.5 hover:bg-muted transition-colors flex items-center gap-2"
				>
					<Code2 class="w-3 h-3" />
					Open in Editor
				</button>
			{/if}
			{#if !readOnly && menu.target.hunkIndex >= 0}
				{#if activeTab === 'unstaged'}
					<button
						type="button"
						role="menuitem"
						onclick={stageHunk}
						class="w-full text-left px-3 py-1.5 hover:bg-muted transition-colors text-git-added flex items-center gap-2"
					>
						<Plus class="w-3 h-3" />
						{m.git_action_stage_hunk()}
					</button>
				{:else}
					<button
						type="button"
						role="menuitem"
						onclick={unstageHunk}
						class="w-full text-left px-3 py-1.5 hover:bg-muted transition-colors text-git-deleted flex items-center gap-2"
					>
						<Minus class="w-3 h-3" />
						{m.git_action_unstage_hunk()}
					</button>
				{/if}
			{/if}
			{#if !readOnly && onStageLine && (menu.target.rowKind === 'add' || menu.target.rowKind === 'del')}
				{#if activeTab === 'unstaged'}
					<button
						type="button"
						role="menuitem"
						onclick={stageLine}
						class="w-full text-left px-3 py-1.5 hover:bg-muted transition-colors text-git-added flex items-center gap-2"
					>
						<Plus class="w-3 h-3" />
						{m.git_action_stage_line()}
					</button>
				{:else}
					<button
						type="button"
						role="menuitem"
						onclick={unstageLine}
						class="w-full text-left px-3 py-1.5 hover:bg-muted transition-colors text-git-deleted flex items-center gap-2"
					>
						<Minus class="w-3 h-3" />
						{m.git_action_unstage_line()}
					</button>
				{/if}
			{/if}
		</div>
	</div>
{/if}
