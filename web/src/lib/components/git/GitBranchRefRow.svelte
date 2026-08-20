<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import type { GitRefKind, GitRefOption } from '$lib/api/git.js';
	import * as m from '$lib/paraglide/messages.js';
	import { cn } from '$lib/utils/cn.js';
	import { canonicalIsoTimestamp } from '$lib/utils/iso-timestamp.js';
	import { formatRelativeTimestamp } from '$lib/utils/relative-timestamp.js';

	interface Props {
		ref: GitRefOption;
		currentRef: string;
		currentTime: Date;
		rowHeight: number;
		offset: number;
		onSelect: (ref: GitRefOption) => void;
	}

	let { ref, currentRef, currentTime, rowHeight, offset, onSelect }: Props = $props();

	let isCurrent = $derived(
		ref.isCurrent === true || ref.name === currentRef || ref.ref === currentRef,
	);
	let updatedAt = $derived(canonicalIsoTimestamp(ref.updatedAt));
	let updated = $derived(formatRelativeTimestamp(updatedAt, currentTime));
	let optionClass = $derived(
		cn(
			'absolute left-0 right-0 top-0 grid w-full grid-cols-[1rem_minmax(0,1fr)_5rem_4.5rem] items-center gap-2 px-3 text-left text-sm hover:bg-accent',
			isCurrent ? 'bg-accent/50 font-medium' : 'text-muted-foreground',
		),
	);

	function refKindLabel(kind: GitRefKind): string {
		if (kind === 'local-branch') return m.git_ref_kind_local_branch();
		if (kind === 'remote-branch') return m.git_ref_kind_remote_branch();
		if (kind === 'tag') return m.git_ref_kind_tag();
		return m.git_ref_kind_other();
	}
</script>

<button
	type="button"
	role="option"
	aria-selected={isCurrent}
	class={optionClass}
	style={`height:${rowHeight}px; transform:translateY(${offset}px);`}
	onclick={() => onSelect(ref)}
	data-git-ref-virtual-row={ref.ref}
>
	<span class="-ml-2 flex h-4 w-4 items-center justify-center">
		{#if isCurrent}
			<Check class="h-3.5 w-3.5 text-status-success-foreground" />
		{/if}
	</span>
	<span class="-ml-2 min-w-0 truncate">{ref.name}</span>
	{#if updated}
		<time
			datetime={updatedAt ?? undefined}
			title={updated.tooltip}
			class="truncate text-right text-xs tabular-nums text-muted-foreground"
		>
			{updated.label}
		</time>
	{:else}
		<span
			title={m.git_branch_selector_updated_unavailable()}
			class="text-right text-xs text-muted-foreground"
		>
			<span aria-hidden="true">—</span>
			<span class="sr-only">{m.git_branch_selector_updated_unavailable()}</span>
		</span>
	{/if}
	<span
		class="justify-self-end truncate rounded border border-border px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground"
	>
		{refKindLabel(ref.kind)}
	</span>
</button>
