<script lang="ts">
	// Diff display settings popup. Uses Popover + Select to match
	// the editor settings pattern.

	import * as Popover from '$lib/components/ui/popover';
	import * as Select from '$lib/components/ui/select';
	import { Button } from '$lib/components/ui/button';
	import { FONT_SIZE_OPTIONS } from '$lib/settings/font-size.js';
	import Settings from '@lucide/svelte/icons/settings';
	import type { DiffMode } from '$lib/stores/git/git-workbench.svelte.js';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		diffMode: DiffMode;
		contextLines: number;
		diffFontSize: string;
		onSetDiffMode: (mode: DiffMode) => void;
		onSetContextLines: (lines: number) => void;
		onSetDiffFontSize: (size: string) => void;
	}

	let {
		diffMode,
		contextLines,
		diffFontSize,
		onSetDiffMode,
		onSetContextLines,
		onSetDiffFontSize,
	}: Props = $props();

	const CONTEXT_OPTIONS = ['3', '5', '10', '20'];
	let popoverOpen = $state(false);
</script>

<Popover.Root bind:open={popoverOpen}>
	<Popover.Trigger>
		<Button
			variant="ghost"
			size="icon-sm"
			aria-label={m.git_diff_settings()}
			title={m.git_diff_settings()}
		>
			<Settings class="w-4 h-4" />
		</Button>
	</Popover.Trigger>

	<Popover.Content class="w-72 p-0" align="end" sideOffset={8}>
		<div class="bg-card text-foreground rounded-md border border-border">
			<div class="flex items-center justify-between px-4 py-2.5">
				<div class="text-sm font-medium text-foreground">Font size</div>
				<Select.Root
					type="single"
					value={diffFontSize}
					onValueChange={(v) => {
						if (v) onSetDiffFontSize(v);
					}}
				>
					<Select.Trigger class="w-[80px]" size="sm">
						{diffFontSize}px
					</Select.Trigger>
					<Select.Content>
						{#each FONT_SIZE_OPTIONS as size (size)}
							<Select.Item value={size} label="{size}px">{size}px</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			</div>

			<div class="flex items-center justify-between px-4 py-2.5">
				<div class="text-sm font-medium text-foreground">Diff mode</div>
				<Select.Root
					type="single"
					value={diffMode}
					onValueChange={(v) => {
						if (v) onSetDiffMode(v as DiffMode);
					}}
				>
					<Select.Trigger class="w-[100px]" size="sm">
						{diffMode === 'unified' ? 'Unified' : 'Split'}
					</Select.Trigger>
					<Select.Content>
						<Select.Item value="unified" label="Unified">Unified</Select.Item>
						<Select.Item value="split" label="Split">Split</Select.Item>
					</Select.Content>
				</Select.Root>
			</div>

			<div class="flex items-center justify-between px-4 py-2.5">
				<div class="text-sm font-medium text-foreground">Context lines</div>
				<Select.Root
					type="single"
					value={String(contextLines)}
					onValueChange={(v) => {
						if (v) onSetContextLines(Number(v));
					}}
				>
					<Select.Trigger class="w-[80px]" size="sm">
						{contextLines} lines
					</Select.Trigger>
					<Select.Content>
						{#each CONTEXT_OPTIONS as n}
							<Select.Item value={n} label="{n} lines">{n} lines</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			</div>
		</div>
	</Popover.Content>
</Popover.Root>
