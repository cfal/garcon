<script lang="ts">
	// Renders a single changed file row with status badge, checkbox, inline
	// diff display, and discard/delete action buttons.

	import * as m from '$lib/paraglide/messages.js';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import type { ConfirmAction } from '$lib/api/git';

	interface GitFileItemProps {
		filePath: string;
		status: string;
		isExpanded: boolean;
		isSelected: boolean;
		diff: string | undefined;
		isMobile: boolean;
		wrapText: boolean;
		onToggleExpanded: (path: string) => void;
		onToggleSelected: (path: string) => void;
		onFileOpen: (path: string) => void;
		onWrapTextChange: (wrap: boolean) => void;
		onConfirmAction: (action: ConfirmAction | null) => void;
		getStatusLabel: (status: string) => string;
	}

	let {
		filePath,
		status,
		isExpanded,
		isSelected,
		diff,
		isMobile,
		wrapText,
		onToggleExpanded,
		onToggleSelected,
		onFileOpen,
		onWrapTextChange,
		onConfirmAction,
		getStatusLabel
	}: GitFileItemProps = $props();

	const statusClasses: Record<string, string> = {
		M: 'bg-diff-modified text-diff-modified-foreground border-diff-modified-border',
		A: 'bg-status-success text-status-success-foreground border-status-success-border',
		D: 'bg-status-error text-status-error-foreground border-status-error-border'
	};
	const defaultStatusClass =
		'bg-status-neutral text-status-neutral-foreground border-status-neutral-border';

	let cls = $derived(statusClasses[status] || defaultStatusClass);
</script>

<div class="border-b border-border last:border-0">
	<!-- File row -->
	<div class="flex items-center hover:bg-accent/50 {isMobile ? 'px-2 py-1.5' : 'px-3 py-2'}">
		<input
			type="checkbox"
			checked={isSelected}
			onchange={() => onToggleSelected(filePath)}
			onclick={(e) => e.stopPropagation()}
			class="rounded border-border text-interactive-accent focus:ring-interactive-accent dark:bg-muted dark:checked:bg-interactive-accent {isMobile ? 'mr-1.5' : 'mr-2'}"
		/>
		<div class="flex items-center flex-1">
			<button
				class="p-0.5 hover:bg-accent rounded cursor-pointer {isMobile ? 'mr-1' : 'mr-2'}"
				onclick={(e) => { e.stopPropagation(); onToggleExpanded(filePath); }}
			>
				<ChevronRight class="w-3 h-3 transition-transform duration-200 {isExpanded ? 'rotate-90' : 'rotate-0'}" />
			</button>
			<button
				class="flex-1 truncate text-left {isMobile ? 'text-xs' : 'text-sm'} cursor-pointer hover:text-interactive-accent hover:underline"
				onclick={(e) => { e.stopPropagation(); onFileOpen(filePath); }}
				title={m.git_file_item_open_file()}
			>
				{filePath}
			</button>
			<div class="flex items-center gap-1">
				{#if status === 'M' || status === 'D'}
					<button
						onclick={(e) => {
							e.stopPropagation();
							onConfirmAction({ type: 'discard', file: filePath, message: `Discard all changes to "${filePath}"? This action cannot be undone.` });
						}}
						class="{isMobile ? 'px-2 py-1 text-xs' : 'p-1'} hover:bg-status-error rounded text-status-error-foreground font-medium flex items-center gap-1"
						title={m.git_file_item_discard_changes()}
					>
						<Trash2 class="w-3 h-3" />
						{#if isMobile}<span>{m.git_file_item_discard()}</span>{/if}
					</button>
				{/if}
				{#if status === 'U'}
					<button
						onclick={(e) => {
							e.stopPropagation();
							onConfirmAction({ type: 'delete', file: filePath, message: `Delete untracked file "${filePath}"? This action cannot be undone.` });
						}}
						class="{isMobile ? 'px-2 py-1 text-xs' : 'p-1'} hover:bg-status-error rounded text-status-error-foreground font-medium flex items-center gap-1"
						title={m.git_file_item_delete_untracked()}
					>
						<Trash2 class="w-3 h-3" />
						{#if isMobile}<span>{m.git_file_item_delete()}</span>{/if}
					</button>
				{/if}
				<span
					class="inline-flex items-center justify-center w-5 h-5 rounded text-xs font-bold border {cls}"
					title={getStatusLabel(status)}
				>{status}</span>
			</div>
		</div>
	</div>

	<!-- Expandable diff panel -->
	<div
		class="bg-muted/50 transition-all duration-300 ease-in-out overflow-hidden {isExpanded && diff ? 'max-h-[600px] opacity-100' : 'max-h-0 opacity-0'}"
	>
		<div class="flex items-center justify-between p-2 border-b border-border">
			<div class="flex items-center gap-2">
				<span class="inline-flex items-center justify-center w-5 h-5 rounded text-xs font-bold border {cls}">{status}</span>
				<span class="text-sm font-medium">{getStatusLabel(status)}</span>
			</div>
			{#if isMobile}
				<button
					onclick={(e) => { e.stopPropagation(); onWrapTextChange(!wrapText); }}
					class="text-xs text-muted-foreground hover:text-foreground"
					title={wrapText ? m.git_file_item_horizontal_scroll() : m.git_file_item_text_wrap()}
				>{wrapText ? m.git_file_item_scroll() : m.git_file_item_wrap()}</button>
			{/if}
		</div>
		<div class="max-h-96 overflow-y-auto">
			{#if diff}
				<pre class="text-xs font-mono p-2 {wrapText ? 'whitespace-pre-wrap' : 'whitespace-pre overflow-x-auto'}">{@html formatDiff(diff)}</pre>
			{/if}
		</div>
	</div>
</div>

<script lang="ts" module>
	// Formats unified diff text with color-coded lines for display.
	export function formatDiff(raw: string): string {
		return raw
			.split('\n')
			.map((line) => {
				const escaped = line
					.replace(/&/g, '&amp;')
					.replace(/</g, '&lt;')
					.replace(/>/g, '&gt;');
				if (line.startsWith('+')) {
					return `<span class="text-diff-addition">${escaped}</span>`;
				}
				if (line.startsWith('-')) {
					return `<span class="text-diff-deletion">${escaped}</span>`;
				}
				if (line.startsWith('@@')) {
					return `<span class="text-diff-hunk">${escaped}</span>`;
				}
				return escaped;
			})
			.join('\n');
	}
</script>
