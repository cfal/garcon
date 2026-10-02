<script lang="ts">
	import {
		DropdownMenuLabel,
		DropdownMenuRadioGroup,
		DropdownMenuRadioItem,
		DropdownMenuSub,
		DropdownMenuSubContent,
		DropdownMenuSubTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import type { DiffMode } from '$lib/git/workbench/git-workbench-types.js';
	import { FONT_SIZE_OPTIONS } from '$lib/utils/font-size.js';
	import * as m from '$lib/paraglide/messages.js';

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
		diffFontSize: string;
		onSetDiffMode: (mode: DiffMode) => void;
		onSetContextLines: (lines: number) => boolean | void;
		onSetDiffFontSize: (size: string) => void;
	} = $props();

	const contextOptions = [3, 5, 10, 20] as const;
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
			<span class="text-xs text-muted-foreground">{diffFontSize}px</span>
		</span>
	</DropdownMenuSubTrigger>
	<DropdownMenuSubContent class="w-36">
		<DropdownMenuRadioGroup value={diffFontSize} onValueChange={onSetDiffFontSize}>
			{#each FONT_SIZE_OPTIONS as size (size)}
				<DropdownMenuRadioItem value={size} closeOnSelect={false}>
					{size}px
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
			<DropdownMenuRadioItem value="unified" closeOnSelect={false}>{m.git_diff_unified()}</DropdownMenuRadioItem>
			<DropdownMenuRadioItem value="split" closeOnSelect={false}>{m.git_diff_split()}</DropdownMenuRadioItem>
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
