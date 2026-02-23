<script lang="ts">
	// Dropdown menu for mentioning project files via "@" in the chat composer.
	// Fetches the file list once on mount, then filters locally by query.

	import { File } from '@lucide/svelte';
	import { getFileList, type FileEntry } from '$lib/api/files.js';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		projectPath: string;
		isVisible: boolean;
		query: string;
		onSelect: (filePath: string) => void;
		onClose: () => void;
		position?: { top: number; left: number };
	}

	let { projectPath, isVisible, query, onSelect, onClose, position }: Props = $props();

	let allFiles = $state<FileEntry[]>([]);
	let selectedIndex = $state(0);
	let listElement: HTMLUListElement | undefined = $state();

	let fetchedForProject = $state('');

	// Defers fetch until the menu becomes visible for the first time.
	// Re-fetches when projectPath changes.
	$effect(() => {
		if (!projectPath || !isVisible) return;
		if (fetchedForProject === projectPath) return;
		fetchedForProject = projectPath;

		const controller = new AbortController();

		getFileList({ projectPath }, { signal: controller.signal })
			.then((files) => {
				if (!controller.signal.aborted) {
					allFiles = files;
				}
			})
			.catch((err) => {
				if (!controller.signal.aborted) {
					console.error('Failed to fetch file list:', err);
				}
			});

		return () => controller.abort();
	});

	// Filters files by query (case-insensitive), capped at 10 results.
	let filteredFiles = $derived.by(() => {
		if (!query) return allFiles.slice(0, 10);

		const lowerQuery = query.toLowerCase();
		const matched: FileEntry[] = [];

		for (const file of allFiles) {
			if (file.path.toLowerCase().includes(lowerQuery) || file.name.toLowerCase().includes(lowerQuery)) {
				matched.push(file);
				if (matched.length >= 10) break;
			}
		}

		return matched;
	});

	// Resets selectedIndex when the filtered results change.
	$effect(() => {
		filteredFiles;
		selectedIndex = 0;
	});

	// Scrolls the highlighted item into view when selectedIndex changes.
	$effect(() => {
		if (!listElement) return;
		const active = listElement.children[selectedIndex] as HTMLElement | undefined;
		active?.scrollIntoView({ block: 'nearest' });
	});

	export function handleKeyDown(event: KeyboardEvent): boolean {
		if (!isVisible || filteredFiles.length === 0) {
			if (event.key === 'Escape' && isVisible) {
				event.preventDefault();
				onClose();
				return true;
			}
			return false;
		}

		if (event.key === 'ArrowDown') {
			event.preventDefault();
			selectedIndex = (selectedIndex + 1) % filteredFiles.length;
			return true;
		}

		if (event.key === 'ArrowUp') {
			event.preventDefault();
			selectedIndex = (selectedIndex - 1 + filteredFiles.length) % filteredFiles.length;
			return true;
		}

		if (event.key === 'Enter' || event.key === 'Tab') {
			event.preventDefault();
			onSelect(filteredFiles[selectedIndex].path);
			return true;
		}

		if (event.key === 'Escape') {
			event.preventDefault();
			onClose();
			return true;
		}

		return false;
	}
</script>

{#if isVisible}
	<div
		class="absolute z-50 w-80 rounded-md border border-border bg-popover shadow-md"
		style:top={position ? `${position.top}px` : undefined}
		style:left={position ? `${position.left}px` : undefined}
	>
		<ul
			bind:this={listElement}
			class="max-h-[200px] overflow-y-auto py-1"
			role="listbox"
		>
			{#if filteredFiles.length === 0}
				<li class="px-3 py-2 text-sm text-muted-foreground">
					{m.chat_file_mention_no_matching()}
				</li>
			{:else}
				{#each filteredFiles as file, i (file.path)}
					<li role="option" aria-selected={i === selectedIndex}>
						<button
							type="button"
							class="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-foreground transition-colors
								{i === selectedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/50'}"
							onmouseenter={() => { selectedIndex = i; }}
							onclick={() => onSelect(file.path)}
						>
							<File class="h-4 w-4 flex-shrink-0 text-muted-foreground" />
							<span class="truncate">{file.path}</span>
						</button>
					</li>
				{/each}
			{/if}
		</ul>
	</div>
{/if}
