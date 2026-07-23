<script lang="ts">
	import ArrowLeftRight from '@lucide/svelte/icons/arrow-left-right';
	import GitCompareArrows from '@lucide/svelte/icons/git-compare-arrows';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import X from '@lucide/svelte/icons/x';
	import * as Dialog from '$lib/components/ui/dialog';
	import type { GitRefOption } from '$lib/api/git.js';
	import type { GitComparisonController } from '$lib/git/review/git-comparison.svelte.js';
	import * as m from '$lib/paraglide/messages.js';
	import GitRevisionInput from './GitRevisionInput.svelte';

	interface GitComparisonDialogProps {
		comparison: GitComparisonController;
		refs: GitRefOption[];
		isLoadingRefs: boolean;
		onSearchRefs: (query: string) => void;
		onCompare: () => void;
		onClose: () => void;
	}

	let {
		comparison,
		refs,
		isLoadingRefs,
		onSearchRefs,
		onCompare,
		onClose,
	}: GitComparisonDialogProps = $props();
	let canCompare = $derived(
		comparison.fromRevision.trim().length > 0 &&
			(comparison.toKind === 'working-tree' || comparison.toRevision.trim().length > 0) &&
			!comparison.isLoading,
	);
</script>

<Dialog.Root
	open={true}
	onOpenChange={(open) => {
		if (!open) onClose();
	}}
>
	<Dialog.Content
		class="w-[calc(100%-2rem)] max-w-xl rounded-lg border border-border bg-popover p-0 shadow-2xl"
		showCloseButton={false}
		aria-label={m.git_compare_title()}
	>
		<div class="flex items-center gap-3 border-b border-border px-4 py-3">
			<GitCompareArrows class="h-4 w-4 text-muted-foreground" />
			<h2 class="flex-1 text-sm font-semibold text-foreground">{m.git_compare_title()}</h2>
			<button
				type="button"
				class="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
				aria-label={m.git_confirm_cancel()}
				onclick={onClose}><X class="h-4 w-4" /></button
			>
		</div>
		<form
			id="git-comparison-form"
			class="space-y-4 px-4 py-4"
			onsubmit={(event) => {
				event.preventDefault();
				if (canCompare) onCompare();
			}}
		>
			<div class="space-y-1.5">
				<label for="git-comparison-from" class="block text-xs font-medium text-muted-foreground"
					>{m.git_compare_from()}</label
				>
				<GitRevisionInput
					inputId="git-comparison-from"
					value={comparison.fromRevision}
					{refs}
					isLoading={isLoadingRefs}
					ariaLabel={m.git_compare_from()}
					placeholder={m.git_compare_revision_placeholder()}
					invalid={comparison.errorEndpoint === 'from'}
					describedBy={comparison.errorEndpoint === 'from'
						? 'git-comparison-from-error'
						: undefined}
					onValueChange={(value) => (comparison.fromRevision = value)}
					{onSearchRefs}
				/>
				{#if comparison.errorEndpoint === 'from'}<span
						id="git-comparison-from-error"
						class="block text-xs text-status-error-foreground"
						role="alert">{comparison.error}</span
					>{/if}
			</div>

			<div class="space-y-1.5">
				<span class="text-xs font-medium text-muted-foreground">{m.git_compare_to()}</span>
				<div
					class="inline-flex rounded border border-border bg-muted/30 p-0.5"
					aria-label={m.git_compare_target()}
				>
					<button
						type="button"
						class="rounded px-3 py-1.5 text-xs font-medium {comparison.toKind === 'revision'
							? 'bg-background text-foreground shadow-sm'
							: 'text-muted-foreground'}"
						aria-pressed={comparison.toKind === 'revision'}
						onclick={() => comparison.setToKind('revision')}>{m.git_compare_revision()}</button
					>
					<button
						type="button"
						class="rounded px-3 py-1.5 text-xs font-medium {comparison.toKind === 'working-tree'
							? 'bg-background text-foreground shadow-sm'
							: 'text-muted-foreground'}"
						aria-pressed={comparison.toKind === 'working-tree'}
						onclick={() => comparison.setToKind('working-tree')}
						>{m.git_compare_working_tree()}</button
					>
				</div>
				{#if comparison.toKind === 'revision'}
					<div class="flex items-center gap-2">
						<GitRevisionInput
							inputId="git-comparison-to"
							value={comparison.toRevision}
							{refs}
							isLoading={isLoadingRefs}
							ariaLabel={m.git_compare_to()}
							placeholder={m.git_compare_revision_placeholder()}
							invalid={comparison.errorEndpoint === 'to'}
							describedBy={comparison.errorEndpoint === 'to'
								? 'git-comparison-to-error'
								: undefined}
							onValueChange={(value) => (comparison.toRevision = value)}
							{onSearchRefs}
						/>
						<button
							type="button"
							class="rounded border border-border p-2 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
							title={m.git_compare_swap_revisions()}
							aria-label={m.git_compare_swap_revisions()}
							onclick={() => comparison.swapRevisions()}><ArrowLeftRight class="h-4 w-4" /></button
						>
					</div>
					{#if comparison.errorEndpoint === 'to'}<span
							id="git-comparison-to-error"
							class="block text-xs text-status-error-foreground"
							role="alert">{comparison.error}</span
						>{/if}
				{:else}
					<div class="rounded border border-border bg-background px-3 py-2 text-sm text-foreground">
						{m.git_compare_working_tree()}
						<span class="text-xs text-muted-foreground">{m.git_compare_working_tree_scope()}</span>
					</div>
					<p class="text-xs text-muted-foreground">
						{m.git_compare_common_ancestor_requires_revisions()}
					</p>
				{/if}
			</div>

			{#if comparison.toKind === 'revision'}
				<div class="space-y-1.5">
					<span class="text-xs font-medium text-muted-foreground">{m.git_compare_mode()}</span>
					<div class="inline-flex rounded border border-border bg-muted/30 p-0.5">
						<button
							type="button"
							class="rounded px-3 py-1.5 text-xs font-medium {comparison.mode === 'direct'
								? 'bg-background text-foreground shadow-sm'
								: 'text-muted-foreground'}"
							aria-pressed={comparison.mode === 'direct'}
							onclick={() => (comparison.mode = 'direct')}>{m.git_compare_direct()}</button
						>
						<button
							type="button"
							class="rounded px-3 py-1.5 text-xs font-medium {comparison.mode === 'merge-base'
								? 'bg-background text-foreground shadow-sm'
								: 'text-muted-foreground'}"
							aria-pressed={comparison.mode === 'merge-base'}
							onclick={() => (comparison.mode = 'merge-base')}
							>{m.git_compare_since_common_ancestor()}</button
						>
					</div>
				</div>
			{/if}

			{#if comparison.error && !comparison.errorEndpoint}
				<div
					class="flex items-center gap-2 rounded border border-status-error-border bg-status-error/10 px-3 py-2 text-xs text-status-error-foreground"
					role="alert"
				>
					<span class="min-w-0 flex-1">{comparison.error}</span>
					{#if comparison.errorStatus === 'no-merge-base'}<button
							type="button"
							class="shrink-0 rounded border border-status-error-border px-2 py-1 font-medium hover:bg-status-error/10"
							onclick={() => {
								comparison.mode = 'direct';
								onCompare();
							}}>{m.git_compare_use_direct()}</button
						>{/if}
				</div>
			{/if}
		</form>
		<div class="flex justify-end gap-2 border-t border-border px-4 py-3">
			<button
				type="button"
				class="rounded bg-muted px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
				onclick={onClose}>{m.git_confirm_cancel()}</button
			>
			<button
				type="submit"
				form="git-comparison-form"
				class="inline-flex min-w-24 items-center justify-center gap-1.5 rounded bg-interactive-accent px-4 py-1.5 text-sm font-medium text-interactive-accent-foreground hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
				disabled={!canCompare}
			>
				{#if comparison.isLoading}<LoaderCircle class="h-3.5 w-3.5 animate-spin" />{/if}
				{m.git_compare_action()}
			</button>
		</div>
	</Dialog.Content>
</Dialog.Root>
