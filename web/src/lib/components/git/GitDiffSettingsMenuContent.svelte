<script lang="ts">
	import { fontSizeLabel, typographySizeLabel } from '$lib/components/shared/typography-labels.js';
	import {
		DropdownMenuLabel,
		DropdownMenuRadioGroup,
		DropdownMenuRadioItem,
		DropdownMenuSub,
		DropdownMenuSubContent,
		DropdownMenuSubTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import type { DiffMode } from '$lib/git/workbench/git-workbench-types.js';
	import {
		TYPOGRAPHY_SIZE_OPTIONS,
		parseFontSizePreference,
		type FontSizePreference,
	} from '$lib/theme/typography.js';
	import * as m from '$lib/paraglide/messages.js';
	import { MediaQuery } from 'svelte/reactivity';

	let {
		diffMode,
		contextLines,
		diffFontSize,
		onSetDiffMode,
		onSetContextLines,
		onSetDiffFontSize,
	}: {
		diffMode: DiffMode;
		contextLines: number;
		diffFontSize: FontSizePreference;
		onSetDiffMode: (mode: DiffMode) => void;
		onSetContextLines: (lines: number) => boolean | void;
		onSetDiffFontSize: (size: FontSizePreference) => void;
	} = $props();

	const contextOptions = [3, 5, 10, 20] as const;
	const narrow = new MediaQuery('(max-width: 640px)');
	let contextChangeBlocked = $state(false);

	function setDiffMode(value: string): void {
		if (value === 'unified' || value === 'split') onSetDiffMode(value);
	}

	function setContextLines(value: string): void {
		const lines = Number(value);
		if (!contextOptions.includes(lines as (typeof contextOptions)[number])) return;
		contextChangeBlocked = onSetContextLines(lines) === false;
	}
</script>

<DropdownMenuLabel class="text-xs text-muted-foreground">
	{m.git_diff_settings()}
</DropdownMenuLabel>

<DropdownMenuSub>
	<DropdownMenuSubTrigger>
		<span class="flex min-w-0 flex-1 items-center justify-between gap-4">
			<span>{m.git_diff_font_size()}</span>
			<span class="text-xs text-muted-foreground"
				>{typographySizeLabel('code-diff', diffFontSize)}</span
			>
		</span>
	</DropdownMenuSubTrigger>
	<DropdownMenuSubContent
		class="w-max min-w-36 max-w-[calc(100vw-2rem)]"
		side={narrow.current ? 'bottom' : 'right'}
		align="end"
	>
		<DropdownMenuRadioGroup
			value={diffFontSize}
			onValueChange={(value) => onSetDiffFontSize(parseFontSizePreference(value))}
		>
			{#each TYPOGRAPHY_SIZE_OPTIONS as size (size)}
				<DropdownMenuRadioItem value={size} closeOnSelect={false}>
					{fontSizeLabel(size, 'code-diff')}
				</DropdownMenuRadioItem>
			{/each}
		</DropdownMenuRadioGroup>
	</DropdownMenuSubContent>
</DropdownMenuSub>

<DropdownMenuSub>
	<DropdownMenuSubTrigger>
		<span class="flex min-w-0 flex-1 items-center justify-between gap-4">
			<span>{m.git_diff_mode()}</span>
			<span class="text-xs text-muted-foreground">
				{diffMode === 'unified' ? m.git_diff_unified() : m.git_diff_split()}
			</span>
		</span>
	</DropdownMenuSubTrigger>
	<DropdownMenuSubContent class="w-36">
		<DropdownMenuRadioGroup value={diffMode} onValueChange={setDiffMode}>
			<DropdownMenuRadioItem value="unified" closeOnSelect={false}
				>{m.git_diff_unified()}</DropdownMenuRadioItem
			>
			<DropdownMenuRadioItem value="split" closeOnSelect={false}
				>{m.git_diff_split()}</DropdownMenuRadioItem
			>
		</DropdownMenuRadioGroup>
	</DropdownMenuSubContent>
</DropdownMenuSub>

<DropdownMenuSub>
	<DropdownMenuSubTrigger>
		<span class="flex min-w-0 flex-1 items-center justify-between gap-4">
			<span>{m.git_diff_context_lines()}</span>
			<span class="text-xs text-muted-foreground">{contextLines}</span>
		</span>
	</DropdownMenuSubTrigger>
	<DropdownMenuSubContent class="w-40">
		<DropdownMenuRadioGroup bind:value={() => String(contextLines), setContextLines}>
			{#each contextOptions as lines (lines)}
				<DropdownMenuRadioItem value={String(lines)} closeOnSelect={false}>
					{m.git_diff_lines({ count: lines })}
				</DropdownMenuRadioItem>
			{/each}
		</DropdownMenuRadioGroup>
		{#if contextChangeBlocked}
			<DropdownMenuLabel class="max-w-56 whitespace-normal text-xs text-destructive" role="status">
				{m.git_comment_finish_before_context_change()}
			</DropdownMenuLabel>
		{/if}
	</DropdownMenuSubContent>
</DropdownMenuSub>
