<script module lang="ts">
	let nextRevisionInputId = 0;

	function createRevisionInputListboxId(): string {
		nextRevisionInputId += 1;
		return `git-revision-listbox-${nextRevisionInputId}`;
	}
</script>

<script lang="ts">
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import type { GitRefKind, GitRefOption } from '$lib/api/git.js';
	import * as m from '$lib/paraglide/messages.js';

	interface GitRevisionInputProps {
		inputId: string;
		value: string;
		refs: GitRefOption[];
		isLoading: boolean;
		ariaLabel: string;
		placeholder: string;
		invalid?: boolean;
		describedBy?: string;
		onValueChange: (value: string) => void;
		onSearchRefs: (query: string) => void;
	}

	let {
		inputId,
		value,
		refs,
		isLoading,
		ariaLabel,
		placeholder,
		invalid = false,
		describedBy,
		onValueChange,
		onSearchRefs,
	}: GitRevisionInputProps = $props();

	const listboxId = createRevisionInputListboxId();
	let isOpen = $state(false);
	let activeIndex = $state(-1);
	let closeTimeout = $state<ReturnType<typeof setTimeout> | null>(null);
	let searchTimeout: ReturnType<typeof setTimeout> | null = null;
	let orderedRefs = $derived.by(() =>
		[...refs]
			.sort((left, right) => {
				const kindOrder = refKindRank(left.kind) - refKindRank(right.kind);
				if (kindOrder !== 0) return kindOrder;
				if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1;
				return left.name.localeCompare(right.name);
			})
			.slice(0, 50),
	);
	let activeOptionId = $derived(
		isOpen && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined,
	);

	$effect(() => {
		return () => {
			if (closeTimeout) clearTimeout(closeTimeout);
			if (searchTimeout) clearTimeout(searchTimeout);
		};
	});

	function refKindRank(kind: GitRefKind): number {
		if (kind === 'local-branch') return 0;
		if (kind === 'remote-branch') return 1;
		if (kind === 'tag') return 2;
		return 3;
	}

	function refKindLabel(kind: GitRefKind): string {
		if (kind === 'local-branch') return m.git_ref_kind_local_branch();
		if (kind === 'remote-branch') return m.git_ref_kind_remote_branch();
		if (kind === 'tag') return m.git_ref_kind_tag();
		return m.git_ref_kind_other();
	}

	function selectRef(ref: GitRefOption): void {
		if (searchTimeout) clearTimeout(searchTimeout);
		searchTimeout = null;
		onValueChange(ref.name);
		isOpen = false;
		activeIndex = -1;
	}

	function scheduleSearch(query: string): void {
		if (searchTimeout) clearTimeout(searchTimeout);
		searchTimeout = setTimeout(() => {
			searchTimeout = null;
			onSearchRefs(query);
		}, 200);
	}

	function moveActive(delta: number): void {
		if (orderedRefs.length === 0) return;
		isOpen = true;
		activeIndex = activeIndex < 0
			? delta > 0 ? 0 : orderedRefs.length - 1
			: (activeIndex + delta + orderedRefs.length) % orderedRefs.length;
		queueMicrotask(() => {
			document.getElementById(`${listboxId}-option-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
		});
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			moveActive(event.key === 'ArrowDown' ? 1 : -1);
			return;
		}
		if (event.key === 'Enter' && isOpen && activeIndex >= 0) {
			const ref = orderedRefs[activeIndex];
			if (!ref) return;
			event.preventDefault();
			selectRef(ref);
			return;
		}
		if (event.key === 'Escape' && isOpen) {
			event.preventDefault();
			isOpen = false;
			activeIndex = -1;
		}
	}

	function scheduleClose(): void {
		if (closeTimeout) clearTimeout(closeTimeout);
		closeTimeout = setTimeout(() => {
			closeTimeout = null;
			isOpen = false;
			activeIndex = -1;
		}, 0);
	}
</script>

<div class="relative min-w-0 flex-1">
	<input
		id={inputId}
		type="text"
		class="w-full rounded border border-border bg-background px-3 py-2 text-base text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent sm:pointer-fine:text-sm"
		{value}
		{placeholder}
		aria-label={ariaLabel}
		aria-invalid={invalid}
		aria-describedby={describedBy}
		role="combobox"
		aria-autocomplete="list"
		aria-controls={listboxId}
		aria-expanded={isOpen}
		aria-activedescendant={activeOptionId}
		onfocus={() => {
			if (closeTimeout) clearTimeout(closeTimeout);
			isOpen = true;
		}}
		onblur={scheduleClose}
		oninput={(event) => {
			const nextValue = event.currentTarget.value;
			onValueChange(nextValue);
			scheduleSearch(nextValue);
			activeIndex = -1;
			isOpen = true;
		}}
		onkeydown={handleKeydown}
	/>
	{#if isOpen}
		<div id={listboxId} role="listbox" aria-label={m.git_branch_selector_refs_label()} class="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded border border-border bg-popover py-1 shadow-lg">
			{#if orderedRefs.length > 0}
				{#each orderedRefs as ref, index (ref.ref)}
					<button
						id={`${listboxId}-option-${index}`}
						type="button"
						role="option"
						aria-selected={index === activeIndex}
						class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent focus-visible:outline-none {index === activeIndex ? 'bg-accent' : ''}"
						onpointerdown={(event) => event.preventDefault()}
						onclick={() => selectRef(ref)}
					>
						<span class="min-w-0 flex-1 truncate text-foreground">{ref.name}</span>
						<span class="shrink-0 text-xs text-muted-foreground">{refKindLabel(ref.kind)}</span>
					</button>
				{/each}
			{:else if isLoading}
				<div class="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground"><LoaderCircle class="h-3.5 w-3.5 animate-spin" /> {m.git_compare_loading_refs()}</div>
			{:else}
				<div class="px-3 py-2 text-xs text-muted-foreground">{m.git_branch_selector_no_refs_found()}</div>
			{/if}
		</div>
	{/if}
</div>
