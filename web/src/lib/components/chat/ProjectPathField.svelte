<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLInputAttributes } from 'svelte/elements';
	import Check from '@lucide/svelte/icons/check';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import X from '@lucide/svelte/icons/x';
	import DirectoryBrowser from './DirectoryBrowser.svelte';
	import ProjectPinnedPathToggleButton from './ProjectPinnedPathToggleButton.svelte';
	import { cn } from '$lib/utils/cn.js';
	import * as m from '$lib/paraglide/messages.js';

	interface Props extends Omit<HTMLInputAttributes, 'type' | 'value'> {
		value?: string;
		ref?: HTMLInputElement | null;
		validationStatus?: 'idle' | 'checking' | 'valid' | 'invalid';
		validationError?: string | null;
		pin?: {
			isPinned: boolean;
			loading: boolean;
			disabled: boolean;
			onToggle: () => void | Promise<void>;
		};
		browser: {
			open: boolean;
			executorId: string;
			executorContextKey: string;
			currentPath: string;
			basePath: string;
			isMobile: boolean;
			onSelect: (path: string) => void;
			onClose: () => void;
			button?: { label: string; disabled: boolean; onclick: () => void };
		};
		feedback?: {
			id?: string;
			class?: string;
			error?: string | null;
			worktree?: { disabled: boolean; onOpen: () => void };
		};
		leading?: Snippet;
		children?: Snippet;
	}

	let {
		value = $bindable(''),
		ref = $bindable(null),
		validationStatus = 'idle',
		validationError,
		pin,
		browser,
		feedback,
		leading,
		children,
		class: inputClass,
		...inputProps
	}: Props = $props();

	const hasPath = $derived(value.trim().length > 0);
	const validationTitle = $derived(
		hasPath && validationStatus === 'invalid'
			? validationError || m.chat_new_chat_errors_invalid_directory()
			: undefined,
	);
</script>

<div class="relative min-w-0" data-slot="project-path-field">
	<div class="flex flex-wrap gap-2 @container/project-target">
		{@render leading?.()}
		<div class="relative min-w-0 flex-1">
			<input
				title={validationTitle}
				{...inputProps}
				type="text"
				bind:this={ref}
				bind:value
				class={cn(
					'h-10 w-full min-w-0 rounded-md border border-border bg-background py-2 pl-3 pr-9 text-base text-foreground outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 sm:pointer-fine:text-sm',
					inputClass,
				)}
			/>
			{#if hasPath}
				<div
					class="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2"
					aria-hidden="true"
				>
					{#if validationStatus === 'checking'}
						<Loader2 class="size-4 animate-spin text-muted-foreground" />
					{:else if validationStatus === 'valid'}
						<Check class="size-4 text-status-success-foreground" />
					{:else if validationStatus === 'invalid'}
						<X class="size-4 text-destructive" />
					{/if}
				</div>
			{/if}
		</div>
		{#if pin}
			<ProjectPinnedPathToggleButton
				{...pin}
				class="shrink-0 rounded-md border border-border px-3 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
			/>
		{/if}
		{#if browser.button}
			<button
				type="button"
				disabled={browser.button.disabled}
				onclick={browser.button.onclick}
				title={browser.button.label}
				aria-label={browser.button.label}
				class="inline-flex shrink-0 items-center justify-center rounded-md border border-border px-3 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
			>
				<FolderOpen class="size-4" aria-hidden="true" />
			</button>
		{/if}
		{@render children?.()}
	</div>
	{#if browser.open}
		<DirectoryBrowser
			executorId={browser.executorId}
			executorContextKey={browser.executorContextKey}
			currentPath={browser.currentPath}
			basePath={browser.basePath}
			isMobile={browser.isMobile}
			onSelect={browser.onSelect}
			onClose={browser.onClose}
		/>
	{/if}
</div>
{#if feedback}
	<div id={feedback.id} class={cn('min-h-5', feedback.class)}>
		{#if feedback.error}
			<p class="text-xs text-destructive">{feedback.error}</p>
		{:else if feedback.worktree}
			<button
				type="button"
				disabled={feedback.worktree.disabled}
				onclick={feedback.worktree.onOpen}
				class="flex items-center gap-1.5 text-xs text-interactive-accent transition-colors hover:underline disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:no-underline"
			>
				{m.chat_new_chat_select_different_worktree()}
			</button>
		{/if}
	</div>
{/if}
