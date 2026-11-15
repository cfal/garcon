<script lang="ts">
	import GitBranch from '@lucide/svelte/icons/git-branch';
	import CirclePlay from '@lucide/svelte/icons/circle-play';
	import Mail from '@lucide/svelte/icons/mail';
	import * as m from '$lib/paraglide/messages.js';
	import type { SidebarVirtualChatRow } from '$lib/sidebar/display/sidebar-virtual-chat-list';
	let {
		branch,
		contextOnly = false,
	}: { branch?: SidebarVirtualChatRow['branch']; contextOnly?: boolean } = $props();
</script>

{#if contextOnly}<span
		class="shrink-0 text-[10px] text-muted-foreground"
		data-sidebar-parent-context>{m.sidebar_parent_context()}</span
	>{/if}
{#if branch}
	<span
		class="inline-flex shrink-0 items-center gap-0.5 text-[10px] tabular-nums text-muted-foreground"
		title={m.sidebar_branch_summary({
			count: branch.descendants,
			unread: branch.unread,
			processing: branch.processing,
		})}
		aria-label={m.sidebar_branch_summary({
			count: branch.descendants,
			unread: branch.unread,
			processing: branch.processing,
		})}
		data-sidebar-branch-summary
	>
		<GitBranch class="size-3" aria-hidden="true" />{branch.descendants}
		{#if branch.processing}<span
				class="ml-1 inline-flex items-center gap-0.5 text-status-processing"
				aria-hidden="true"><CirclePlay class="size-3" />{branch.processing}</span
			>{/if}
		{#if branch.unread}<span
				class="ml-1 inline-flex items-center gap-0.5 font-bold text-foreground"
				aria-hidden="true"><Mail class="size-3" />{branch.unread}</span
			>{/if}
	</span>
{/if}
