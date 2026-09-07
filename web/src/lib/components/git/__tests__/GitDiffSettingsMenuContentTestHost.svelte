<script lang="ts">
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuItem,
		DropdownMenuSeparator,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import type { DiffMode } from '$lib/git/workbench/git-workbench-types.js';
	import GitDiffSettingsMenuContent from '../GitDiffSettingsMenuContent.svelte';

	let {
		onSetDiffMode,
		onSetContextLines,
		onSetDiffFontSize,
	}: {
		onSetDiffMode: (mode: DiffMode) => void;
		onSetContextLines: (lines: number) => boolean | void;
		onSetDiffFontSize: (size: string) => void;
	} = $props();
</script>

<DropdownMenu>
	<DropdownMenuTrigger>Git actions</DropdownMenuTrigger>
	<DropdownMenuContent>
		<GitDiffSettingsMenuContent
			diffMode="unified"
			contextLines={5}
			diffFontSize="13"
			{onSetDiffMode}
			{onSetContextLines}
			{onSetDiffFontSize}
		/>
		<DropdownMenuSeparator />
		<DropdownMenuItem>Edit endpoints</DropdownMenuItem>
	</DropdownMenuContent>
</DropdownMenu>
