<script lang="ts">
	// Filesystem browser for selecting a project directory. Fetches directory
	// listings from GET /api/v1/files/browse and displays breadcrumb navigation.

	import { onMount, onDestroy } from 'svelte';
	import { apiFetch } from '$lib/api/client.js';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Folder from '@lucide/svelte/icons/folder';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import * as m from '$lib/paraglide/messages.js';

	interface DirectoryEntry {
		name: string;
		path: string;
		type: string;
	}

	interface DirectoryBrowserProps {
		currentPath: string;
		/** Confines browsing to this subtree. */
		basePath: string;
		onSelect: (path: string) => void;
		onClose: () => void;
		isMobile: boolean;
	}

	let { currentPath, basePath, onSelect, onClose, isMobile }: DirectoryBrowserProps = $props();

	// Clamp starting path to basePath constraint.
	let clampedStart = $derived.by(() => {
		const raw = currentPath.trim() || basePath;
		if (!raw.startsWith(basePath)) return basePath;
		return raw;
	});

	let browsePath = $state('');
	let entries = $state<DirectoryEntry[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let focusIndex = $state(-1);

	// Initialize browsePath from clampedStart
	$effect(() => {
		browsePath = clampedStart;
	});

	// Fetch directory contents whenever browsePath changes.
	$effect(() => {
		const path = browsePath;
		if (!path) return;

		loading = true;
		error = null;

		const controller = new AbortController();

		apiFetch(`/api/v1/files/browse?path=${encodeURIComponent(path)}`, {
			signal: controller.signal
		})
			.then((res) => res.json())
			.then((data) => {
				if (controller.signal.aborted) return;
				if (Array.isArray(data)) {
					entries = data;
				} else {
					entries = [];
					error = 'Unable to list directory';
				}
				loading = false;
				focusIndex = -1;
			})
			.catch((err) => {
				if (controller.signal.aborted) return;
				entries = [];
				error = err.message || 'Failed to browse';
				loading = false;
			});

		return () => controller.abort();
	});

	// Close on Escape key.
	function handleEscape(e: KeyboardEvent) {
		if (e.key === 'Escape') onClose();
	}

	onMount(() => {
		window.addEventListener('keydown', handleEscape);
	});

	onDestroy(() => {
		if (typeof window !== 'undefined') {
			window.removeEventListener('keydown', handleEscape);
		}
	});

	function handleNavigate(navPath: string) {
		if (!navPath.startsWith(basePath) && navPath !== basePath) return;
		browsePath = navPath;
		onSelect(navPath);
	}

	function handleConfirm(selPath: string) {
		onSelect(selPath);
		onClose();
	}

	// Keyboard navigation in the directory list.
	function handleListKeyDown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			focusIndex = Math.min(focusIndex + 1, entries.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			focusIndex = Math.max(focusIndex - 1, 0);
		} else if (e.key === 'Enter' && focusIndex >= 0 && focusIndex < entries.length) {
			e.preventDefault();
			handleNavigate(entries[focusIndex].path);
		}
	}

	// Splits a path into clickable breadcrumb segments, starting no higher
	// than the configured basePath.
	function pathSegments(p: string): { label: string; path: string }[] {
		const suffix = p.startsWith(basePath) ? p.slice(basePath.length) : '';
		const parts = suffix.split('/').filter(Boolean);
		const rootLabel = basePath.split('/').filter(Boolean).pop() || '/';
		const segments = [{ label: rootLabel, path: basePath }];
		let acc = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
		for (const part of parts) {
			acc += '/' + part;
			segments.push({ label: part, path: acc });
		}
		return segments;
	}

	let segments = $derived(pathSegments(browsePath));

	// Whether the current path is at the root constraint.
	let atRoot = $derived(browsePath === basePath);
	let parentPath = $derived(atRoot ? null : browsePath.replace(/\/[^/]+$/, '') || '/');
</script>

{#if isMobile}
	<!-- Fullscreen mobile browser -->
	<div class="fixed inset-0 z-50 flex flex-col bg-background">
		<div
			class="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0"
		>
			<h3 class="text-sm font-medium text-foreground">{m.chat_directory_browser_select_directory()}</h3>
			<button
				type="button"
				onclick={onClose}
				class="text-sm text-muted-foreground hover:text-foreground"
			>
				{m.chat_directory_browser_cancel()}
			</button>
		</div>

		<!-- Breadcrumbs -->
		<div
			class="flex items-center gap-1 text-xs text-muted-foreground overflow-x-auto px-3 py-2 border-b border-border flex-shrink-0"
		>
			{#each segments as seg, i (seg.path)}
				<span class="flex items-center gap-1 whitespace-nowrap">
					{#if i > 0}
						<ChevronRight class="w-3 h-3 flex-shrink-0" />
					{/if}
					<button
						type="button"
						onclick={() => handleNavigate(seg.path)}
						class="hover:text-foreground hover:underline"
					>
						{seg.label}
					</button>
				</span>
			{/each}
		</div>

		<!-- Directory list -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -- listbox div needs focus for arrow key navigation -->
		<div
			class="overflow-y-auto flex-1"
			tabindex="0"
			onkeydown={handleListKeyDown}
			role="listbox"
		>
			{#if loading}
				<div class="flex items-center justify-center py-8">
					<Loader2 class="w-5 h-5 animate-spin text-muted-foreground" />
				</div>
				{:else if error}
					<div
						class="flex items-center gap-2 px-3 py-4 text-sm text-status-error-foreground"
					>
					<CircleAlert class="w-4 h-4 flex-shrink-0" />
					{error}
				</div>
			{:else}
				{#if parentPath !== null}
					<button
						type="button"
						onclick={() => handleNavigate(parentPath)}
						class="flex items-center gap-2 w-full px-3 py-2.5 text-sm hover:bg-muted/50 transition-colors text-muted-foreground"
					>
						<ArrowUp class="w-4 h-4" />
						..
					</button>
				{/if}
				{#each entries as entry, i (entry.path)}
					<button
						type="button"
						onclick={() => handleNavigate(entry.path)}
						class="flex items-center gap-2 w-full px-3 py-2.5 text-sm transition-colors {i ===
						focusIndex
							? 'bg-muted/70 text-foreground'
							: 'hover:bg-muted/50 text-foreground'}"
					>
							<Folder class="w-4 h-4 text-primary flex-shrink-0" />
						<span class="truncate">{entry.name}</span>
					</button>
				{/each}
				{#if entries.length === 0 && atRoot}
					<div class="px-3 py-4 text-sm text-muted-foreground text-center">
						{m.chat_directory_browser_no_subdirectories()}
					</div>
				{/if}
			{/if}
		</div>

			<div class="border-t border-border p-3 flex-shrink-0">
				<button
					type="button"
					onclick={() => handleConfirm(browsePath)}
					class="w-full py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
				>
				{m.chat_directory_browser_select_this()}
			</button>
		</div>
	</div>
{:else}
	<!-- Desktop dropdown browser -->
	<!-- svelte-ignore a11y_no_static_element_interactions -- modal backdrop dismiss pattern -->
	<div class="fixed inset-0 z-20" onclick={onClose} onkeydown={() => {}}></div>
	<div
		class="absolute top-full left-0 right-0 z-30 mt-1 border border-border rounded-lg shadow-lg bg-card flex flex-col max-h-72"
	>
		<!-- Breadcrumbs -->
		<div
			class="flex items-center gap-1 text-xs text-muted-foreground overflow-x-auto px-3 py-2 border-b border-border flex-shrink-0"
		>
			{#each segments as seg, i (seg.path)}
				<span class="flex items-center gap-1 whitespace-nowrap">
					{#if i > 0}
						<ChevronRight class="w-3 h-3 flex-shrink-0" />
					{/if}
					<button
						type="button"
						onclick={() => handleNavigate(seg.path)}
						class="hover:text-foreground hover:underline"
					>
						{seg.label}
					</button>
				</span>
			{/each}
		</div>

		<!-- Directory list -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -- listbox div needs focus for arrow key navigation -->
		<div
			class="overflow-y-auto flex-1"
			tabindex="0"
			onkeydown={handleListKeyDown}
			role="listbox"
		>
			{#if loading}
				<div class="flex items-center justify-center py-8">
					<Loader2 class="w-5 h-5 animate-spin text-muted-foreground" />
				</div>
				{:else if error}
					<div
						class="flex items-center gap-2 px-3 py-4 text-sm text-status-error-foreground"
					>
					<CircleAlert class="w-4 h-4 flex-shrink-0" />
					{error}
				</div>
			{:else}
				{#if parentPath !== null}
					<button
						type="button"
						onclick={() => handleNavigate(parentPath)}
						class="flex items-center gap-2 w-full px-3 py-2.5 text-sm hover:bg-muted/50 transition-colors text-muted-foreground"
					>
						<ArrowUp class="w-4 h-4" />
						..
					</button>
				{/if}
				{#each entries as entry, i (entry.path)}
					<button
						type="button"
						onclick={() => handleNavigate(entry.path)}
						class="flex items-center gap-2 w-full px-3 py-2.5 text-sm transition-colors {i ===
						focusIndex
							? 'bg-muted/70 text-foreground'
							: 'hover:bg-muted/50 text-foreground'}"
					>
							<Folder class="w-4 h-4 text-primary flex-shrink-0" />
						<span class="truncate">{entry.name}</span>
					</button>
				{/each}
				{#if entries.length === 0 && atRoot}
					<div class="px-3 py-4 text-sm text-muted-foreground text-center">
						{m.chat_directory_browser_no_subdirectories()}
					</div>
				{/if}
			{/if}
		</div>
	</div>
{/if}
